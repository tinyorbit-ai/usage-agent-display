# 0012 — Panel visual system v2: pixel font + timeframe tabs

Part of [[../index]]. Status: **accepted** (2026-06-06, phase 7). Supersedes the
look (not the principles) of [[0008-display-design-system]].

## Context

The phase 1–4 firmware rendered the metric hierarchy correctly but looked crude on the
real CYD: plain gray LVGL labels, raw 10-digit token counts, no color or hierarchy. A
polished mockup (`system-overview.html`) set the target aesthetic. Iterating directly on
the device was slow (each guess = a 30s flash, and I render blind), and the panel needed
a way to show more than one time window.

## Decision

1. **Design in HTML, flash the winner.** Mock candidate screens at true 320×240 with
   real data; pick one; flash a *static* build of it; use an on-device **photo** to fix
   exact spacing; only then wire live data. (Several blind flash cycles taught this.)
2. **Crisp 1bpp pixel font (Silkscreen), with a size hierarchy.** LVGL's anti-aliased
   Montserrat reads as "fuzzy/pixelated" on a 143 ppi panel; a 1-bit pixel font has no
   AA fringe and reads sharp. Silkscreen is *wide*, so a strict size hierarchy
   (hero 40 > cost 24 > agents 16 > meta 8 = its native size) is required to avoid
   collisions. Hero uses **Regular** — Bold's "4" counter fills in at 40px.
3. **Timeframe tabs, tap-to-cycle.** TODAY / 30D / ALL; a tap *anywhere* advances via the
   XPT2046 **PENIRQ** line (GPIO36, active-low) — no touch-coordinate calibration, so it
   works first try. Per-tab tapping is deferred to a calibration pass.
4. **Server owns the timeframes.** `/usage/summary` gains `timeframes` (today/30d/all:
   tokens + cost + active-day count + per-provider), a 14-point `daily` series, and
   `last_used` — additive, computed from the canonical daily rows by bucket-date range.

## Why

- The HTML-first loop turns blind 30s flash cycles into instant visual iteration; the
  photo step closes the metric gap between browser and LVGL bitmap rendering.
- Pixel-perfect 1bpp matches the hardware's nature instead of fighting its DPI.
- PENIRQ cycling is robust where blind coordinate calibration is not — ship the reliable
  thing, refine later.
- Per-timeframe aggregation belongs server-side (same bet as [[architecture]]): the CYD
  stays dumb, just switching between datasets it already holds.

## Alternatives

- **Anti-aliased vector font (Montserrat/VT323).** Montserrat looked fuzzy; VT323 (a
  narrow terminal pixel font) fixed spacing but its look was rejected. Silkscreen won.
- **Coordinate touch + per-tab hit-testing.** Nicer UX, but needs calibration I can't
  tune blind. Deferred, not dropped.
- **Compute timeframes on the firmware.** It only receives aggregates; it can't slice by
  date. Server-side is the only honest option.

## Consequences

- A bundled font (Silkscreen, OFL) ships in the repo — attribution in
  `firmware/vendor/fonts/NOTICE.md`; fonts regenerate via `lv_font_conv`.
- `main.cpp` was rewritten standalone and **no longer uses `usage_state.h`**, so the new
  fetch/parse path is not yet host-tested — a regression against
  [[0007-firmware-host-testable-core]] tracked in [[../improvements]].
- The flash budget is back to ~87% (networking + four pixel fonts); still fits.
- **Input model superseded (phase 11, [[0015-touch-input-stack]]):** the tap-to-cycle
  PENIRQ model (decision 3 above) is replaced by DIRECT-TAP — real XPT2046 coordinates
  routed through the host-tested core select a specific tab. The deferred "per-tab
  tapping needs calibration" alternative is now the shipped path.
