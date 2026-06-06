# Retrospectives

Part of [[index]]. Running synthesis appended by `forge-retro`. Newest on top. One
entry per retro: what shipped, recurring patterns, what went well, what to improve.

## 2026-06-06 — Retro (phase 10 + agent-filter feature, phases 11–12)

**Lead finding — the retro loop closed, and exposed the next limit.** The previous
retro's #1 action item was "make the host-testable core ([[decisions/0007-firmware-host-testable-core]])
a **gate check**, not a prose promise." This arc *did it*: phase 11 added `check:fwcore`,
a static tripwire that fails the build if routing leaves the core or `main.cpp` redefines
it. It paid for itself one phase later — phase 12 moved the **entire** live `/usage/summary`
parse back into the host core specifically because the discipline now had teeth. A flagged
weakness became an enforced invariant in one cycle. But the same phase exposed the *next*
limit: phase 12 had **three green host suites, a clean device build, and a photo-verified
HTML mock, and still boot-looped on first flash** (LVGL bar chart ÷0 when `point_count==1`
at boot — [[notes/2026-06-06-chart-point-count-divide-by-zero]]). The action this time:
**the on-device hardware gate is load-bearing, not ceremony** — a firmware phase is not done
when the suite is green, and the empty/boot render state (before the first fetch) is a
first-class test case, because it's the first thing the device draws.

**Shipped.** This arc added the two-axis **agent filter** — the last planned feature. Phase
10 (backend) split the daily token series per provider (`daily_by_provider`), reindexed onto
the combined axis and zero-filled, built from the same base query so the split sums to the
combined series **by construction**. Phases 11–12 were deliberately cut as
**touch-foundation then agent-UI** so no half-filtered state ever shipped: phase 11 replaced
the PENIRQ any-tap-cycle with real XPT2046 coordinates (direct-tap tabs), all routing /
calibration / pressure-gating / debounce in the host core with the tripwire above; phase 12
turned the static `ALL AGENTS` label into a 4-segment `(timeframe × agent)` control that
re-scopes hero + cost + graph to one provider (brand recolor + filled-pill non-color signal
+ dimmed rows), with `ALL` regression-locked to the exact pre-feature values. The headline
under the hood: the live parse moved off `main.cpp`'s unbounded `JsonDocument` and onto the
**bounded host-tested core** — the P7/P10 regression is now fully closed, and the cap is
enforced at *read* time. The combined firmware is flashed and rendering live (`30D × ALL =
7.27B`).

**Recurring pattern — every high-value catch this arc was a value crossing a boundary
uncontained.** P10: an open-string provider id used as a plain-object key (`__proto__`
pollution). P11: a sensor's "present" pin (PENIRQ) trusted as a "valid reading" (pressure
ignored). P12: a provider id guessed (`claude` vs the production `claude-code`), a 64-bit
token count narrowed to a 16-bit display coord, and a body cap enforced *after* the
allocation it was meant to prevent. This is the exact class the phases 1–5 retro named for
the dedup store — a value entering a structural position (map key, sensor signal, display
int, heap buffer) without being contained at the boundary. **Codex found the subtle one
every single phase.**

**What went well.** Acting on the last retro (the tripwire) instead of re-deferring it.
The per-phase **codex adversarial pass** earned its keep three times over. The
**mock-in-HTML → flash-the-winner** loop (ADR 0012) caught the top-bar spacing before a
flash cycle. The host-testable core was *extended* this arc, not bypassed — the opposite of
what phase 7 did to it.

**What to improve.** (1) Add "renders the empty/boot state correctly" to the firmware
build checklist — the ÷0 was a pure empty-state bug. (2) Calibration constants
(`kTouchCal`) are still best-guess defaults needing an at-board tuning pass; if this ever
runs on a second board, a one-time serial-calibration helper would remove the manual step.
(3) Physical tap verification is a genuine human-in-the-loop gap — the hardware half of the
touch gates can't be automated, only the routing logic underneath it.

