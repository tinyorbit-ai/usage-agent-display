# 0005 — CYD board & firmware toolchain: ESP32-2432S028R + PlatformIO/LVGL/TFT_eSPI

Part of [[../index]]. Status: **accepted** (2026-06-05, plan).

## Context

The brief fixes a Cheap Yellow Display with firmware in C++/LVGL/TFT_eSPI. The exact
board determines display/touch drivers and the pin map. The user confirmed the
hardware: **DIYmalls ESP32-2432S028R** — 2.8" 240×320 ILI9341 TFT, XPT2046 resistive
touch, single micro-USB. We also need a build/flash toolchain.

## Decision

Target the **ESP32-2432S028R** (ILI9341 + XPT2046, the canonical "CYD"). Build with
**PlatformIO** (Arduino framework) using **LVGL** for UI and **TFT_eSPI** as the
display driver, with the board's known pin map captured in a versioned config header.

## Why

- **Best-documented CYD path** — the overwhelming majority of CYD/LVGL examples and
  pin maps target exactly this board; least yak-shaving to first pixels.
- **PlatformIO over Arduino IDE** — reproducible, scriptable builds; pinned library
  versions in `platformio.ini`; fits the "verifiable gate" discipline (a build is a
  command, not a GUI click).
- **LVGL + TFT_eSPI** — LVGL gives the widgets/animation needed for the live
  mission-control feel (ticking labels, sparkline, glow) without hand-rolling a
  renderer; TFT_eSPI is the standard fast driver for this panel.

## Alternatives

- **ESPHome / Arduino-IDE** — lower ceiling for custom animated UI / harder to gate.
  Rejected.
- **ESP-IDF + LVGL (no Arduino)** — more control, much steeper setup; unnecessary for
  this board. Rejected.
- **3.5"/capacitive variants** — more pixels/nicer touch, but not the hardware on
  hand; the pin map is isolated in one config header so a swap is contained, not a
  rewrite.

## Consequences

- Board pin map + display rotation live in one firmware config header; swapping boards
  is changing that header, not the app.
- `platformio.ini` pins LVGL + TFT_eSPI versions; firmware build = `pio run` (the gate).
- Resistive touch (XPT2046) needs calibration — relevant only when touch navigation
  lands (display-only otherwise per non-goals); deferred until a touch phase.
