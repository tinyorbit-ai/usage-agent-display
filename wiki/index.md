# usage-agent-display — Engineering Wiki

Obsidian-style wiki. **Source of truth for the _why_.** Code says what; this says why.

## What this is (one line)

A Cheap Yellow Display desk panel showing my live, aggregated Claude Code + Codex token usage (and cost) across all my machines.

## Map of content

- [[brief]] — what we're building, for whom, the feel, non-goals
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

### Incident notes

_None yet — root-cause writeups land here as they happen._

## Reading order

1. [[brief]] — what and why
2. [[plan]] — how, in phases
3. [[architecture]] — the shape of it