**Open threads.** Physical tap verification + `kTouchCal` tuning are the one remaining
at-the-board step (live render already confirmed). Fixed-3-chips agent control is a
documented limitation ([[improvements]]). With the agent filter shipped, the planned
feature set is complete.

## 2026-06-06 — Retro (phases 6–9, post-release arc + two chores)

**Lead finding.** The discipline that carried phases 1–4 — a **host-testable firmware
core** ([[decisions/0007-firmware-host-testable-core]]) — *silently regressed in phase 7*
the moment the UI got ambitious, and has stayed regressed through 8, 9, and two chores
despite being flagged its own "highest-value cleanup" each time. An architectural rule
with no automated enforcement erodes under the first phase that has a reason to bypass it.
That's the one to act on: make ADR 0007 a **gate check**, not a prose promise.

**Shipped.** This arc took the proven-correct system of phases 1–5 and made it *real in
the world*. Phase 6 caught ccusage's jump to multi-agent (v20): the pin moved
16.2.4→20.0.6, the normalizer was rewritten to bucket on `period` and derive provider
**per-row from the model name** (one v20 daily row can mix agents), and — the headline —
the brief's deferred **Codex+Gemini data arrived for free behind the seam, zero server
change** ([[notes/2026-06-06-ccusage-multi-agent]]). Same phase: **first light** on the
CYD — daemon→server→board proven end to end with a real number on the desk. Phase 7 made
the panel *look designed* (the locked "C2 · Daily Rate" system — 1bpp Silkscreen fonts,
size hierarchy, color-coded agents, tokens/day graph) and added tap-to-cycle timeframe
tabs over a live additive contract (`timeframes`/`daily`/`last_used`). Phase 8 turned it
into something distributable: the daemon as a single compiled binary, the server deployed
to a VM behind a public HTTPS URL, an unauthenticated `/health` in front of the bearer
gate. Phase 9 hardened that public surface — firmware speaks **HTTPS** (`WiFiClientSecure`,
scheme-detected), the repo was audited and **open-sourced** (every secret/domain/IP/org
redacted, MIT + bundled OFL font license), architecture doc brought current. Two follow-up
chores on `main`: a one-command daemon installer and the port move to 3410.

**Patterns (cite the evidence).**
- **The phase-1 seams paid off in production, not just in tests.** The 1–5 retro *predicted*
  3-year-fit ("a new provider, zero aggregation change"); phase 6 is that prediction
  **validated against reality** — Codex/Gemini flowed in with zero core change because
  [[decisions/0004-ingest-dedup-model]] kept provider/model as open strings and phase 5
  built the collector registry. Early architectural discipline kept compounding.
- **…but one phase-1 discipline went the other way.** The host-testable firmware core
  (ADR 0007) was a *"kept"* win in the 1–5 retro. Phase 7's design ambition rewrote
  `main.cpp` standalone, abandoning `usage_state.h`, so the new poll/`fillTf` JSON parse
  path has **no off-device test**. Named in the P7 build-log and three times in
  [[improvements]] as the top cleanup — still open. Disciplines erode under pressure
  exactly where they're not enforced.
- **Zero new `learnings.md` entries across 6–9** (vs fourteen across 1–5). Not a review
  lapse — a **work-type shift**. Phases 1–5 wrote to the dedup store (where the
  high-severity Codex catches lived); 6–9 were integration/ops/packaging (pin bump,
  binaries, deploy config, TLS, redaction). The verification grain moved with it: from
  "Codex finds a silent overwrite" to "**first light** on real hardware," "leak re-scan
  clean," "binary boots and exits clean on SIGTERM." Worth naming so the quiet review log
  isn't misread as either complacency or completeness.
