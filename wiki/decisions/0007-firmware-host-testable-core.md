# 0007 — Firmware testability: a pure host-compilable core, no emulator

Part of [[../index]]. Status: **accepted** (2026-06-05, phase 1 build).

## Context

The phase-1 gate requires the firmware's fetch/parse handling to be **unit-tested
off-device against a state matrix** (HTTP 200 / 401 / 500 / timeout / disconnect /
truncated / oversized / missing `totals.tokens`) so a regression fails CI without a
board attached. Arduino/LVGL/WiFi code can't run on the host, and an ESP32 emulator is
heavy ceremony for a desk panel. We needed real test coverage of the actual decision
logic without flashing hardware.

## Decision

Split the firmware into two parts:

1. **`src/usage_state.h`** — a pure C++ core (the fetch→parse→display-state decision)
   with **zero** Arduino/LVGL/WiFi includes, depending only on ArduinoJson (which is
   host-compilable). It is the single source of truth for "given a fetch outcome, what
   should the screen show".
2. **`src/main.cpp`** — the thin I/O shell (WiFi, HTTPClient, the LVGL label) that
   feeds outcomes into the core and renders its result.

The off-device test (`test/native/test_usage_state.cpp`) compiles the core with
`clang++` against a **vendored ArduinoJson single-header** and runs the full state
matrix. `firmware/test/run-native.ts` is the automated gate step.

## Why

- **Tests the real code**, not a reimplementation — `main.cpp` and the test exercise
  the *same* `usage_state.h`, so the gate actually protects on-device behavior.
- **No emulator / no board in CI** — `clang++` is already present; the test is
  milliseconds and deterministic.
- **Forces a clean seam** — keeping the core dependency-free is good firmware design
  anyway (the renderer and the decision logic shouldn't be tangled).

## Alternatives

- **Wokwi / QEMU ESP32 emulation.** Closest to real, but slow, flaky, and heavy to
  wire into a gate for one panel. Rejected for the automated gate (still fine for
  manual pre-flash sanity).
- **Re-model the state machine in TypeScript** and test that. Rejected: it would test a
  copy, not the firmware — drift between the two would pass CI while the device breaks.
- **Only manual on-device testing.** Rejected: the gate explicitly wants an automated,
  boardless check; the A→B live update remains the *manual* hardware half.

## Consequences

- ArduinoJson is vendored at `firmware/vendor/ArduinoJson.h` (host test) and pinned in
  `platformio.ini` `lib_deps` (device build) — two sources, same version (7.2.1); keep
  them in lockstep on upgrade.
- New firmware logic that needs off-device coverage goes in (or behind) `usage_state.h`;
  `main.cpp` stays I/O-only so it never needs the board to be tested.
