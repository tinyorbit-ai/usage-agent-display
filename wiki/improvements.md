# What I'd do with more time

Part of [[index]]. Running, honest list. Deliberate scope cuts go here too —
"deferred X for Y" is a positive signal, not an apology.

## Phase 12

- **The agent control is fixed at ALL + the three branded agents (claude-code / codex /
  gemini).** A future 4th provider would still appear in the **ALL** total and the
  combined `daily` graph (the aggregation stays provider-agnostic), but it would have **no
  chip** of its own and no filtered view — deliberate, consistent with the brief's
  sharper-niche three-year fit. Making the chip row data-driven (one chip per provider seen
  in `by_provider`, dynamically laid out) is the unbounded-providers generalization;
  deferred because four fixed chips fit the ~150px right band cleanly and a dynamic row
  would need scroll/overflow handling this single-purpose panel doesn't earn yet.
- **Resolved (was the P7/P10 debt):** the live `/usage/summary` parse now runs in the
  **bounded host-tested core** (`usage::parsePanel`, `kMaxBodyBytes` + every untrusted
  array clamped to the combined axis), replacing the unbounded `JsonDocument` in `main.cpp`.
  The P10 "size bounded only for the realistic set" note above is now closed on-device:
  a pathological body is rejected/clamped regardless of what the server emits.

## Phase 10

- **`/usage/summary` size is bounded for the *realistic* provider set, not adversarially
  (codex phase-10 review).** `daily_by_provider` is bound to the providers actually present
  and the whole serialized summary measures **2607 B** at a worst-realistic load (4 machines
  × the 3 branded agents × 14 days) — comfortably under the ~6 KB the *currently shipped*
  firmware's unbounded `JsonDocument` parse (`main.cpp:286`) can take. It is **not** bounded
  against a pathological producer that posts dozens of providers or 256-char provider ids:
  the summary as a whole has been provider/machine-unbounded since phases 2/7 (`by_provider`,
  `by_machine`, and each timeframe's `by_provider` all emit every key), so `daily_by_provider`
  only adds a proportional term. We deliberately did **not** cap providers in this field — a
  cap would break the locked gate's *present⇒key* and *Σ-providers === daily* invariants that
  the phase-12 agent filter depends on, and would only bound this one field. The real,
  already-planned fix is **phase 12 moving the live firmware parse onto the bounded
  host-tested core** (the `kMaxBodyBytes` cap), which makes the body untrusted-safe on-device
  regardless of what the server emits. Resolved as "document the actual guarantee" per the
  locked plan's escape valve. Trust boundary: server→firmware (body untrusted) —
  [[decisions/0014-agent-filter-direct-tap]].

## Phase 1

- **✅ RESOLVED (2026-06-06) — Codex (and Gemini) data source now native in ccusage.**
  Was: the provider seam shipped but real Codex usage wasn't collected (ccusage 16.2.4
  exposed no usable Codex flag). As of 2026-06-06, `ccusage monthly --json` tags rows
  with `metadata.agents` and detects **`claude`, `codex`, `gemini`** natively (plus
  opencode/amp/droid/copilot/qwen/kimi via subcommands) — closed at the source with
  **zero core changes**, exactly as the provider-agnostic schema
  ([[decisions/0004-ingest-dedup-model]]) bet. Full writeup:
  [[notes/2026-06-06-ccusage-multi-agent]]. The only remaining piece is *operational* —
  point each daemon's collector at the right ccusage subcommand and tag the provider.
- **gitleaks not installed locally** — `scan:secrets` uses a focused fallback regex scan
  (bearer/WiFi shapes over tracked files) until `brew install gitleaks` makes the full
  default ruleset available. Config (`.gitleaks.toml`) is committed and ready.
- **Daemon retry is "skip until next tick"**, not backoff/queue. Fine for a desk panel
  (next interval re-posts the same cumulative totals; nothing is lost), but a long
  server outage means no catch-up burst — acceptable given idempotent cumulative posts.

## Phase 2

- **Month-to-date timezone is a boundary choice, not a re-bucketing (inherent limit).**
  ccusage groups daily usage by the *producer machine's* local calendar date and gives
  no intra-day timestamps, so the server can't re-bucket a day into a different TZ. The
  declared `USAGE_RECKONING_TZ` governs *which month is "current"* — one consistent
  boundary across all machines — but the daily bucket dates stay producer-local. Near a
  month edge a far-TZ machine's date can differ by a day. Fixing this fully would mean
  collecting raw per-event timestamps (a direct-parse collector, its own ADR) instead of
  ccusage's pre-aggregated daily rows. Deferred — the current behavior is the best
  available from ccusage and is documented at the query (Codex phase-2 review).

## Retro action items (2026-06-06, phases 6–9)

- **Enforce ADR 0007 with a gate check (top priority).** The host-testable firmware core
  regressed in phase 7 (`main.cpp` rewritten standalone, `usage_state.h` now dead) and has
  carried open through 8/9 + two chores. Extract the P7 poll/`fillTf` JSON parse into a
  host-compiled core (as phase 1 did) *and* add a gate tripwire that fails when firmware
  parses JSON outside it — or delete the dead `usage_state.h` if the direction changed.
  An ADR with no automated guard erodes; this is the proof. See [[learnings]].
