# 0008 — Display design system: type scale, palette, state→signal mapping

Part of [[../index]]. Status: **accepted** (2026-06-05, phase 2). *(The plan called
this "ADR 0006"; 0006/0007 were taken during phase 1's build, so it is 0008.)*

## Context

Phase 2 renders the real dashboard on a 2.8" 320×240 panel, glanceable across the
room. The brief fixes the metric hierarchy (tokens > cost > provider > machine >
session > month > last-sync) and demands that every state be distinguishable
**without relying on color alone** (verified by a desaturated photo) and that
staleness be **honest** (never claim fresher-than-true). We needed a small, fixed
design system so layout stops being re-litigated each phase.

## Decision

**Type scale (LVGL Montserrat):** hero token number at 28 px; everything else at
14 px. The hero is the only large element — it wins the across-the-room read.

**Layout (top→bottom = priority):** status chip (state signal) · hero tokens · cost ·
per-provider line · per-machine list · footer (session · month-to-date · last-sync).

**Palette:** black background; white hero when live; grey (`0x888888`/`0xBBBBBB`) for
supporting text; dimmed (`0x555555`) for last-good-while-disconnected; muted
amber-grey (`0x777755`) for all-stale.

**State → second (non-color) signal.** Each {@link PanelKind} carries an icon/word
prefix so color is never the only cue:

| PanelKind | Non-color signal | Hero |
|---|---|---|
| Connecting | `…` connecting | dim |
| Empty | "no data yet" | dim |
| Live | `#` live | white |
| Partial | `~` partial | white |
| AllStale | `o STALE` | muted |
| Disconnected | `! OFFLINE` | dimmed last-good |

**Staleness progression:** fresh (normal) → stale (`stale:true`, threshold
`STALE_AFTER_SECONDS`) shown dimmed **with an explicit "Nm/Ns" age** → all-stale/
disconnected shown dimmed with an explicit OFFLINE/STALE word. The age text, not hue,
carries the truth.

## Why

- **Color-independent by construction** — the icon/word prefix + explicit age means a
  colorblind viewer or a desaturated photo still distinguishes every state.
- **One large element** — a single 28 px hero is the cheapest way to win legibility on
  a tiny panel; everything else is reference detail at a glance distance.
- **Honest freshness** — showing the numeric age (not just a color) makes "fresher than
  true" impossible; the panel literally prints how old the data is.

## Alternatives

- **Color-only state signaling** (green/amber/red). Rejected: fails the desaturated-
  photo requirement and excludes colorblind reading.
- **Multiple font sizes per tier.** Rejected: more visual noise, harder to keep the
  hero dominant; two sizes is enough.
- **Server-rendered layout image.** Already rejected in [[0001-shape-daemon-api-cyd]]
  (kills self-contained degrade + future animation).

## Consequences

- `usage_state.h` owns `PanelKind` and `classifyPanel` (host-tested); `main.cpp` maps
  each kind to its chip/color per this table. Changing the design system is editing
  this ADR + the render map, not the decision logic.
- `STALE_AFTER_SECONDS` is server config (drives `stale` in the summary); the panel
  trusts the flag and additionally prints the age.
- Phase 4's "live" feel (ticking/sparkline/glow) layers onto this system without
  changing the hierarchy or the state→signal mapping.
