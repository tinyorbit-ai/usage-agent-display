// Off-device unit test of the firmware TOUCH ROUTING core (phase 11, ADR 0015). These
// are the pure host tests the phase-11 gate requires: routeTap hit-testing, the
// raw→screen transform incl. landscape rotation/axis-swap/mirror (4 corners + center),
// out-of-range rejection, PENIRQ touch-gating, and debounce / no-re-arm-under-held-press.
//
// It includes the routing header directly (the host-testable-core tripwire — see
// scripts/check-firmware-core.ts), so a regression in routing logic fails CI without a
// board attached. Compiled natively by firmware/test/run-native.ts (clang++).
#include "../../src/ui_input.h"
#include "../../src/touch_config.h"

#include <cstdio>

using namespace ui;

static int g_failures = 0;

static void check(const char* name, bool cond) {
  if (cond) {
    std::printf("  ok   %s\n", name);
  } else {
    std::printf("  FAIL %s\n", name);
    g_failures++;
  }
}

// A clean, non-swapped fixture with DISTINCT x/y ranges (1000 vs 2000) so a transform
// that swapped the axes maps corners to the wrong pixels and is caught.
static const TouchCalibration kFixA = {
    /* rawXMin */ 0, /* rawXMax */ 1000,
    /* rawYMin */ 0, /* rawYMax */ 2000,
    /* swapXY  */ false,
    /* rawValidMin */ -1, /* rawValidMax */ 4095,
    /* minPressure */ 1,
};

// A swap + Y-mirror fixture mirroring the real board's shape. Screen X derives from the
// raw Y axis (200..3800); screen Y derives from the raw X axis, MIRRORED (3800..200).
static const TouchCalibration kFixB = {
    /* rawXMin */ 200, /* rawXMax */ 3800,
    /* rawYMin */ 3800, /* rawYMax */ 200,
    /* swapXY  */ true,
    /* rawValidMin */ 120, /* rawValidMax */ 3975,
    /* minPressure */ 100,
};
static const int kZ = 400;  // a pressure reading comfortably above both fixtures' minPressure

static bool mapEq(const TouchCalibration& cal, int rawX, int rawY, int expX, int expY) {
  int sx = -1, sy = -1;
  if (!rawToScreen(cal, rawX, rawY, sx, sy)) return false;
  return sx == expX && sy == expY;
}

