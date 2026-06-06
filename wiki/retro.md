# Retrospectives

Part of [[index]]. Running synthesis appended by `forge-retro`. Newest on top. One
entry per retro: what shipped, recurring patterns, what went well, what to improve.

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