- **Pin TLS root or embed the CA bundle (security teeth).** Firmware HTTPS currently
  defaults to `setInsecure()` — encrypted but unauthenticated, so a MITM can capture the
  bearer token over the open internet. Pin Cloudflare's root in `config.h` `API_ROOT_CA`
  (ISRG Root X1 / GTS Root R1), or embed the Mozilla CA bundle via `setCACertBundle()`
  (needs a PlatformIO embed step). Already noted under Phase 8; elevated here as the live
  exposure.
- **Open each build by triaging the prior phase's deferred/known-gaps list.** `last_used`
  null, per-tab calibration, and the firmware core all carried forward silently. Make
  keep-deferred-(why) vs do-now an explicit first step of the next build.
- **Features get phases; only true chores skip.** The one-command installer (a real
  166-line distribution feature) landed straight on `main` with no phase/build-log entry.
  Hold the phase line for features post-plan.

## Retro action items (2026-06-06, phases 1–5)

- **~~Confirm the Codex data source~~ — done upstream (2026-06-06); now only the TZ half
  remains.** ccusage went multi-agent ([[notes/2026-06-06-ccusage-multi-agent]]), so the
  data-source half is closed. The direct-parse collector (raw `~/.codex` / `~/.claude`
  per-event timestamps) is now justified **solely** by the producer-bucket TZ limit, not
  by missing Codex data — lower priority than this item originally implied.
- **Hardware/visual gates pending one board bring-up** — live A→B update (P1), tile
  states + desaturated-photo legibility (P2), cost tile (P3), sparkline/glow/ticker (P4),
  unattended full-day run (P5). Batched to the end; board now on USB.

## Phase 8

- **✅ RESOLVED (phase 9) — firmware speaks HTTPS.** `poll()` scheme-detects
  `API_BASE_URL` and uses `WiFiClientSecure` for `https://`. Remaining nicety: TLS
  verification defaults to `setInsecure()` (encrypted but unauthenticated — a MITM could
  capture the bearer token over the open internet). Pin Cloudflare's public root
  (ISRG Root X1 / GTS Root R1) in `config.h` `API_ROOT_CA` to fix (see
  `config.h.example`). Zero-maintenance alternative: embed the Mozilla CA bundle and use
  `setCACertBundle()` — needs a PlatformIO embed step; deferred.
- **The GitHub repo must be pushed (private) for the VM to clone it.** The deploy system
  `repos.json` points at `git@github.com:YOUR_ORG/usage-agent-display.git`; create +
  push it, and ensure the VM's deploy key has read access.
- **Doppler key must be set:** `USAGE_AGENT_BEARER_TOKEN` (the shared secret) and,
  optionally, `USAGE_AGENT_BUDGET_USD`. The daemons get the same token value.
- **ccusage isn't bundled in the daemon binary.** It's spawned, so a target machine needs
  `bunx` (install Bun) or `npx` (`USAGE_CCUSAGE_CMD="npx -y ccusage@20.0.6"`). Bundling
  would need a stable ccusage library API, which it doesn't have ([[decisions/0002-ccusage-invocation]]).
- **Per-app `bun install` in a workspace child.** The deploy system root-installs the monorepo
  (links `@usage/shared`) then per-app installs `packages/server` — fine in practice, but
  if a deploy ever resolves the workspace dep oddly, prefer the root install as source of truth.

## Phase 7

- **Tabs cycle on any tap, not per-tab tapping.** Tap-anywhere → next timeframe via the
  XPT2046 PENIRQ line (GPIO36), which needs no touch-coordinate calibration. Per-tab
  tapping (tap "30D" to jump straight there) needs a touch calibration pass — deferred
  for robustness over polish ([[decisions/0012-panel-visual-system-v2]]).
- **`last_used` is null in practice.** The server field works, but session `activity_at`
  isn't populating from ccusage v20 (session `metadata.lastActivity`), so the footer
  falls back to `active_machine`/blank. Confirm where v20 exposes session activity, or
  derive last-used from the daily series. Same date-granularity caveat would apply.
- **The live firmware fetch/parse is NOT host-tested.** `main.cpp` was rewritten
  standalone for phase 7 and no longer uses `usage_state.h`, so the new poll/`fillTf`
  JSON path has no off-device test — a regression against
  [[decisions/0007-firmware-host-testable-core]]. Extract the parse into a host-compilable
  core (as phase 1 did) or delete the now-unused `usage_state.h`. Highest-value cleanup.
- **Graph is constant across tabs.** The tokens/day-14d bars don't change when you switch
  TODAY/30D/ALL (they're a fixed recent-trend strip). Could make the graph timeframe-aware
  (e.g. hourly for TODAY, monthly for ALL) — deferred; the constant trend reads fine.

## Phase 3

- **Projection & budget inherit the producer-bucket TZ limit.** EOD/month projection and
  the budget's MTD selection pick daily rows by date-bucket prefix in the declared TZ,
  but the buckets are producer-local dates — so near a day/month boundary a far-TZ
  machine's rows may fall on the "wrong" side. Same root cause and same deferral as the
  month-to-date note above (Codex phase-3 review). Fixing needs raw timestamps.
- **The price table is a flat current-rate estimate, not historical.** All-time
  `priced_usd` values every stored token at today's table rate, so it diverges from
  ccusage's per-period cost (which used the rates in effect then). Acceptable for an
  instrument — it's stamped with `PRICING_VERSION` and ADR 0009 calls it an estimate —
  but a true historical cost would need per-period rate tables.
