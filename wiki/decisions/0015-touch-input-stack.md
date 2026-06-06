# 0015 — Touch input stack: XPT2046 on dedicated SPI + baked calibration

Part of [[../index]]. Status: **accepted** (2026-06-06). Implements the direct-tap
mechanism decided in [[0014-agent-filter-direct-tap]]; amends the input model of
[[0012-panel-visual-system-v2]] (PENIRQ any-tap-cycle → coordinate read).

## Context

[[0014-agent-filter-direct-tap]] requires reading *where* a tap lands, for two tab
groups. The firmware today only `digitalRead`s the PENIRQ line (GPIO36) — touched or
not. On the ESP32-2432S028R the XPT2046 touch controller is on a **separate SPI bus
from the display** (touch: CLK 25 / MOSI 32 / MISO 39 / CS 33 / IRQ 36; display:
SCLK 14 / MOSI 13 / MISO 12 / CS 15, per `platformio.ini` build flags). No `TOUCH_CS`
is configured for TFT_eSPI. So the display driver cannot drive touch without bus-sharing
workarounds — a known-fragile CYD path.

## Decision

1. **`XPT2046_Touchscreen` on a dedicated `SPIClass` (HSPI).** Add it as a pinned
   `lib_deps` entry; instantiate on the touch pins above. This is the well-trodden CYD
   approach and keeps the display SPI untouched.
2. **Baked calibration constants — in COMMITTED board config, not the secrets header.**
   Measure the raw→screen affine mapping once and hard-code the constants in a
   **committed** board-config header (`touch_config.h`) or `platformio.ini` build_flags.
   They are not secrets (WiFi creds + bearer token stay in the gitignored `config.h`);
   committing them lets the **host tests reference the same constants** and guarantees a
   fresh checkout builds with a known calibration. Single-unit constants, documented as
   such. No interactive calibration flow, no NVS persistence.
3. **Generous hit-boxes + debounce.** Each tab's tap target is a bounding box padded
   well beyond its drawn pixels (the ~37×22px chips are small on resistive touch);
   taps in gaps route to "none". Reuse the existing PENIRQ falling-edge debounce.
4. **Pure, host-tested routing.** A `routeTap(x, y) → {none | time i | agent j}` function
   and the raw→screen transform live in the host-compilable core
   ([[0007-firmware-host-testable-core]]) and are unit-tested off-device. Only the SPI
   read itself is device-only.

## Why

- Touch and display on separate buses is the physical reality of this board; a
  dedicated-bus library is the path that actually works, not a workaround.
- Single personal device → baked constants are the simplest thing that can work; a
  calibration UI is surface this device doesn't need.
- Padded hit-boxes turn the small-target risk (the brief's open worry) into a tuning
  constant, not a redesign.
- Keeping routing pure preserves the project's host-testable-core discipline: the
  decision logic is proven without a flash cycle; only the sensor read is on-device.

## Alternatives

- **`XPT2046_Touchscreen` + on-boot interactive calibration (NVS-persisted):** more
  robust across boards/chip replacements, but adds a calibration flow + flash
  persistence — moving parts a single-device build doesn't earn. Revisit if it ever
  runs on multiple boards. Rejected for now.
- **TFT_eSPI `getTouch()`:** no new dependency, but touch is on different pins than the
  display SPI here → bus-sharing hacks, known-fragile on the CYD. Marginal dep savings
  for real risk. Rejected.
- **Keep PENIRQ-only, coarse two-zone cycling:** cheapest, but cannot direct-tap a
  specific chip — already rejected in [[0014-agent-filter-direct-tap]].

## Consequences

- New pinned dependency (`XPT2046_Touchscreen`) — within supply-chain discipline
  (pinned + lockfiled).
- Adds calibration constants to a committed board-config header (not the gitignored
  secrets file, so host tests share them); a board swap means re-measuring them
  (documented, acceptable for a single device).
- `routeTap` + the raw→screen transform live in the host-compilable core and the native
  test suite compiles them — closing the P7 host-testable-core regression with a tripwire
  rather than prose ([[learnings]] 2026-06-06).
- The PENIRQ any-tap-cycle path is removed; time tabs become direct-tap (a visible
  behavior change landing in the touch-foundation phase, before the agent UI).
- The host test suite gains routing + transform tests; device verification is limited
  to "the tap I made hit the chip I aimed at".
