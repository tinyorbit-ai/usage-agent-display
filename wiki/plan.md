# Plan — usage-agent-display

Part of [[index]]. Status: **LOCKED** (hardened 2026-06-05 — eng + security + design +
codex reviewer; taste decisions resolved; see `## Review`). Build loop unlocked.

**Base branch:** `main`
**Discipline:** each phase runs on `phase/<n>-<slug>`; squash-merges back as ONE
commit after its verifiable gate is green; one [[build-log]] entry per phase.
**Hardware gate (locked):** the **automated software gate blocks the squash-merge**;
for phases with a hardware half (1, 2, 4) the **visual hardware confirmation is a
mandatory [[build-log]] entry** (photo / observed live update), added when at the board.

**Architecture:** see [[architecture]]. **Locked decisions:** [[decisions/0001-shape-daemon-api-cyd]],
[[decisions/0002-ccusage-invocation]], [[decisions/0003-daemon-auth-bearer]],
[[decisions/0004-ingest-dedup-model]], [[decisions/0005-cyd-board-and-toolchain]].

**Repo layout (introduced in phase 1):** `packages/server` (Bun+SQLite API) ·
`packages/daemon` (Bun collector) · `firmware/` (PlatformIO/ESP32) · `packages/shared`
(types: the `/usage/summary` contract + snapshot shapes).

**Fixed metric hierarchy (drives every layout):** tokens (hero) → cost → per-provider
(Claude Code vs Codex) → everything else (per-machine, session, 1h, month, last-sync).

**Secrets & supply chain (cross-cutting, security):** the shared bearer token lives in
**env** on daemon + server and in a **gitignored config/build-time header** on the
firmware — never a committed literal, never logged. All deps are **pinned + lockfiled**
(`bun.lockb`, `platformio.ini` lib versions); ccusage is pinned per
[[decisions/0002-ccusage-invocation]]. A repo `.gitignore` + a pre-merge **`gitleaks detect`**
run (default ruleset plus a custom rule for the bearer-token shape and WiFi SSID/PSK
keys; firmware secret headers and `.env` excluded by being gitignored, not by scan
exclusion) guard against committing tokens/WiFi creds — the scan is part of each phase's
gate where it touches secrets. `/ingest` is bearer-authenticated and
input-validated; the `/usage/summary` read path's auth is settled in the lock gate
(see Review → open taste decisions).

---

## Phase 1 — Aggregate two machines, show the number on the CYD
**Branch:** `phase/1-aggregate-and-show`
**Goal:** A daemon on two machines posts real `ccusage` totals to the central API;
`GET /usage/summary` returns the genuine **combined** token total (Claude Code + Codex,
summed across both machines); the CYD boots, joins WiFi, polls, and displays that one
combined token number as text. The hard part (cross-machine aggregation) proven
end-to-end, and a real number on the desk. Firmware deliberately minimal — one label,
no tiles/styling yet.
**Verifiable gate:**
- **Software (automated):** `bun test` green, including:
  - (a) **aggregation** — two snapshots from two distinct `machine_id`s sum correctly;
  - (b) **idempotency** — re-posting the *identical* snapshot does **not** change the
    total;
  - (c) **cumulative update (the real ccusage case)** — same dedup key posted
    `tokens=100` then `tokens=150` ⇒ total becomes **150, not 250** (newest *received*
    value wins, no double-count). This is the dedup correctness the brief calls the
    hard part — it must be falsified by the most likely regression.
  - (d) **canonical-report-type (no cross-report double-count)** — fixtures with
    `daily` + `session` + `monthly` rows for the same usage ⇒ the hero `totals.tokens`
    reflects **only `daily`**; adding session/monthly rows does NOT change it. (Codex
    review catch — without this the gate passes while the hero silently 2–3× inflates.)
  - (e) **clock-skew resolution** — two posts for one key where the *second received*
    carries an **older** `collected_at`: the second still wins (server `received_at`
    governs); a post with an implausibly future `collected_at` is rejected.
  - AND a scripted integration check (`scripts/e2e-phase1.ts`) that boots the server,
    POSTs fixture snapshots from two distinct machine_ids with the bearer token, then a
    *re-post* with an updated cumulative value, `GET /usage/summary`, and asserts
    `totals.tokens === <expected post-dedup, daily-only sum>` (exit 0 on match).
- **Auth (automated):** a POST to `/ingest` **and** a GET to `/usage/summary` without /
  with-wrong bearer token both return 401 (asserted). Both endpoints are
  bearer-protected (read-auth resolved at lock gate); the firmware sends the token on
  its poll.
- **Input validation (automated, security):** all DB writes go through a single
  **prepared-statement helper** (no string-built SQL), enforced by a **static check**
  (grep/lint that fails the build on raw SQL interpolation) — runtime tests alone can't
  prove this. `/ingest` **rejects** (400, writes nothing) any out-of-range or malformed
  field rather than clamping — token counts must be non-negative integers within a sane
  bound, `provider`/`model`/`machine_id` length-capped strings, unknown fields rejected.
  The bearer token is **never logged** (the `Authorization` header is redacted) —
  asserted by a log test.
- **Robustness (automated):** firmware fetch/parse handling is unit-tested off-device
  against a **state matrix** — HTTP 200 / 401 / 500 / timeout / disconnect / truncated
  or oversized body / missing `totals.tokens` — each yields the correct state (live /
  placeholder / connecting), never a crash or garbage render.
- **Hardware (manual, observable — live update, not a snapshot):** change the backend
  value **A → B** and require the CYD to update from A to B **within two poll intervals
  without rebooting** (proves the poll loop actually refreshes, not just first-paint).
  The displayed number equals `curl /usage/summary` at each step.
