// ui_input.h — the firmware's TOUCH ROUTING core (phase 11), with ZERO Arduino, LVGL,
// or SPI dependencies so it compiles and is unit-tested on the host (see
// firmware/test/native/test_ui_input.cpp). main.cpp owns the XPT2046 SPI read; this
// owns every decision around it: the raw→screen calibration transform, hit-testing a
// tap to a control, PENIRQ-gated sampling, and debounce/re-arm. ADR 0015.
//
// Why a host-compilable core (the P7 tripwire — see wiki/learnings.md): the
// host-testable-core discipline silently regressed once a phase rewrote main.cpp
// standalone. So this logic lives here, the native suite COMPILES it
// (scripts/check-firmware-core.ts enforces that the test includes this header and that
// main.cpp never redefines routeTap), and only the SPI sensor read stays on-device.
#pragma once

#include <stdint.h>
#include <stddef.h>

namespace ui {

// Landscape screen geometry (the panel runs tft.setRotation(1)) — LVGL addresses
// pixels (0,0)..(kScreenW-1, kScreenH-1).
static const int kScreenW = 320;
static const int kScreenH = 240;

// Which control a tap resolved to. Phase 11 ships only the time tabs; phase 12 adds
// agent chips as a second kind — which is why this is a (kind, index) pair, not a bare
// tab number, so the disjoint two-group routing extends without reshaping callers.
enum class TapKind {
  None,     // hit no control: a gap, outside the bar, or an out-of-range raw read
  TimeTab,  // index 0..2 → TODAY / 30D / ALL
};

struct Tap {
  TapKind kind = TapKind::None;
  int index = -1;
  // Explicit constructors so `Tap{kind, index}` compiles under the ESP32 toolchain's
  // older C++ standard too (default member initializers make this a non-aggregate there).
  Tap() = default;
  Tap(TapKind k, int i) : kind(k), index(i) {}
};

// An axis-aligned hit-box in LANDSCAPE screen pixels, INCLUSIVE of its edges, so a tap
// exactly on an edge resolves to the intended control (the generous-hit-box behavior
// resistive touch needs). The drawn pill is smaller; the hit-box is padded beyond the
// glyph for a finger.
struct HitBox {
  TapKind kind;
  int index;
  int x0, y0, x1, y1;  // inclusive bounds
};

// Raw→screen calibration. The XPT2046 reports 12-bit raw coordinates on its own two
// axes; under landscape rotation the screen X may derive from the raw Y axis and vice
// versa (swapXY), and either axis may be mirrored (encoded by min > max on that axis).
// rawXMin/rawXMax are the raw readings (on whichever source axis swapXY selects) that
// map to screen x=0 and x=kScreenW-1; likewise rawYMin/rawYMax for screen Y.
struct TouchCalibration {
  int rawXMin, rawXMax;          // raw reading → screen x = 0 and x = kScreenW-1
  int rawYMin, rawYMax;          // raw reading → screen y = 0 and y = kScreenH-1
  bool swapXY;                   // screen X derives from the raw Y axis (and vice versa)
  int rawValidMin, rawValidMax;  // a raw read outside this band is a rail / no-touch → reject
  int minPressure;               // XPT2046 z below this is no real contact → not a touch
};

// Timing for the touch gate (below).
struct TouchTiming {
  uint32_t releaseStableMs;  // PENIRQ must be released continuously this long to re-arm
};

// Round num/den to the nearest integer, ties away from zero, for ANY sign of den (a
// mirrored axis has a negative span). Pure integer math — no <cmath> on the host core.
inline long divRound(long num, long den) {
  if (den == 0) return 0;
  if (den < 0) { num = -num; den = -den; }
  const long half = den / 2;
  if (num >= 0) return (num + half) / den;
  return -(((-num) + half) / den);
}

// Map a single raw coordinate pair to landscape screen pixels. Returns false when the
// raw read is outside the valid band (rail / too-low pressure) so the caller treats it
// as "no tap" — never a wrapped or bogus pixel. Handles axis swap and mirroring; the
// result is clamped to the panel so a tap just outside the calibrated rectangle lands
// on the nearest edge rather than wrapping around.
inline bool rawToScreen(const TouchCalibration& cal, int rawX, int rawY, int& outX, int& outY) {
  if (rawX < cal.rawValidMin || rawX > cal.rawValidMax) return false;
  if (rawY < cal.rawValidMin || rawY > cal.rawValidMax) return false;

  const int srcX = cal.swapXY ? rawY : rawX;
  const int srcY = cal.swapXY ? rawX : rawY;

  const long spanX = (long)cal.rawXMax - cal.rawXMin;  // may be negative (mirrored)
  const long spanY = (long)cal.rawYMax - cal.rawYMin;
  if (spanX == 0 || spanY == 0) return false;  // degenerate calibration

  int sx = (int)divRound((long)(srcX - cal.rawXMin) * (kScreenW - 1), spanX);
  int sy = (int)divRound((long)(srcY - cal.rawYMin) * (kScreenH - 1), spanY);

  if (sx < 0) sx = 0; else if (sx > kScreenW - 1) sx = kScreenW - 1;
  if (sy < 0) sy = 0; else if (sy > kScreenH - 1) sy = kScreenH - 1;
  outX = sx;
  outY = sy;
  return true;
}

// Hit-test an already-mapped screen point against a hit-box table (first match wins).
inline Tap routeScreen(const HitBox* boxes, size_t n, int sx, int sy) {
  for (size_t i = 0; i < n; i++) {
    const HitBox& b = boxes[i];
    if (sx >= b.x0 && sx <= b.x1 && sy >= b.y0 && sy <= b.y1) return Tap{b.kind, b.index};
  }
  return Tap{TapKind::None, -1};
}

// Full path: a raw touch sample → the control it selects. An out-of-range raw read or a
// point in a gap/outside the bar yields TapKind::None.
inline Tap routeTap(const TouchCalibration& cal, const HitBox* boxes, size_t n, int rawX, int rawY) {
  int sx = 0, sy = 0;
  if (!rawToScreen(cal, rawX, rawY, sx, sy)) return Tap{TapKind::None, -1};
  return routeScreen(boxes, n, sx, sy);
}

// The debounced touch gate. Fed one sampled state per loop, it emits an accepted tap
// at most ONCE per press:
//   - A sample counts as a touch only when PENIRQ asserts AND the reported pressure
//     (rawZ) clears cal.minPressure — so a PENIRQ edge that returns stale x/y at z≈0
//     (the XPT2046 does this on a noisy/low-pressure edge) can neither route nor
//     consume a press (touch-gating + pressure validation).
//   - A tap is routed only on the rising edge of a valid touch while ARMED.
//   - While the press is held, nothing re-fires — including chatter that briefly drops
//     and re-asserts faster than releaseStableMs. A new tap is accepted only after the
//     touch is released and STABLE (no valid contact) for releaseStableMs (debounce +
//     no re-arm under a held press).
struct TouchGate {
  bool down = false;          // last sample was a valid touch (PENIRQ + pressure)
  bool armed = true;          // ready to accept a new tap
  bool inRelease = false;     // tracking a release window for re-arm
  uint32_t releaseStartMs = 0;
};

// Returns true and fills `out` exactly when a press is accepted as a real control tap.
// `penirq` is true when the line asserts touch (caller maps active-low to true); `rawZ`
// is the XPT2046 pressure reading for this sample (ignored when penirq is false).
inline bool touchGate(TouchGate& g, const TouchCalibration& cal, const HitBox* boxes, size_t n,
                      uint32_t nowMs, bool penirq, int rawX, int rawY, int rawZ,
                      const TouchTiming& timing, Tap& out) {
  const bool valid = penirq && rawZ >= cal.minPressure;
  if (valid) {
    if (!g.down) {            // rising edge of a press
      g.down = true;
      g.inRelease = false;
      if (g.armed) {
        g.armed = false;      // consume this press; no re-fire until a stable release
        const Tap t = routeTap(cal, boxes, n, rawX, rawY);
        if (t.kind != TapKind::None) {
          out = t;
          return true;
        }
      }
    }
    return false;             // held press: never re-fires
  }

  // Released.
  if (g.down) {               // falling edge: start the release window
    g.down = false;
    g.inRelease = true;
    g.releaseStartMs = nowMs;
  } else if (g.inRelease && !g.armed) {
    if ((uint32_t)(nowMs - g.releaseStartMs) >= timing.releaseStableMs) {
      g.armed = true;         // re-armed after a continuous, stable release
      g.inRelease = false;
    }
  }
  return false;
}

}  // namespace ui
