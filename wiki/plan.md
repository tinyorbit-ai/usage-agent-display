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