- **Reality intruded physically, the way fixtures never do.** `upload_speed 921600→460800`
  (the CYD's USB-serial adapter choked on the default), an **on-device photo** used to fix
  exact pixel spacing, flash at 87% capacity, "first light" as the actual gate. The
  hardware half — *deliberately batched to the end* in the 1–5 retro's open threads — is
  where this whole arc lived, and the batching held: the board arrived and it just came up.

**Kept (reinforce).**
- **Batching the hardware gate to the end worked.** The biggest open thread of the 1–5
  retro was "all visual/hardware gates pending one board bring-up." Phase 6 brought the
  board up and the full chain rendered a real number first try. Deferring physical
  verification until the board was on USB was correct sequencing, not procrastination.
- **"Flash the winner, not every guess"** (P7) — iterate design in disposable HTML mockups
  with real data, flash a *static* version, fix spacing from an on-device photo, *then*
  wire it live. Cheap iteration off-device; the expensive flash only for the chosen
  direction. Keep this as the firmware-UI method.
- **Open-source prep was an audited gate, not a checkbox** (P9): every tracked file
  scanned, domain/IP/org/system-name/MAC/tunnel-id redacted, re-scan clean, the embedded
  font's OFL license bundled. Security hygiene treated as a verifiable gate.
- **Additive-contract discipline carried into post-release** — P7 grew `/usage/summary`
  with `timeframes`/`daily`/`last_used` additively (same never-break-the-contract move as
  P2/P3), so the firmware upgrade and the server upgrade stayed independent.

**Improve (process).**
- **Enforce ADR 0007 with a gate check.** A guard that fails the gate when firmware parses
  JSON outside a host-compiled core would have caught the P7 regression at build time
  instead of leaving it open for four landings. The general rule: *an architectural
  discipline you actually rely on needs an automated tripwire — a prose ADR is a wish.*
- **Each phase opens by triaging the prior phase's "deferred / known gaps."** The firmware
  core, `last_used=null`, and per-tab calibration all carried forward *silently* 7→8→9→
  chores. Deferrals are healthy (charter-safe); a deferral nobody revisits becomes
  invisible debt. Make "keep-deferred (why) vs do-now" an explicit first step of the next
  build.
- **Features get phases; only true chores skip.** The one-command installer (a 166-line
  service-install script — a real distribution feature) landed straight on `main` with no
  phase/build-log entry. Minor, and the port move genuinely is a chore — but the phase
  discipline relaxed slightly once OSS-prep "finished" the plan. Name the line.

**Open threads (carry forward).**
- **Firmware host-testable core (ADR 0007) still regressed** — top cleanup; extract the
  P7 parse into a host-compiled core or delete the now-dead `usage_state.h`.
- **TLS defaults to `setInsecure()`** — encrypted but *unauthenticated*, so a MITM can
  capture the bearer token over the open internet **right now**. Pin Cloudflare's root in
  `config.h` `API_ROOT_CA`, or embed the Mozilla CA bundle (`setCACertBundle`, needs an
  embed step). The one open thread with real teeth.
- **`last_used` is null in practice** — v20 session `activity_at` not populating; footer
  falls back. Find where v20 exposes session activity or derive from the daily series.
- **Tabs only cycle** (tap-anywhere via PENIRQ); per-tab tapping needs touch calibration.
- **Producer-bucket TZ limit** is now the *sole* justification for a direct-parse collector
  (the Codex-data half closed upstream in P6) — worth doing, not urgent.
- **Deploy needs two manual steps to actually run:** push the (private) GitHub repo for the
  VM to clone, and set the Doppler `USAGE_AGENT_BEARER_TOKEN` (+ optional budget).
- gitleaks still not installed locally (focused fallback scan in use).

## 2026-06-06 — Retro (phases 1–5, full build)

**Shipped.** A self-hosted desk panel for live AI-coding usage, built thinnest-first
and hardened outward. Phase 1 proved the brief's stated hard part — cross-machine
aggregation — end to end: a ccusage daemon → bearer-auth Bun+SQLite ingest with a
dedup-upsert → one combined token number, with the granular (model × token-category)
schema laid down on day one. Phase 2 grew that into the real dashboard (v2 contract:
per-provider/per-machine/session/month, honest staleness) behind an additive contract
version. Phase 3 turned cost into an instrument (own price table, projection, budget,
honest `unpriced_tokens`) — and needed **no migration** because phase 1 stored the
granularity. Phase 4 made it feel alive (burn sparkline from append-only deltas,
active-machine, a bounded firmware ticker) without lying about un-confirmed numbers.
Phase 5 made good on 3-year-fit (a new provider through the collector seam, zero
aggregation change) and turned it into something that runs unattended (ops smoke from
documented commands, retention, launchd/systemd). The firmware stayed dumb and
host-tested throughout.

**Patterns (cite the learnings).**
- **The deduped store is where the bugs live.** Five of the high/most-significant
  review catches were all one class — *what does a write to the dedup key silently
  collide with or overwrite?*: destructive floor-to-0 (P1), received_at-must-govern
  (P1), most-recent-by-activity-not-arrival (P2), append-only-by-schema (P4),
  reject-duplicate-providers (P5). The brief named aggregation the hard part; the build
  confirmed it every single phase.
- **Weak tests that pass the happy path but not the regression** — the most recurring
  *review* finding: one-row fixtures can't catch a 4× dedup error (P2/P3), totals don't
  catch a reversed sparkline (P4), a line-based grep misses multiline SQL (P1), a
  hand-built stand-in skips the real registry (P5). Every fix was "test the shape
  production emits / the real path / exact positions / the bypass."
- **Honesty as a design constraint, recurring by design.** Never-lie-about-freshness
  (P2 stale + age), unknown-model-≠-$0 (P3), name-the-TZ-limit-don't-fake-precision
  (P2/P3), bounded-ticker-never-above-confirmed (P4). The product ethos became a review
  lens.
- **Defaults that silently disable a safeguard** — reject-not-clamp (P1), anchored
  matching (P3), fail-fast retention (P5). Malformed input must fail loud.

**Kept (reinforce).**
- **Two phase-1 bets compounded all the way down:** the host-testable firmware core
  ([[decisions/0007-firmware-host-testable-core]]) gave every firmware phase a real
  off-device gate (state matrix → panel classify → ticker bounds → sparkline gaps), and
  the granular-from-day-1 schema ([[decisions/0004-ingest-dedup-model]]) made phase-3
  pricing a no-migration drop-in exactly as predicted. Early architectural discipline
  paid compound interest.
- **The adversarial Codex pass was load-bearing, not ceremony** — it found a
  high-severity issue in 4 of 5 phases that the green gate had missed.
- **Real-data cross-checks each phase** (running real ccusage) verified anchored
  pricing, `activity_at`, and v2 rollups against reality, not just fixtures.

**Improve (process).**
- **Add a "dedup-store write" checklist to forge-build.** Before shipping a phase that
  writes to or aggregates the deduped store, answer in the diff: (a) what new collisions
  does this key admit? (b) what does a malformed/duplicate/again input do? (c) does "most
  recent / latest" order by a real timestamp, not arrival? Four high-severity catches
  were this class — they belong at build time, not review.
- **Make "test the regression, not the happy path" a build-time question.** For each new
  test, name the realistic regression that would still pass it (4× dedup, reversed
  series, the unused path). If none is named, the test is probably too weak.

**Open threads.**
- **Hardware/visual gates for all phases are pending one board bring-up** — the live
  A→B update, tile states/desaturated-photo legibility, cost tile, and the unattended
  full-day run. Deliberately batched to the end (USB board now available).
- **~~The Codex data source is still stubbed~~ — RESOLVED 2026-06-06.** ccusage went
  multi-agent and now reports `claude` + `codex` + `gemini` natively, with zero core
  change ([[notes/2026-06-06-ccusage-multi-agent]]). The seam paid off; the biggest
  functional gap closed at the source.
- **The producer-bucket timezone limit** is now load-bearing across month/projection/
  budget. It used to be bundled with the Codex thread; that thread is gone, so this now
  stands alone as the *sole* remaining justification for a direct-parse collector (raw
  per-event timestamps) — worth doing, but no longer urgent.
- gitleaks not installed locally (fallback scan in use); pricing is a flat-rate estimate.
