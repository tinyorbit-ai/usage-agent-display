# Build log

Part of [[index]]. One entry per phase: the verifiable gate that was met before
merge. Newest on top. Appended by `forge-ship`.

## Phase 5 — Extensibility proof + self-host ops hardening
**Branch:** `phase/5-extensible-and-ops` → squashed to `main` (`561bf2c`)

- **3-year-fit proven:** a new provider slots in through the `Collector` interface with
  **zero aggregation change** — a `buildCollectors` registry (`ProviderSpec`) plus a
  `USAGE_CCUSAGE_CMD` override; tests add `cursor`/`windsurf` providers (one hand-built,
  one through the registry) and assert they reach `by_provider[]` + the combined total.
- **Runs unattended:** an **ops smoke** (`scripts/smoke-ops.ts`, in the gate) starts the
  server and daemon from their *documented commands* (real subprocesses, real bearer
  auth, a stub ccusage) and asserts 777 tokens flow end to end. **launchd** + **systemd**
  units in `deploy/` for server + daemon; README run-unattended + add-a-provider sections.
- **Retention** ([[decisions/0011-retention-policy]]): the server self-prunes snapshots
  not re-posted within `USAGE_RETENTION_DAYS` (default 400), daily — safe because the
  daemon refreshes `received_at` on every active bucket.
- **Review (Codex) fixed 5** (1 high): reject **duplicate provider labels** (they'd
  collide in the dedup key and silently undercount); **fail-fast** retention config (a
  typo no longer silently disables pruning); spaces-safe JSON-argv command override;
  registry-path extensibility test. Lessons in [[learnings]].
- **Gate:** `bun run gate` — 120 unit tests + ops smoke (documented-command startup,
  end-to-end flow) — **green**; typecheck clean.
- **Manual half (pending, non-blocking):** the full system runs unattended across a day
  on real machines; last_sync honest, totals correct — confirmed in operation.

## Phase 4 — Make it live (mission-control feel)
**Branch:** `phase/4-live` → squashed to `main` (`09cfabd`)

- The panel feels alive: a rolling **1h token-burn sparkline** (`sparkline_1h`) and
  `active_machine`. Server records an **append-only sample** of each machine's monotonic
  running total per ingest (`total_samples`, 2h retention); `live.ts` buckets the
  **deltas** between samples into the burn series and sets `active_machine` = the machine
  with the **most recent positive delta** in the window (not the last-synced daemon).
- Firmware: a host-tested **`Ticker`** eases the hero toward the last confirmed total —
  **never above it** — with a downward correction as an **explicit reset**; LVGL
  sparkline chart + active-machine glow; restrained motion budget. Transport stays
  fast-poll + interpolation, not SSE ([[decisions/0010-live-transport]]).
- **Why notable:** "live" is a *feel* delivered by bounded interpolation, never by
  showing un-confirmed numbers; empty buckets are real gaps (0), never phantom burn.
- **Review (Codex) fixed 3** (1 high): made the samples table genuinely append-only
  (autoincrement id, not `(machine,received_at)`+upsert that collapsed same-ms ingests);
  fixed ticker integer-truncation stall (advance ≥1); tightened tests to assert exact
  sparkline bucket indexes + gaps-preserved in the core. Lessons in [[learnings]].
- **Gate:** `bun run gate` — 105 unit tests incl. exact sparkline bucketing (idx 57=200,
  59=50, rest 0), active-machine-not-last-synced, ticker bounds + small-gap convergence
  + sparkline-gap parse (host core) + e2e (60-bucket series present) — **green**.
- **Hardware/visual half (pending, non-blocking):** generate agent activity → the burn
  number animates up, the sparkline scrolls, the active machine glows; downward
  correction resets cleanly — confirmed at the board.

## Phase 3 — Cost as an instrument
**Branch:** `phase/3-cost-instrument` → squashed to `main` (`b015a7a`)

- New `cost` block on the summary: **priced from our own versioned per-model/per-category
  table** (`pricing.ts`) over the granular rows stored since phase 1 — not ccusage's
  number. **EOD/month projection** (`projection.ts`, linear from elapsed fraction in the
  declared TZ, clamped early) and an optional **monthly budget** (`USAGE_BUDGET_USD`) with
  `used_pct` + `over_budget`. Firmware core parses `over_budget` (host-tested); the cost
  tile renders priced/eod/month + budget % and tints red when over.
- **Why notable:** an unknown model is **never priced at $0** — its tokens surface as
  `unpriced_tokens` and the estimate is flagged `partial`, so the panel is honest about
  uncertainty. Pricing is a stamped estimate (`PRICING_VERSION`), not billing truth
  ([[decisions/0009-pricing-source-and-projection]]).
- **Review (Codex) fixed 3** (1 high): replaced loose substring model-matching (which
  mis-priced `local-gpt-proxy`/`opus-compatible-test`) with **anchored** vendor+family
  matching + negative fixtures; documented that projection/budget inherit the
  producer-bucket TZ limit. Lessons in [[learnings]].
