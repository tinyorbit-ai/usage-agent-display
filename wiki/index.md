# usage-agent-display — Engineering Wiki

Obsidian-style wiki. **Source of truth for the _why_.** Code says what; this says why.

## What this is (one line)

A Cheap Yellow Display desk panel showing my live, aggregated Claude Code + Codex token usage (and cost) across all my machines.

## Map of content

- [[brief]] — what we're building, for whom, the feel, non-goals
- [[brief-agent-filter]] — feature brief: two-dimensional time × agent tabs (direct-tap filter)
- [[plan]] — the phased build plan; each phase has a verifiable gate + branch
- [[architecture]] — the 30-second version (filled in as phases land)
- [[build-log]] — one entry per phase: the gate met before merge
- [[learnings]] — review lessons + the rule-to-remember (running)
- [[retro]] — build retrospectives, synthesis across phases (running)
- [[improvements]] — what I'd do with more time / deliberate scope cuts (running)

### Decisions (ADRs)

- [[decisions/0001-shape-daemon-api-cyd]] — per-machine daemon → central Bun+SQLite API → CYD polls JSON and renders tiles
- [[decisions/0002-ccusage-invocation]] — pin ccusage as a daemon dependency, not a global install
- [[decisions/0003-daemon-auth-bearer]] — shared bearer token for daemon → API
- [[decisions/0004-ingest-dedup-model]] — (machine, provider, type, bucket) upsert; provider-agnostic schema
- [[decisions/0005-cyd-board-and-toolchain]] — ESP32-2432S028R + PlatformIO/LVGL/TFT_eSPI
- [[decisions/0006-cost-attribution-grain]] — replicate cost per category row, de-dup per model/bucket when summing
- [[decisions/0007-firmware-host-testable-core]] — pure host-compilable firmware core, no emulator
- [[decisions/0008-display-design-system]] — type scale, palette, state→non-color-signal mapping (phase 2)
- [[decisions/0009-pricing-source-and-projection]] — own price table over granular rows; unknown→unpriced; linear projection (phase 3)
- [[decisions/0010-live-transport]] — fast poll + bounded firmware interpolation, not SSE (phase 4)
- [[decisions/0011-retention-policy]] — prune snapshots by last-write age, server-self-pruned (phase 5)
- [[decisions/0012-panel-visual-system-v2]] — pixel font + tap-to-cycle timeframe tabs + per-timeframe contract (phase 7)
- [[decisions/0013-distribution-and-deployment]] — compiled daemon binary + self-host server deploy + bearer-gated public URL (phase 8)
- [[decisions/0014-agent-filter-direct-tap]] — direct-tap time × agent tabs + full-readout per-agent filter; amends 0012's tap-to-cycle
- [[decisions/0015-touch-input-stack]] — XPT2046 on dedicated SPI + baked calibration; pure host-tested tap routing (phases 11–12)

### Incident notes

- [[notes/2026-06-06-ccusage-multi-agent]] — ccusage went multi-agent; the Codex
  data-source gap closed itself (zero core change)

## Reading order

1. [[brief]] — what and why
2. [[plan]] — how, in phases
3. [[architecture]] — the shape of it