int main() {
  std::printf("firmware ui_input — touch routing core:\n");

  // --- raw→screen transform: 4 corners + center, no-swap fixture ---
  check("fixA corner raw(0,0) → (0,0)", mapEq(kFixA, 0, 0, 0, 0));
  check("fixA corner raw(1000,0) → (319,0)", mapEq(kFixA, 1000, 0, 319, 0));
  check("fixA corner raw(0,2000) → (0,239)", mapEq(kFixA, 0, 2000, 0, 239));
  check("fixA corner raw(1000,2000) → (319,239)", mapEq(kFixA, 1000, 2000, 319, 239));
  check("fixA center raw(500,1000) → (160,120)", mapEq(kFixA, 500, 1000, 160, 120));

  // --- raw→screen transform: 4 corners + center, swap+mirror fixture ---
  // Catches a transform that forgot the axis swap OR the Y mirror (a self-consistent
  // but wrong mapping would land these on the wrong corners).
  check("fixB raw(rawX=3800,rawY=200) → (0,0)", mapEq(kFixB, 3800, 200, 0, 0));
  check("fixB raw(rawX=3800,rawY=3800) → (319,0)", mapEq(kFixB, 3800, 3800, 319, 0));
  check("fixB raw(rawX=200,rawY=200) → (0,239)", mapEq(kFixB, 200, 200, 0, 239));
  check("fixB raw(rawX=200,rawY=3800) → (319,239)", mapEq(kFixB, 200, 3800, 319, 239));
  check("fixB center raw(2000,2000) → (160,120)", mapEq(kFixB, 2000, 2000, 160, 120));

  // --- out-of-range raw (rail / no pressure) is rejected, never wrapped ---
  int sx = 0, sy = 0;
  check("rail-low raw rejected", !rawToScreen(kFixB, 50, 2000, sx, sy));
  check("rail-high raw rejected", !rawToScreen(kFixB, 2000, 4090, sx, sy));
  check("real kTouchCal rejects a rail read", !rawToScreen(kTouchCal, 10, 2000, sx, sy));

  // --- real (committed) calibration is self-consistent: its endpoints map to corners ---
  check("kTouchCal endpoints map to screen corners",
        mapEq(kTouchCal, kTouchCal.rawYMin /*srcX after swap*/, kTouchCal.rawXMin /*srcY*/, 0, 0) &&
        mapEq(kTouchCal, kTouchCal.rawYMax, kTouchCal.rawXMax, 319, 239));
  check("kTouchCal mid-band tap maps in range",
        rawToScreen(kTouchCal, 2000, 2000, sx, sy) && sx >= 0 && sx <= 319 && sy >= 0 && sy <= 239);

  // --- routeTap hit-testing over the real time-tab hit-boxes (mapped via fixA-like
  // identity is awkward; use routeScreen directly with screen px for clarity) ---
  std::printf("\ntime-tab hit-testing (routeScreen):\n");
  auto routeAt = [](int x, int y) {
    return routeScreen(kTimeTabHitBoxes, kTimeTabHitBoxCount, x, y);
  };
  check("center of TODAY → TimeTab 0", routeAt(30, 12).kind == TapKind::TimeTab && routeAt(30, 12).index == 0);
  check("center of 30D → TimeTab 1", routeAt(70, 12).index == 1);
  check("center of ALL → TimeTab 2", routeAt(110, 12).index == 2);
  // Both pixels of each inter-tab dead gap (x=49,50 and x=89,90) select nothing.
  check("inter-tab gap x=49 → None", routeAt(49, 12).kind == TapKind::None);
  check("inter-tab gap x=50 → None", routeAt(50, 12).kind == TapKind::None);
  check("inter-tab gap x=89 → None", routeAt(89, 12).kind == TapKind::None);
  check("inter-tab gap x=90 → None", routeAt(90, 12).kind == TapKind::None);
  // Outside the bar selects nothing.
  check("left of bar x=5 → None", routeAt(5, 12).kind == TapKind::None);
  check("right of bar x=140 → None", routeAt(140, 12).kind == TapKind::None);
  check("below bar y=100 → None", routeAt(70, 100).kind == TapKind::None);
  // Boundary cases at the hit-box edges resolve to the intended tab (generous hit-box).
  check("left edge of TODAY (x=11) → TimeTab 0", routeAt(11, 0).index == 0);
  check("right edge of TODAY (x=48) → TimeTab 0", routeAt(48, 40).index == 0);
  check("left edge of ALL (x=91) → TimeTab 2", routeAt(91, 0).index == 2);
  check("right edge of ALL (x=128) → TimeTab 2", routeAt(128, 0).index == 2);

  // --- touch-target minimum (accessibility): each hit-box padded beyond the 16px pill ---
  bool allBigEnough = true;
  for (size_t i = 0; i < kTimeTabHitBoxCount; i++) {
    const HitBox& b = kTimeTabHitBoxes[i];
    const int w = b.x1 - b.x0 + 1, h = b.y1 - b.y0 + 1;
    if (w < 36 || h < 40) allBigEnough = false;
  }
  check("every time-tab hit-box is >=36px wide and >=40px tall", allBigEnough);

  // --- disjoint groups: the three tab hit-boxes must not overlap (a near-miss must
  // never resolve to two tabs; the basis for phase 12's disjoint time/agent groups) ---
  bool anyOverlap = false;
  for (size_t i = 0; i < kTimeTabHitBoxCount; i++)
    for (size_t j = i + 1; j < kTimeTabHitBoxCount; j++) {
      const HitBox& a = kTimeTabHitBoxes[i];
      const HitBox& b = kTimeTabHitBoxes[j];
      const bool overlap = a.x0 <= b.x1 && b.x0 <= a.x1 && a.y0 <= b.y1 && b.y0 <= a.y1;
      if (overlap) anyOverlap = true;
    }
  check("time-tab hit-boxes are mutually disjoint", !anyOverlap);

  // --- phase 12: agent-chip routing over the COMBINED table (time tabs + agent chips) ---
  std::printf("\nagent-chip routing (combined table):\n");
  auto routeAll = [](int x, int y) { return routeScreen(kAllHitBoxes, kAllHitBoxCount, x, y); };
  // Time-axis routing is unchanged in the combined table.
  check("combined: TODAY center → TimeTab 0", routeAll(30, 12).kind == TapKind::TimeTab && routeAll(30, 12).index == 0);
  check("combined: ALL-time center → TimeTab 2", routeAll(110, 12).kind == TapKind::TimeTab && routeAll(110, 12).index == 2);
  // Agent chips route by index (0=ALL,1=claude,2=codex,3=gemini).
  check("agent chip ALL center → AgentChip 0", routeAll(168, 12).kind == TapKind::AgentChip && routeAll(168, 12).index == 0);
  check("agent chip CLAUDE center → AgentChip 1", routeAll(208, 12).kind == TapKind::AgentChip && routeAll(208, 12).index == 1);
  check("agent chip CODEX center → AgentChip 2", routeAll(248, 12).kind == TapKind::AgentChip && routeAll(248, 12).index == 2);
  check("agent chip GEMINI center → AgentChip 3", routeAll(288, 12).kind == TapKind::AgentChip && routeAll(288, 12).index == 3);
  // The wide dead band between the two groups selects nothing — a near-miss never flips
  // the wrong axis.
  check("between-groups gap x=140 → None", routeAll(140, 12).kind == TapKind::None);
  check("between-groups gap x=129 → None", routeAll(129, 12).kind == TapKind::None);
  // Inter-chip gaps select nothing.
  check("agent inter-chip gap x=188 → None", routeAll(188, 12).kind == TapKind::None);
  check("agent inter-chip gap x=228 → None", routeAll(228, 12).kind == TapKind::None);

  // No screen point maps to BOTH a time tab and an agent chip (the two groups are
  // geometrically disjoint across the whole combined table) — and chips meet ≥36×40.
  bool anyCrossOverlap = false, agentBigEnough = true;
  for (size_t i = 0; i < kAllHitBoxCount; i++) {
    const HitBox& a = kAllHitBoxes[i];
    if (a.kind == TapKind::AgentChip) {
      const int w = a.x1 - a.x0 + 1, h = a.y1 - a.y0 + 1;
      if (w < 36 || h < 40) agentBigEnough = false;
    }
    for (size_t j = i + 1; j < kAllHitBoxCount; j++) {
      const HitBox& b = kAllHitBoxes[j];
      const bool overlap = a.x0 <= b.x1 && b.x0 <= a.x1 && a.y0 <= b.y1 && b.y0 <= a.y1;
      if (overlap) anyCrossOverlap = true;
    }
  }
  check("no point maps to both a time tab and an agent chip (groups disjoint)", !anyCrossOverlap);
  check("every agent-chip hit-box is >=36px wide and >=40px tall", agentBigEnough);

  // --- touch gate: PENIRQ gating, debounce, no re-arm under a held press ---
  std::printf("\ntouch gate (debounce / gating / chatter):\n");
  // Raw coords that route to TODAY (center) under the real calibration. Compute them so
  // the gate test exercises the real path. Use a raw point we know maps near a tab; we
  // instead inject coords via fixA-identity by routing on screen — but touchGate uses
  // routeTap(raw). So use kFixB and a raw point that maps onto TODAY.
  // fixB raw(rawX,rawY): screenX from rawY in [200..3800], screenY from rawX mirrored.
  // Aim screenX≈30 (TODAY), screenY≈12: rawY ≈ 200 + 30/319*3600 ≈ 539; rawX such that
  // screenY≈12 → (rawX-3800)*239/(200-3800)=12 → rawX ≈ 3800 - 12/239*3600 ≈ 3619.
  const int tapRawX = 3619, tapRawY = 539;
  {
    int vx = -1, vy = -1;
    rawToScreen(kFixB, tapRawX, tapRawY, vx, vy);
    check("chosen raw maps onto TODAY for the gate test",
          routeScreen(kTimeTabHitBoxes, kTimeTabHitBoxCount, vx, vy).index == 0);
  }

  TouchGate g;
  Tap out;
  // Idle line with valid-looking coords → never routes (touch-gating).
  check("PENIRQ idle yields no tap even with coords",
        !touchGate(g, kFixB, kTimeTabHitBoxes, kTimeTabHitBoxCount, 100, /*penirq*/ false,
                   tapRawX, tapRawY, kZ, kTouchTiming, out));

  // PENIRQ asserts but pressure is below minPressure (stale z≈0 edge) → no tap, and it
  // must NOT consume the press: a real press right after still fires.
  check("PENIRQ asserted but low pressure → no tap",
        !touchGate(g, kFixB, kTimeTabHitBoxes, kTimeTabHitBoxCount, 105, true, tapRawX, tapRawY,
                   /*z*/ 10, kTouchTiming, out));

  // First valid press (rising edge, armed) fires exactly one tap.
  check("press fires one tap",
        touchGate(g, kFixB, kTimeTabHitBoxes, kTimeTabHitBoxCount, 110, true, tapRawX, tapRawY, kZ,
                  kTouchTiming, out) && out.index == 0);
  // A second read inside the same held press does NOT re-fire (debounce).
  check("held press does not re-fire",
        !touchGate(g, kFixB, kTimeTabHitBoxes, kTimeTabHitBoxCount, 120, true, tapRawX, tapRawY, kZ,
                   kTouchTiming, out));

  // Chatter: brief release then re-assert faster than releaseStableMs (200) → still no
  // new tap (resistive PENIRQ re-arm guard).
  check("brief release (chatter) does not re-arm",
        !touchGate(g, kFixB, kTimeTabHitBoxes, kTimeTabHitBoxCount, 130, false, 0, 0, 0, kTouchTiming, out));
  check("re-assert within debounce window does not fire again",
        !touchGate(g, kFixB, kTimeTabHitBoxes, kTimeTabHitBoxCount, 230, true, tapRawX, tapRawY, kZ,
                   kTouchTiming, out));

  // Final release, then a STABLE release past the window re-arms; the next press fires.
  check("final release starts the window",
        !touchGate(g, kFixB, kTimeTabHitBoxes, kTimeTabHitBoxCount, 400, false, 0, 0, 0, kTouchTiming, out));
  check("still released before window elapses → not yet armed",
        !touchGate(g, kFixB, kTimeTabHitBoxes, kTimeTabHitBoxCount, 480, false, 0, 0, 0, kTouchTiming, out));
  check("released past the window → re-armed (no fire on a release sample)",
        !touchGate(g, kFixB, kTimeTabHitBoxes, kTimeTabHitBoxCount, 620, false, 0, 0, 0, kTouchTiming, out));
  check("next press after a stable release fires again",
        touchGate(g, kFixB, kTimeTabHitBoxes, kTimeTabHitBoxCount, 660, true, tapRawX, tapRawY, kZ,
                  kTouchTiming, out) && out.index == 0);

  // A press that lands in a gap consumes the press (no fire) but does not crash / wrap.
  TouchGate g2;
  check("press in a gap → no tap",
        !touchGate(g2, kFixA, kTimeTabHitBoxes, kTimeTabHitBoxCount, 100, true, /*raw maps to gap*/ 156, 100,
                   kZ, kTouchTiming, out));

  std::printf("\n%s (%d failure%s)\n", g_failures == 0 ? "PASS" : "FAIL", g_failures,
              g_failures == 1 ? "" : "s");
  return g_failures == 0 ? 0 : 1;
}
