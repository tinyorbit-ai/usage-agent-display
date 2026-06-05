# 0001 — Shape: per-machine daemon → central Bun+SQLite API → CYD polls JSON

Part of [[../index]]. Status: **accepted** (2026-06-05, at discovery lock).

## Context

The brief ([[../brief]]) fixes a CYD desk panel showing aggregated Claude Code +
Codex usage across multiple machines, self-hosted, single-tenant, display-only, with
a "live mission-control" feel and tokens as the hero metric. The usage data lives in
local logs on each machine and is read via `ccusage --json`. We had to choose how the
data flows from N machines to one small screen.

## Decision

Three components:
1. **Per-machine daemon** (Bun/TypeScript) — shells `ccusage --json` for Claude Code +
   Codex, tags snapshots with machine identity + timestamp, POSTs normalized payloads
   to the central API.
2. **Central service** (Bun/TypeScript + SQLite) — ingests snapshots, dedups, stores
   raw + rollups, computes dashboard metrics, exposes a compact `GET /usage/summary`.
3. **CYD firmware** (C++ / LVGL / TFT_eSPI) — polls `/usage/summary` and **renders the
   tiles itself**.

## Why

- **Polling JSON keeps the firmware self-contained and robust.** The CYD owns its
  layout and degrades gracefully (show last-good + stale "last sync age") when the
  network blips — research's "polling + cache" pattern.
- **No broker dependency.** MQTT would add an always-on broker to self-host for one
  screen; not worth it at this scope.
- **Bun + SQLite** is zero-ops for a single-tenant self-hosted box — one file, one
  runtime, daemon and API share a language.
- **`ccusage` as the parser** means the daemon doesn't need to understand evolving
  Claude/Codex log formats — it forwards normalized output. (ccusage's Codex support
  is beta; treat it as observability, not a billing source of truth.)
- Leaves room to make "live" real later via fast polling or SSE without changing the
  component boundaries.

## Alternatives

- **CYD blits a server-rendered PNG/layout card** (electronic-shelf-label pattern).
  Pro: trivial firmware, iterate UI server-side without reflashing. Con: backend
  renders pixels, the panel can't degrade or animate on its own, and a "live ticking"
  feel becomes a server-push problem. Rejected for this scope.
- **MQTT push to the CYD.** Pro: most genuinely live. Con: broker dependency to
  self-host and operate for a single screen. Deferred — revisit only if fast polling
  can't deliver the live feel.

## Consequences

- The `/usage/summary` payload contract becomes the firmware's stable interface — it
  must carry enough for tokens (hero), cost + projection, provider split, per-machine,
  and an honest `last_sync` age.
- Aggregation correctness (dedup, clock skew, freshness) lives **server-side** — the
  CYD trusts the summary. That's the main hard part (see brief).
- The ingest schema must stay provider-agnostic (3-year fit: add Cursor/Gemini as new
  collectors, not a rewrite).
- "Live" is a deferred capability layered on the same boundaries, not a different
  architecture.
