# Firmware — ESP32-2432S028R ("Cheap Yellow Display")

Phase-1 firmware: join WiFi, poll `GET /usage/summary` with the bearer token, and
render the combined token total in one LVGL label. Board + toolchain rationale:
[ADR 0005](../wiki/decisions/0005-cyd-board-and-toolchain.md).

## What's testable off-device (and is, in CI)

All fetch/parse/state logic lives in [`src/usage_state.h`](src/usage_state.h) with
**zero** Arduino/LVGL/WiFi dependencies, so it compiles and runs on the host. The
state matrix — HTTP 200 / 401 / 500 / timeout / disconnect / truncated / oversized /
missing `totals.tokens` — is exercised by [`test/native`](test/native), compiled with
`clang++` against the vendored ArduinoJson header:

```sh
bun run firmware/test/run-native.ts     # the automated firmware gate
```

`main.cpp` is the thin I/O shell (WiFi, HTTP, the LVGL label) around that core.

## Build & flash to the board

Requires [PlatformIO](https://platformio.org). The first build pulls the pinned
libraries from `platformio.ini` (LVGL 8.4, TFT_eSPI, ArduinoJson 7.2.1).

```sh
cp firmware/src/config.h.example firmware/src/config.h   # then fill in WiFi + token
cd firmware
pio run -e cyd -t upload         # build + flash
pio device monitor               # serial @ 115200
```

`config.h` is **gitignored** — it holds your WiFi credentials and the bearer token.
Only `config.h.example` is committed.

### Display states

| State | When | Shows |
|---|---|---|
| `connecting…` (grey) | boot, before first successful poll | placeholder text |
| token number (white) | last poll succeeded | the live combined total, updates each poll |
| token number (dim) | a poll failed (network/HTTP/parse) | the **last-good** value, never blank/garbage |

The on-device **A→B live-update** check (change the backend value, watch the panel
refresh within two poll intervals without rebooting) is the manual hardware half of
the phase-1 gate, recorded in [`wiki/build-log.md`](../wiki/build-log.md).