- **Gate:** `bun run gate` — 100 unit tests incl. pricing (known + anchored-unknown +
  distinct cache categories), projection math + through-summary, budget used_pct/
  over_budget + firmware over-budget matrix + e2e (cost block present & consistent) —
  **green**. Real ccusage: all 4 distinct models price, 0 unpriced; budget 166% over.
- **Hardware/visual half (pending, non-blocking):** cost tile shows spend + EOD/month
  projection; budget burndown/over-budget renders — confirmed at the board.

## Phase 2 — The full tile layout (metric hierarchy on screen)
**Branch:** `phase/2-tile-hierarchy` → squashed to `main` (`3860ab6`)

- `/usage/summary` **v2** (additive — v1 firmware still reads `totals`): `by_provider[]`,
  `by_machine[]` (with `age_seconds` + `stale`), `session` (active session burn),
  `month` (month-to-date). Server rollup queries collapse token categories and de-dup
  cost per (machine, provider, model, bucket); per-machine freshness drives `stale`
  (`USAGE_STALE_AFTER_SECONDS`); month reckoned in one declared timezone
  (`USAGE_RECKONING_TZ`). Firmware core gained `parseSummary(v2)` + `classifyPanel`
  (empty/live/partial/all-stale/disconnected/connecting); `main.cpp` renders the tile
  hierarchy with a **non-color signal per state** ([[decisions/0008-display-design-system]]).
- **Why notable:** the panel must never claim fresher-than-true, so freshness is an
  explicit numeric age + a `stale` flag, and every state has an icon/word signal (reads
  in a desaturated photo), not color alone. Active session ordered by ccusage
  `lastActivity` (`activity_at`), not arrival time — one poll batches all sessions.
- **Review (Codex) fixed 3** (2 high): active-session tie-break via `activity_at`;
  multi-category replicated-cost dedup fixtures; documented the month-TZ inherent limit.
  Lessons in [[learnings]].
- **Gate:** `bun run gate` — 87 unit tests incl. exact-value v2 fixtures (by_provider/
  by_machine/session/month), stale flagging, cross-TZ month reckoning, single-ingest
  multi-session, multi-category cost-dedup + firmware panel-state matrix + e2e
  (by_machine & by_provider both sum to the hero) — **green**. Real ccusage v2 smoke:
  hero 2.17B, session 151M, month-to-date 351M; 336/336 session rows carry activity_at.
- **Hardware/visual half (pending, non-blocking):** every tile matches `curl`; designed
  empty/live/partial/all-stale states + desaturated-photo legibility — confirmed at the
  board (the bring-up session).

## Phase 1 — Aggregate two machines, show the number on the CYD
**Branch:** `phase/1-aggregate-and-show` → squashed to `main` (`6038248`)

- Monorepo (Bun workspaces): `@usage/shared` (v1 `/usage/summary` wire contract +
  snapshot types), `@usage/server` (Bun+SQLite: `POST /ingest` dedup-upsert, `GET
  /usage/summary` daily-only hero), `@usage/daemon` (ccusage collector seam →
  normalized rows → bearer POST), `firmware/` (ESP32 LVGL; pure host-tested state core).
- **Why the notable shapes:** dedup keyed by (machine,provider,model,token_category,
  report_type,bucket) with **server `received_at` governing** conflicts and the hero
  pinned to the **`daily`** report type — [[decisions/0004-ingest-dedup-model]]. Cost
  replicated per category row, de-duplicated per model/bucket when summing —
  [[decisions/0006-cost-attribution-grain]]. Firmware split into a dependency-free,
  host-compilable core so the fetch/parse/state matrix is tested without a board —
  [[decisions/0007-firmware-host-testable-core]]. Bearer auth on both endpoints
  ([[decisions/0003-daemon-auth-bearer]]); all SQL through one prepared-statement module.
- **Review (Codex adversarial pass) fixed 5 findings**, incl. two high: a destructive
  "floor-to-0" normalize default that would UPSERT-zero the hero (now skips corrupt/
  drifted breakdowns), and making "received_at governs" load-bearing in the upsert.
  Lessons in [[learnings]].
- **Scope deferred:** real Codex data-source wiring (provider seam shipped); gitleaks
  fallback scan until installed — see [[improvements]].
- **Gate:** `bun run gate` — typecheck + no-raw-SQL static check + secrets scan + 73
  unit tests (aggregation, idempotency, cumulative-dedup 100→150=150, canonical-report
  no-inflation, clock-skew, received_at-governs, auth 401s, validation, log-redaction,
  contract) + firmware off-device state matrix (15/15) + e2e (2 machines, dedup,
  daily-only = 1700) — **green**. Cross-checked with real ccusage: 552 rows round-trip
  daemon→server→summary, daily-only hero ≈ 2.15B tokens.
- **Hardware half (pending, non-blocking):** on-device A→B live-update confirmation to
  be recorded here when at the board (per the plan's hardware-gate rule, the software
  gate unblocks the merge).