**Work:**
- Monorepo scaffold + `packages/shared` summary/snapshot types (v1 contract).
- **`machine_id` provenance:** derived from explicit daemon config, falling back to a
  stable hostname-derived id; never a value two machines could collide on (e.g. bare
  `localhost`). The e2e uses two genuinely distinct ids.
- Server: `POST /ingest` (bearer auth; stamps server `received_at`; dedup **upsert**
  into SQLite per [[decisions/0004-ingest-dedup-model]] — newest *received* wins,
  future-skewed `collected_at` rejected), `GET /usage/summary` (v1: `totals.tokens`,
  `totals.cost_usd`, `last_sync`), aggregation = sum of deduped current **`daily`** rows
  only (session/monthly stored but excluded from the hero).
- **Granular schema from the start** (per [[decisions/0004-ingest-dedup-model]]): rows
  carry `model` + `token_category` (input/output/cache_read/cache_write) even though
  phase 1 only *displays* the combined total — phase 3 pricing needs the granularity and
  ccusage's ~30-day window makes a later widening lossy.
- Daemon: invoke pinned `ccusage --json` ([[decisions/0002-ccusage-invocation]]) via
  **argv-array exec (never a shell string)** so no interpolated config value is a
  command-injection surface; normalize to snapshot rows **at model + token-category
  granularity** (ccusage `--json` already breaks down per model), tag
  `machine_id`/`collected_at`, POST with bearer token, loop on an interval; **post
  failures are retried/skipped
  without crashing the loop.** The bearer token is read from env, never logged, never
  committed.
- Firmware (PlatformIO/ESP32-2432S028R): WiFi connect, HTTP GET poll of
  `/usage/summary` **with the bearer token in the request header**, **bounded** JSON
  parse (ArduinoJson with a documented capacity),
  render `totals.tokens` via one LVGL label; show a **clear boot/"connecting…" state**
  before first data and a placeholder on **fetch OR parse** failure (last-good value
  retained, never garbage — never a blank or garbage screen). **Secrets** (WiFi creds, API URL,
  and the bearer token *if* the read path is authenticated): live in a **gitignored
  config header** / build-time injection, never a committed literal.
**Decisions:** [[decisions/0001-shape-daemon-api-cyd]] · [[decisions/0002-ccusage-invocation]]
· [[decisions/0003-daemon-auth-bearer]] · [[decisions/0004-ingest-dedup-model]] ·
[[decisions/0005-cyd-board-and-toolchain]].

---

## Phase 2 — The full tile layout (metric hierarchy on screen)
**Branch:** `phase/2-tile-hierarchy`
**Goal:** The CYD shows the real dashboard per the fixed hierarchy: hero tokens, cost,
per-provider split (CC vs Codex), per-machine split, current-session burn,
month-to-date, and an honest last-sync age. Static (refresh-on-poll), not yet animated.
The panel degrades gracefully: when a daemon stops, that machine's tile goes stale and
the last-sync age visibly climbs.
**Verifiable gate:**
- **Automated:** schema test asserts `/usage/summary` (v2) carries `by_provider[]`,
  `by_machine[]`, `session`, `month`, `last_sync`, each computed correctly from
  fixtures (exact values asserted); a "stale" test — with no snapshot newer than the
  **configured freshness threshold** (`STALE_AFTER_SECONDS`, default named in config),
  the machine's `age_seconds` exceeds it and it is flagged `stale: true`.
- **Manual, observable:** every tile on the CYD matches the corresponding
  `curl /usage/summary` value; stopping one daemon makes that machine's tile show stale
  + the age climb on screen.
