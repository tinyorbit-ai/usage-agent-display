# 2026-06-06 — LVGL bar chart crashed at boot: point_count == 1 ÷ by zero

Part of [[../index]]. Phase 12 (agent filter). An instructive failure: every automated
check was green, the device build linked, the HTML mock looked right — and the board
still boot-looped on first flash.

## Timeline

1. Phase 12 reworked `updateGraph()` to redraw the bar chart deterministically from the
   selected agent's series: `point_count = n > 0 ? n : 1`, then write each bar by index.
2. All three host suites passed; `pio run` linked clean at 87.5% flash; the 320×240 HTML
   mock of the new top bar verified spacing.
3. First flash to the CYD → **`Guru Meditation Error: IntegerDivideByZero`**, continuous
   reboot loop. Nothing on screen.
4. `addr2line` on the backtrace → `draw_series_bar` at `lvgl/.../lv_chart.c:1228`:
   `x_act = (w - block_w) * i / (chart->point_cnt - 1)`.

## Root cause

At boot, `renderActive()` runs once in `setup()` **before the first poll**, so
`g_panel.dailyN == 0` → `updateGraph()` set the bar chart's `point_count` to **1**. LVGL's
bar renderer spaces columns with `... / (point_cnt - 1)` — with `point_cnt == 1` that is a
divide by zero on the very first redraw. The phase-7 code never hit this because its
`updateGraph()` early-returned when `dailyN == 0`, leaving the chart at its
constructed-time count of 14; phase 12 made the redraw unconditional and shrank the count.

## The fix

`point_count` is clamped to a **minimum of 2** (`n >= 2 ? n : 2`); points beyond the
series are written `0`. An empty axis now draws two flat zero bars instead of crashing.

## What it demonstrates

- **A green host suite + a clean build is not "it works on the device."** The bug lived
  entirely in the LVGL render path — un-host-testable (no LVGL on the host) and invisible
  to a compile. The locked **hardware gate** (mandatory on-device confirmation) is the only
  thing that could have caught it, and did. This is why firmware phases carry a hardware
  half even when the software gate is green.
- **A boot-time render runs with EMPTY data.** Any "redraw from current state" path must be
  correct for the zero/empty case that exists before the first successful fetch — the most
  common first thing a device does is render nothing.
- **Third-party widgets have arithmetic preconditions.** `point_cnt - 1` as a divisor is an
  implicit "≥ 2 points" contract; treat library draw routines as having domain limits and
  keep inputs inside them. Recorded in [[../learnings]].