- **States (manual, observable — design):** the panel renders a *designed* state for
  each of **no-data-yet (empty)**, **live**, **partial** (one machine fresh, one stale),
  and **all-stale** (backend unreachable → last-good values dimmed + explicit "STALE
  Nm"). No state shows a blank/garbage screen.
- **Readability + non-color signal (manual, design):** the hero token number is legible
  **across the room**; every state is distinguishable **without relying on color alone**
  (icon/shape/label/position carries it too) — verified by a desaturated photo of each
  state.
**Work:** extend summary contract (v2 fields) + server rollup queries (provider &
machine breakdowns, session, month, freshness); LVGL multi-tile layout honoring the
hierarchy; **designed render states** (empty / live / partial / all-stale) with
**second non-color signal per state** and a defined **staleness visual progression**
(fresh → dimming → explicit "STALE Nm" text, not hue alone); **pin the reckoning
timezone** — "today" / session / month-to-date are computed in one declared timezone
(server-local, configurable) so machines in different TZs roll up consistently
(asserted with a cross-TZ fixture). Establishes the display system per
**ADR 0006 — display design system** (type scale, palette, state-color+icon mapping).
**Decisions:** extends the [[architecture]] `/usage/summary` contract (no new ADR
unless a layout trade-off surfaces).

---

## Phase 3 — Cost as an instrument
**Branch:** `phase/3-cost-instrument`
**Goal:** Cost stops being a footnote and becomes something to steer by: model-aware
pricing, end-of-day and month projection ("at this rate, ~$X by EOD / ~$Y by
month-end"), and an optional budget line with burndown %. Cost is shown honestly as an
estimate (ccusage-derived). Tokens remain the hero; cost rides second.
**Verifiable gate:**
- **Automated:** pricing unit test — a fixture token breakdown by model priced to an
  expected `$` (within tolerance); **unknown-model test** — tokens for a model absent
  from the pricing table are NOT silently priced at $0; they surface as
  `unpriced_tokens` (and the cost is flagged partial) so the display can be honest
  rather than wrong; projection test — a fixture intra-day rate projects EOD/month
  within tolerance of the hand-computed value; budget test — given a limit, `used_pct`
  is correct and crossing it sets an `over_budget` flag.
- **Manual, observable:** CYD cost tile shows spend + EOD/month projection; with a
  budget set, the burndown/over-budget state renders.
**Work:** versioned per-model **and per-token-category** pricing table
(provider-agnostic) — prices the granular rows already stored since phase 1, so **no
schema migration / no lost history**; cache-read/write categories priced distinctly
from input/output; projection logic (EOD from today's pace, month from MTD pace),
optional budget config, summary fields (`projection`, `budget`, `unpriced_tokens`), CYD
cost tile.
**Decisions:** introduces **ADR 0007 — pricing source & projection method** (where
prices come from, how projection extrapolates, how estimate-uncertainty is shown).

---

## Phase 4 — Make it live (mission-control feel)
**Branch:** `phase/4-live`
**Goal:** The panel feels alive: the hero token count visibly **ticks** between polls,
a **scrolling 1-hour sparkline** of token burn, and the currently-active machine
**glows**. Achieved without hammering the backend.
**Verifiable gate:**
- **Automated:** server exposes a 1h token time-series (`sparkline_1h[]` buckets) and
  an `active_machine` field; a test asserts correct bucketing of fixture events and that
  `active_machine` = the machine with the **most recent positive token delta inside the
  live window** (the one actually *burning* tokens), NOT merely the most-recently-synced
  daemon (which ticks on a timer even when idle). (Codex review catch.)
- **Automated:** **interpolation-bound test** — the displayed hero is **never
  interpolated above the last confirmed total**; when a higher confirmed total arrives
  it eases up to it; a *lower* confirmed total (correction / day-rollover) is an
  **explicit reset**, not a backward tick (resolves the earlier ease-toward-truth /
  never-decrease contradiction). Gap test — a bucket with no data renders as zero/gap,
  never interpolated phantom burn.
- **Manual, observable:** generate live agent activity on one machine; within the poll
  window the CYD's burn number animates upward, the sparkline scrolls with the new
  bucket, and that machine's tile glows. The number ticks smoothly between polls
  (interpolated up toward the predicted next confirmed value), not in jumps — and on a
  downward correction it **resets cleanly** rather than jolting backward.
**Work:** server rolling 1h buckets + **active-machine = latest positive token delta in
window**; live transport decision (fast-poll vs SSE) → **ADR 0008**; firmware: LVGL
value-animation for the ticking hero with **bounded interpolation capped at the last
confirmed total** (never display above confirmed; gaps render flat; downward
corrections reset), sparkline widget, active-machine highlight; **restrained motion
budget (locked):** hero always ticks, sparkline scrolls only on a new bucket, glow is a
slow subtle pulse — never more than hero + one secondary in motion at once; polling
backoff / rate-limit so "live" doesn't hammer.
**Decisions:** introduces **ADR 0008 — live transport (fast poll vs SSE)**.

---

## Phase 5 — Extensibility proof + self-host ops hardening
**Branch:** `phase/5-extensible-and-ops`
**Goal:** Make good on the 3-year-fit promise and turn it into something that actually
runs unattended. Prove a new provider slots in through the collector seam with **zero
core changes**, and package the system to self-host (server as a managed service,
daemon installable per machine, documented one-command setup, sane retention).
**Verifiable gate:**
- **Automated:** add a fixture "third provider" through the `collector` interface and
  assert it flows ingest → dedup → `/usage/summary` (appears in `by_provider[]` and the
  combined total) with **no change** to aggregation code (proves provider-agnostic);
  server + daemon each start from the documented command and pass a smoke check.
- **Manual, observable:** the full system runs unattended across a full day on real
  machines; `last_sync` stays honest, totals stay correct, no double-counting.
**Work:** formalize the `collector` interface + register providers; env/config
surface; process management (launchd/systemd or container for server, install recipe
for daemons); retention/cleanup policy (ccusage's ~30-day local window —
[[decisions/0004-ingest-dedup-model]]); run/setup docs.
**Decisions:** may introduce an ADR for retention policy if the trade-off is
non-trivial.

---

### Phase ordering
Strictly sequential — each leaves the system in a working state, and firmware phases
depend on the `/usage/summary` contract version the prior phase froze. No phases are
independent enough to parallelize.

---

## Review

**Mode:** interactive
**Personas run:** forge-harden-eng (LOCK) · forge-harden-security (DAILY) ·
forge-harden-design (POLISH). Skipped: -dx (not a product / single-tenant non-goal),
-scope (ambition already pressure-tested at discovery).
**Adversarial reviewer:** **codex** (gpt-5.5, xhigh) — auto-probe, first installed
(`codex` → gemini → claude). No config/env override.

### Findings fixed

- **eng (7):** hardened gates — phase-1 dedup *cumulative-update* case, phase-2 named
  stale threshold + reckoning timezone, phase-3 unknown-model → `unpriced_tokens`,
  phase-4 monotonic interpolation; added `machine_id` provenance + daemon-loop
  crash-safety + firmware JSON robustness.
- **security (4):** `/ingest` parameterized SQL + boundary validation + token
  redaction; daemon ccusage via argv-array exec (no shell injection); firmware secrets
  in gitignored header; cross-cutting secrets + pinned-deps note. LLM surface: n/a (no
  model in the data path — prompt-injection does not apply).
- **design (4):** designed render states (boot/connecting/empty/live/partial/all-stale)
  across phases 1–2; second non-color signal per state; staleness visual progression;
  room-distance legibility (desaturated-photo check). Seeded **ADR 0006 — display design
  system**.
- **reviewer / codex (12, all applied — additive, no contradictions):**
  - *(H)* **canonical report type** — hero now sums **`daily` only**; mixed-report
    fixture proves session/monthly don't inflate it (was a silent 2–3× double-count the
    persona gates would have passed).
  - *(H)* **server-`received_at` dedup** — conflict resolution no longer trusts the
    daemon clock; future-skewed snapshots rejected (ADR 0004 updated).
  - *(H)* **granular schema from phase 1** — rows carry `model` + `token_category` so
    phase-3 pricing needs no migration and ccusage's ~30-day window doesn't cost us
    history.
  - *(H)* fixed phase-4 ease-toward-truth/never-decrease **logic contradiction** (cap at
    last-confirmed; downward = explicit reset).
  - *(M)* reject-not-clamp; prepared-statement helper + static no-raw-SQL check;
    firmware fetch-state matrix (200/401/500/timeout/disconnect/oversized); hardware gate
    now proves **live A→B update within two polls, no reboot**; `active_machine` = latest
    positive token delta (not freshest sync); cache-read/write token categories priced.
  - *(L)* secret-scan specified as `gitleaks detect` with a custom token/WiFi rule.

### Renumbered ADRs (deferred, written when their phase starts)
- **0006** — display design system (phase 2) · **0007** — pricing source & projection
  (phase 3) · **0008** — live transport: fast-poll vs SSE (phase 4).

### Taste decisions — RESOLVED at lock gate (2026-06-05)
1. **`/usage/summary` read-path auth** → **bearer-required.** GET needs the same bearer
   token; firmware stores it in its gitignored config header. Phase-1 gate adds a
   401-on-unauthenticated-read test. (Settled before phase 1, per codex.)
2. **Hardware gate strictness** → **software gate blocks the squash-merge; hardware
   visual confirmation is a MANDATORY [[build-log]] entry** (photo / observed A→B
   update) for any phase with a hardware half (1, 2, 4). Merge isn't coupled to
   board-presence, but HW verification can't silently slip.
3. **Phase-4 motion budget** → **restrained.** Hero always ticks; sparkline scrolls only
   on a new bucket; active-machine glow is a slow subtle pulse; never more than hero +
   one secondary in motion at once. Folded into phase-4 work.

### Reviewer-vs-persona disagreements
None. Codex's findings were entirely additive to the persona passes; all twelve were
objective and have been applied. The two highest-value catches of the whole pass
(canonical report type, granular-from-phase-1 schema) came from the reviewer.

---

## Post-release phases (added after the 5-phase plan locked)

The original plan (1–5) shipped and was retro'd. These phases were added as the project
kept evolving — same branch/gate/squash discipline.

### Phase 6 — ccusage v20 multi-agent + first-light deploy
**Branch:** `phase/6-ccusage-v20-multiagent`
**Goal:** Track ccusage's multi-agent rework and bring the system up on real hardware.
**Gate (met):** pin ccusage 16.2.4→20.0.6; normalizer reads `period` buckets + derives
provider per-breakdown from the model name; +6 normalize tests; full gate green; first
light confirmed on the CYD (real hero, all three providers). See [[build-log]].

### Phase 7 — Panel visual polish + working timeframe tabs (live)
**Branch:** `phase/7-panel-visual-polish`
**Goal:** Make the panel look designed and add tappable timeframe tabs on real data.
**Gate (met):** locked "C2 · Daily Rate" design (1bpp Silkscreen pixel fonts, size
hierarchy, color-coded agents, tokens/day graph); tap-to-cycle tabs (PENIRQ); additive
`/usage/summary` `timeframes`/`daily`/`last_used` with +4 tests; full gate green; verified
live end-to-end on the CYD. ADR [[decisions/0012-panel-visual-system-v2]]. See [[build-log]].

### Phase 8 — Distribute the daemon + deploy the server (public, bearer-gated)
**Branch:** `phase/8-distribute-and-deploy`
**Goal:** Run the server on the VM with a public URL reachable from any machine, and
ship the daemon as a drop-in binary for laptop + work laptop.
**Gate (met):** `bun run build:daemon` produces single-file binaries (macOS arm64/x64,
linux x64) + run README; `packages/server/ecosystem.config.js` for the self-host deploy system (PM2 +
Doppler + Cloudflare Tunnel → `https://usage.<baseDomain>`); unauthenticated `GET /health`
(+2 tests); repo registered in the deploy system's `repos.json`; full gate green. ADR
[[decisions/0013-distribution-and-deployment]]. See [[build-log]].

---

## Feature: Agent filter (two-axis time × agent tabs)

Added 2026-06-06 from [[brief-agent-filter]]. Same branch/gate/squash discipline.
Decisions: [[decisions/0014-agent-filter-direct-tap]] (feature shape — direct-tap both
tab groups, full-readout filter incl. graph) · [[decisions/0015-touch-input-stack]]
(XPT2046 on dedicated SPI + baked calibration).

**Why three phases for one "ship it all at once" feature:** the user's "all at once"
means *no shipped half-filtered agent state* — not "one branch". These three slices each
leave the system working and **none merges a half-filtered agent UI**: phase 10 is a
pure additive backend field (firmware unaffected), phase 11 is a complete input-model
swap on the *time* axis only (no agent UI yet), and phase 12 lands the agent control +
hero/cost/graph filter together. Splitting the risky touch rewrite out of the large
agent-UI phase de-risks the hardware knot just before the integration phase. Order:
backend (zero-risk, unblocks 12) → touch foundation (de-risk) → agent control + filter.

### Phase 10 — Backend: per-provider daily series
**Branch:** `phase/10-daily-by-provider`
**Goal:** `/usage/summary` carries `daily_by_provider` — an object keyed by open
provider id, each a token array index-aligned with the existing `daily` series (**same
length and same buckets as `daily`, which is the latest buckets-with-data and can be
< 14 — not a fixed 14-calendar-day axis**) — so the firmware can later redraw the bar
graph for one filtered agent. Purely additive; existing firmware ignores the new field
and is unaffected.
**Verifiable gate:**
- **Automated (`bun test` + existing static checks green). The fixture must use the
  SHAPE production emits** — **≥2 machines**, **≥2 models per provider**, and a
  **re-posted (deduped) row** — so a one-row-per-provider stand-in can't pass while a
  cross-machine/cross-model double-count or a SUM-vs-dedup error slips through
  ([[learnings]] 2026-06-06 "test the shape production emits"). Days must carry
  **distinct, per-provider-distinct values** (no two buckets equal, no two providers
  equal) so a reversed, transposed, or off-by-one series fails. Tests:
  - **exact per-index values** — assert `daily_by_provider[p]` equals the hand-computed
    array *position by position* (not totals, not "non-empty"); a reversed or shifted
    series must fail ([[learnings]] 2026-06-06 "assert exact positions").
  - **alignment to the combined axis (NOT a hardcoded 14)** — `dailySeries(14)` is
    `GROUP BY bucket … LIMIT 14`: it returns the latest **buckets that have data**, so its
    length can be **< 14** and calendar gaps collapse. Every `daily_by_provider[p]` array
    must satisfy `length === daily.length` and be index-aligned to `daily`'s **actual
    bucket dates** (same buckets, same order) — never a fixed-14 assumption. Fixtures MUST
    include a case where `daily.length < 14` and a case with non-contiguous calendar
    dates, so a fixed-14 stand-in fails. (Combined `daily`'s "recent buckets with data"
    semantics stay unchanged — converting it to a zero-filled calendar axis is out of
    scope.)
  - **consistency (no combined↔split drift), made structural** — for every bucket `i`,
    `sum over providers of daily_by_provider[p][i] === daily[i].tokens` (exact). Derive
    the split and the combined `daily` from the **same base CTE/dedup** so the invariant
    holds by construction, not coincidence ([[learnings]] 2026-06-05 "make a stated
    invariant load-bearing"); the test is the tripwire.
  - **provider present ⇒ key present (as zeros if idle)** — every provider that appears
    in any timeframe's `by_provider` ALSO appears in `daily_by_provider`; a provider with
    all-time usage but **nothing in the graph's bucket window** yields an explicit
    `daily.length`-long all-zeros array (aligned to `daily`'s buckets), never a missing
    key. (This is what lets the firmware filter render an honest empty graph instead of
    falling back — see phase 12.)
  - **sparse providers** — a provider with usage on only some of `daily`'s buckets yields
    explicit `0`s on the other buckets (a real gap), never a short/misaligned array.
  - **canonical report type** — the split sums **`daily` rows only**, exactly like the
    hero; a fixture with session/monthly rows for the same usage does NOT inflate any
    provider's series (reuses the phase-1 canonical-report invariant).
  - **no N+1** — the rollup is a **single** `GROUP BY provider, bucket` query, not one
    query per provider; uses the prepared-statement helper (existing static
    no-raw-SQL check still passes).
  - **payload-size guard (security — availability):** ⚠️ the **deployed** firmware parses
    `/usage/summary` with an **unbounded `JsonDocument` (`main.cpp:286`)** — the 8KB
    `kMaxBodyBytes` guard lives in `usage_state.h`, which the live screen does *not* use
    (the same host-core regression as P7). So a larger additive payload doesn't reject
    cleanly; it risks **parse-fail / heap-spike on the already-shipped firmware** before
    P12 lands. Therefore P10 must keep the field small: bound `daily_by_provider` to the
    providers actually present, and assert the **serialized summary stays ≤ ~6KB** with a
    worst-realistic fixture (max machines × max providers × `daily.length`). If that can be
    exceeded, cap the emitted provider count and document it. (P12 then moves the live
    parse onto the bounded core — see below — so the guard becomes real, not aspirational.)
- **No hardware half** (server-only). Contract stays additive; `v` unchanged.
**Work:** add a `dailySeriesByProvider()` rollup in `db.ts` built from the **same base
query** as `dailySeries` (canonical `report_type='daily'`, flat token `SUM` — tokens are
not cost-replicated, so no inner cost-dedup subquery, exactly like `dailySeries`), adding
`provider` to the GROUP BY in one pass so combined and split cannot drift. **The bucket
axis is defined by the combined `daily` series, not per provider:** first compute `daily`
(its buckets ARE the axis — possibly < 14, gaps collapsed), then **reindex each provider's
(bucket→tokens) onto exactly `daily`'s bucket dates, zero-filling buckets where that
provider has no row** — do NOT take "latest N buckets per provider" (that gives each
provider a different axis, misaligning the arrays and breaking the consistency invariant).
Assemble `daily_by_provider` in `summary.ts` (emit a `daily.length`-long zero array for
every provider seen in any timeframe but idle on the axis); extend the shared
`/usage/summary` type in `packages/shared` (new field **optional** so older firmware still
typechecks/ignores it); document the field in [[architecture]]. The alignment gate fixture
must include **`daily.length < 14`** and **a provider missing on some of `daily`'s
buckets** to prove zero-fill-to-the-combined-axis (not just equal-length arrays).
**Decisions:** extends the contract per [[decisions/0014-agent-filter-direct-tap]]
(no new ADR — additive field, shape recorded in [[architecture]]).

### Phase 11 — Firmware: real touch coordinates (direct-tap time tabs)
**Branch:** `phase/11-touch-coordinates`
**Goal:** Replace the PENIRQ any-tap-cycle model with real XPT2046 coordinate reading:
the time tabs (`TODAY / 30D / ALL`) become **direct-tap** — tapping a tab selects *that*
tab, not the next one. No agent UI yet. This isolates and proves the hardware knot
(touch on a separate SPI bus + calibration + hit-testing) before the agent-UI phase
piles on top.
**Verifiable gate:**
- **Host-testable-core requirement (the tripwire — [[learnings]] 2026-06-06 "an
  architectural discipline needs a tripwire"):** `routeTap`, the raw→screen transform,
  and the hit-box table live in a **host-compilable header with zero Arduino/LVGL/SPI
  includes** (`usage_state.h` or a sibling like `ui_input.h`), and the native runner is
  extended to **compile and run a test that includes it**. The gate **fails** if this
  logic is defined in `main.cpp` (where the native suite can't reach it) — enforced by a
  static check (the native test TU must include the routing header; `main.cpp` must not
  redefine `routeTap`). Without this the "pure host tests" below are unwritable and the
  gate is hollow — which is precisely how the host-testable core silently regressed in P7.
- **Automated (firmware native suite green — `bun run firmware/test/run-native.ts`),
  including pure host tests:**
  - **`routeTap(x,y)`** — a tap inside each time-tab's (padded) bounding box routes to
    that tab index; a tap in the inter-tab gap or outside the bar routes to **none**;
    boundary cases at the hit-box edges resolve to the intended tab (generous-hitbox
    behavior asserted explicitly).
  - **touch-target minimum (accessibility):** assert each tab's **hit-box** is at least
    ~40 px in the tap dimension even though the *drawn* pill is smaller — the hit-box is
    padded beyond the glyph so a finger on resistive touch lands reliably. (The drawn pill
    keeps the ADR 0012 look; only the invisible target grows.)
  - **raw→screen transform incl. rotation/axis-swap** — the display runs
    `tft.setRotation(1)` (landscape), so the calibration affine must map XPT2046 raw
    coordinates into **LVGL landscape pixels `(0,0)..(319,239)`**, handling the X/Y swap
    and any axis mirroring — not just a self-consistent scale. The test asserts the mapping
    for **all four physical corners + center** in landscape coords (so a mirrored/swapped
    axis that still passes a self-consistent fixture is caught); an out-of-range raw read
    (rail / too-low pressure) is rejected (routes to none), never wraps to a bogus pixel.
  - **touch-gating** — coordinates are only trusted when PENIRQ asserts touch; a coordinate
    read with PENIRQ idle (electrical noise) yields **no tap** (asserted in the host model
    of the read path), so noise can't spuriously change the tab.
  - **debounce + no re-arm under a held press** — two reads inside the debounce window
    register one tap; AND a **held touch with PENIRQ chatter spanning longer than the
    debounce window registers exactly ONE tab change**, not repeated fires (resistive
    PENIRQ can re-arm after 250 ms mid-press). Require a **stable release-high for N ms**
    before another tap is accepted; host-test the chatter sequence explicitly.
- **Hardware (manual, observable — MANDATORY [[build-log]] entry, per the locked
  hardware gate):** on the CYD, tap **ALL**, then tap **TODAY** — the panel jumps
  directly TODAY (a non-adjacent change), proving positional selection, *not* cycling.
  Tap **left / middle / right** tabs and the **inter-tab gaps** — each named tab is hit by a
  single direct tap and gaps select nothing (catches a mirrored/swapped landscape axis);
  a **long press** changes the tab once, not repeatedly. Photo / observed.
**Security (supply chain + secrets):** pin `XPT2046_Touchscreen` to an **exact version**
(`@x.y.z`, not a range) in `lib_deps`, matching the project's pinned-deps posture — a new
top-level firmware dependency. The committed `touch_config.h` must contain **only**
calibration geometry, never creds; run the existing pre-merge **`gitleaks detect`** as part
of this phase's gate since it adds a committed config file (confirm no WiFi/token leak).
Touch is a **read-only navigation boundary** — it selects views and never mutates server
state or triggers actions (the brief's "not a control surface" non-goal, enforced by
`routeTap` only writing local `g_tf`/`g_agent`).
**Work:** add `XPT2046_Touchscreen@x.y.z` (exact pin) to `platformio.ini` `lib_deps`;
instantiate on a dedicated HSPI `SPIClass` (CLK 25 / MOSI 32 / MISO 39 / CS 33 / IRQ 36); put `routeTap`
+ the transform + the hit-box table in the **host-compilable core** (committed header, no
Arduino deps) and extend the native test to compile it; keep WiFi creds + bearer token in
the gitignored `config.h`, but put the **calibration constants + hit-box geometry in a
COMMITTED board-config header** (`touch_config.h` or `platformio.ini` build_flags) — they
are not secrets, the host tests must reference them, and a fresh checkout must build with a
known calibration (single-unit constants, documented as such); in `loop()`, sample
coordinates **only while PENIRQ is asserted**, route, and set `g_tf` directly; delete the
any-tap cycle path entirely.
**Decisions:** introduces [[decisions/0015-touch-input-stack]] (which is updated to put
calibration constants in committed board-config, not the gitignored secrets header);
amends the input model of [[decisions/0012-panel-visual-system-v2]].

### Phase 12 — Firmware: agent control + full-readout filter
**Branch:** `phase/12-agent-filter`
**Goal:** The static `ALL AGENTS` label becomes a 4-segment agent control (`ALL` +
Claude/Codex/Gemini chips) mirroring the time tabs. State is **(timeframe × agent)**,
both direct-tap, agent default `ALL`. Selecting an agent re-scopes **hero + cost + the
14-day graph** to that provider (graph in its brand color); the three agent rows remain
as the breakdown with the selected one emphasized; `ALL` restores the combined view.
**Verifiable gate:**
- **Automated (firmware native suite green; routing/selection logic in the host-compiled
  core per phase 11's tripwire), including pure host tests:**
  - **`routeTap` (extended) + disjoint groups** — taps resolve to the four agent chips
    (`ALL / claude / codex / gemini`) by padded hit-box; time-axis routing unchanged. An
    explicit test asserts **no x,y maps to both a time tab and an agent chip** (the two
    groups' hit-boxes are disjoint) and that a tap in the gap between the groups routes to
    **none** — so a near-miss never silently flips the wrong axis. Each agent chip's
    hit-box also meets the **~40 px tap-dimension minimum** (accessibility; padded beyond
    the drawn chip) — the binding constraint given four chips in the ~150 px right band.
  - **agent IDs are the PRODUCTION provider strings** — the chips map to a fixed
    `Agent { label, color, provider_id }` table using the **exact ids the payload uses**:
    `claude-code` (not `claude`), `codex`, `gemini` — matching `providerTokens(bp,
    "claude-code")` at `main.cpp:249`. Tests/fixtures MUST use these ids; a test that
    routes `"claude"` would pass while the live Claude chip selects a non-existent provider
    and shows permanent zeros. Assert each chip's `provider_id` resolves to a non-zero
    value in a fixture that has that provider.
  - **selection state machine** — time and agent axes are independent: changing one
    leaves the other; agent boots to `ALL`, time stays `30D`.
  - **`selectHero/selectCost(agent, tf)` — honest, never the combined total under a
    filter.** Returns the per-provider value from `by_provider` for a named agent, and the
    timeframe `totals` only when agent == `ALL` (`ALL` ≠ summing the split twice). A
    named agent **absent** from that timeframe's `by_provider` (e.g. TODAY × an idle
    agent) returns **0**, NOT the combined total — assert this with an absent-provider
    fixture ([[learnings]] 2026-06-06 "unknown → honest, never confidently wrong").
  - **`selectSeries(agent)` — absent ⇒ zeros, never combined.** agent == `ALL` → the
    combined `daily` series; a named agent → `daily_by_provider[provider_id]` if present,
    else an **all-zeros array of the same length as the parsed `daily`** (never a hardcoded
    14). It must NOT fall back to the combined series for a named agent — showing the
    combined graph while filtered to one agent would overstate that agent (the same honesty
    trap as phase 3's mis-pricing). Assert an idle-named-agent yields a same-length zero
    series, and `ALL` yields exactly `daily`.
  - **ALL-path regression lock** — with agent == `ALL`, `selectHero/selectCost/selectSeries`
    return **exactly** the pre-feature values (timeframe `totals` + combined `daily`), so
    the filter is provably a no-op when nothing is filtered.
  - **move the live summary parse onto the bounded host-tested core (closes the P10 gap):**
    the deployed screen parses with an unbounded `JsonDocument` at `main.cpp:286`; P12
    relocates that parse into the host-compilable core (the `usage_state.h`-style bounded
    parser with the `kMaxBodyBytes` cap) so the 8KB DoS guard and the parse logic are
    actually host-tested — not bypassed as they are today. The native suite gains a parse
    test over a representative `daily_by_provider` body.
  - **bounded parse of untrusted arrays (security — memory safety):** `daily_by_provider[*]`
    is parsed with the same **clamp pattern as the existing sparkline** (`kMaxSparkBuckets`):
    each array is clamped to a fixed max buffer and to the parsed `daily` length, an
    under-length/missing one is zero-padded, and every index is bound-checked — **no
    out-of-bounds read** regardless of what the body claims. Assert with short /
    over-length / missing-array fixtures.
- **Design (manual, observable — folds into the MANDATORY build-log entry; honors
  ADR 0008/0012):**
  - **active-state non-color signal** — the selected agent chip is distinguishable in a
    **desaturated photo**, not by color alone (e.g. the filled highlight pill the time
    tabs already use), so "which agent is filtered" reads without relying on the brand
    hue. The active treatment is distinct from the always-colored agent **dots** in the
    rows below (selection ≠ legend).
  - **filter glance signal** — which filter is active is legible **across the room**: the
    hero/graph recolored to the agent's brand color is the at-a-distance cue.
  - **filtered graph scale (resolved taste decision)** — the filtered graph **autoscales to
    the selected agent's own max** so its trend fills the height and stays readable, AND
    shows that agent's **peak-day value** as a small label (e.g. where the `MONTH` label
    sits) so per-agent magnitude is stated numerically. `ALL` keeps the existing combined
    autoscale + label. (Autoscale-to-self is already `updateGraph()`'s behavior; the work
    is the peak-day label + restoring the combined label on `ALL`.)
  - **filtered-but-empty is a designed state, not a broken one** — an idle agent renders a
    deliberate empty treatment (e.g. `0` hero + flat baseline + a small "no <AGENT> · 14d"
    note), visibly **distinct** from the existing Disconnected/AllStale states (ADR 0008
    table) so zero-under-filter never reads as offline/broken.
  - **filter survives degraded states** — the agent selection persists and stays visible
    during Connecting and Disconnected/stale states; the stale dimming applies to the
    filtered view too (you can filter last-good data).
- **Hardware (manual, observable — MANDATORY [[build-log]] entry):** tap **CODEX** — the
  hero, cost, and bar graph all switch to Codex-only (graph redraws cyan), the agent rows
  stay visible with Codex emphasized; tap **ALL** — combined view returns unchanged. An
  **idle agent** (one with zero usage in the window) shows the designed empty-filter state,
  not the combined view. Cross-axis: **TODAY × CODEX** shows today's Codex numbers.
  **Toggle stability:** **CODEX → ALL → CODEX** yields **identical bar positions/heights**
  each time (no rotated or retained stale bars — see the deterministic-redraw work item).
  Displayed hero/cost for the selected `(timeframe, agent)` equal `curl /usage/summary` for
  that provider/timeframe. Photo / observed.
**Work:** **mock the new top bar in HTML at true 320×240 and photo-verify spacing before
wiring** (the established ADR 0012 process — the top row now carries two segmented controls
+ the cost number, so collisions must be designed out, not discovered at flash time; lock
the agent-control coordinates so the time tabs (left), agent control (right), and cost
number don't overlap); read per-provider `cost_usd` (already in payload) and `daily_by_provider`
(phase 10) in the firmware parse; add the agent segmented control to `buildScreen()`
(reuse the time-tab pill style + `kClaude/kCodex/kGemini`); the control is **fixed at the
three branded agents + ALL** (documented limitation: a future 4th provider would appear in
the `ALL` total but have no chip — recorded in [[improvements]], consistent with the
brief's sharper-niche three-year fit); add `g_agent` state + agent hit-boxes to the
host-core `routeTap`; in `renderActive()`, drive hero/cost/agent-row emphasis from the
selected agent and rebuild the chart series from `selectSeries(agent)` recolored to the
agent; the `ALL` path renders exactly today's combined behavior (locked by the regression
test above). **Deterministic chart redraw:** the current `updateGraph()` appends via
`lv_chart_set_next_value` (`main.cpp:227`), which rotates the ring buffer and can retain
stale bars across filter toggles — on each filter change, **set the point count to the new
series length and write every bar by index (clear-before-fill)**, so a redraw is a function
of the selected series alone, not of prior state.
**Decisions:** [[decisions/0014-agent-filter-direct-tap]] (feature shape);
[[decisions/0015-touch-input-stack]] (touch).

### Feature phase ordering
Sequential. Phase 12 depends on phase 10's `daily_by_provider` field and phase 11's
touch foundation. Phase 10 (server-only) and phase 11 (firmware-only) touch disjoint
code and *could* run in parallel, but are kept ordered for a single clean review thread.

---

## Review — Agent filter feature (phases 10–12)

**Mode:** interactive (hardened 2026-06-06).
**Personas run:** forge-harden-eng (LOCK) · forge-harden-security (DAILY) ·
forge-harden-design (POLISH). Skipped: -dx (not developer-facing — single-user device,
explicit non-goal) · -scope (not requested; ambition set at discovery).
**Adversarial reviewer:** **codex** (auto-probe: no `wiki/.forge/config.yaml`, no
`$FORGE_REVIEWER` → first available). Ran at `model_reasoning_effort=medium`.

### Findings fixed

- **eng (11; H×2, M×5, L×4):** host-testable-core **tripwire** for the touch/selection
  logic (the P11/P12 gates were hollow — the native runner never compiles `main.cpp`);
  killed the **dishonest filter→combined fallback** (idle agent must show zeros/0, never
  the combined view); made the per-provider **consistency invariant structural** (same
  base query) and forced **production-shaped fixtures** (≥2 machines/models + a reposted
  row) with exact-index assertions; `provider-present ⇒ key-present-as-zeros`;
  PENIRQ-gated coordinate sampling; **calibration constants → committed board config**
  (not the gitignored secrets header); disjoint hit-boxes between the two tab groups;
  **ALL-path regression lock**; single `GROUP BY` (no N+1); fixed-3-chips limitation
  documented; shared field optional. Plus the bucket-axis alignment catch (per-provider
  arrays reindex onto the combined `daily` axis).
- **security (3; M×3):** payload-size guard vs the firmware body cap (availability);
  exact-version pin of the new `XPT2046_Touchscreen` dep + `gitleaks detect` on the new
  committed config; bounded parse of the untrusted nested arrays (no OOB on the ESP32).
  Trust boundaries named: daemon→server (unchanged); server→firmware (body untrusted);
  physical-touch→firmware (read-only navigation). LLM surface: n/a.
- **design (5):** active-state **non-color signal** for the agent control (ADR 0008
  desaturated-photo rule — the chips are brand-colored, so selection can't be color);
  **designed filtered-but-empty state** distinct from Disconnected/AllStale; ≥~40px
  touch-target hit-boxes; **mock-in-HTML → photo-verify spacing** for the now-crowded top
  bar; filter persists/visible under Connecting/Disconnected.

### Reviewer (codex) — 6 NEW findings, all applied (additive, no persona contradictions)

- **(H, P12) Agent-ID mismatch** — payload uses `claude-code` (`main.cpp:249`), plan tests
  routed `claude` → Claude chip would show permanent zeros. Fixed: chips map to a fixed
  `Agent{label,color,provider_id}` table using production ids; tests/fixtures must use them.
- **(H, P10/P12) `dailySeries(14)` is not a 14-calendar-day axis** — it's the latest
  buckets-with-data (`< 14` possible, gaps collapsed). Fixed: per-provider arrays align to
  `daily.length` and `daily`'s actual buckets; fixtures must include `daily.length < 14`.
- **(M, P10/P12) Live parser is unbounded** — the screen parses with an unbounded
  `JsonDocument` (`main.cpp:286`); the 8KB guard in `usage_state.h` is unused (P7
  regression). Fixed: P10 keeps the field ≤~6KB for the *currently shipped* firmware; P12
  **moves the live parse onto the bounded host-tested core**.
- **(M, P11) Rotation/axis-swap** under `setRotation(1)` — fixed: calibration test asserts
  4 corners + center in landscape coords; hardware gate taps L/M/R + gaps.
- **(M, P11) Debounce re-arm on a held press** — fixed: require stable release-high before
  re-accept; host-test the chatter sequence.
- **(M, P12) Chart redraw via `lv_chart_set_next_value` retains stale bars** — fixed:
  clear-before-fill by index; gate that CODEX→ALL→CODEX gives identical bars.

**codex net assessment:** "needs changes" — all six were concrete plan changes and have
been applied; the plan now reflects them.

### Taste decisions — RESOLVED at lock gate (2026-06-06)
1. **Filtered graph y-axis scale → autoscale to the agent's own max + peak-day label.**
   The filtered graph autoscales to the selected agent's own max so its trend stays
   readable, AND shows that agent's **peak-day value** as a small label so magnitude isn't
   lost (the honesty the project values, without forcing a flat tiny series). Folded into
   phase 12 work + gate. (Rejected: autoscale-with-no-label — no magnitude cue;
   keep-combined-max — small agents render as a flat line, defeating the filter.)

### Lock
Plan **LOCKED** for phases 10–12 (2026-06-06). All objective findings fixed in place;
the one taste decision resolved above. Build loop unlocked — start with phase 10.
