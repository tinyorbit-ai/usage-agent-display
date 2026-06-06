// touch_config.h — COMMITTED board configuration for the ESP32-2432S028R touch panel
// (ADR 0015). These are calibration geometry and hit-box layout — NOT secrets. WiFi
// creds and the bearer token stay in the gitignored config.h; these constants are
// committed deliberately so (a) the host tests reference the SAME numbers the device
// runs, and (b) a fresh checkout builds with a known calibration. They are single-unit
// values: re-measure on a board swap (tap the four corners, read the raw values over
// serial, update kTouchCal).
#pragma once

#include "ui_input.h"

namespace ui {

// --- XPT2046 raw → landscape-screen calibration (measured on this unit) ---
// On the CYD the touch raw axes are SWAPPED relative to the ILI9341 in landscape
// (rotation 1), and the screen-Y axis is mirrored — encoded by rawYMin > rawYMax.
// Endpoints are the raw readings observed when tapping the screen corners. Tune these
// on-device: flash, tap each corner, read the raw x/y printed to serial, set the four
// extremes here. rawValid* reject rail reads (a finger-off line floats to an extreme).
static const TouchCalibration kTouchCal = {
    /* rawXMin     */ 200,
    /* rawXMax     */ 3800,
    /* rawYMin     */ 3800,  // mirrored: high raw → screen y=0
    /* rawYMax     */ 200,
    /* swapXY      */ true,
    /* rawValidMin */ 120,
    /* rawValidMax */ 3975,
    /* minPressure */ 150,   // XPT2046 z below this is no real contact (rejects stale z≈0 edges)
};

// --- Time-tab hit-boxes (landscape px) ---
// buildScreen() draws the tab bar at x=10, three 40px slots, each a 38×16 pill (see
// main.cpp). The hit-boxes keep that drawn look but pad the tap target to a
// finger-friendly size (38 wide × 41 tall, well beyond the 16px pill) and leave a 2px
// dead gap between adjacent tabs (x=49–50, x=89–90) so a mis-tap in the gap selects
// nothing rather than the wrong tab. Bounds are INCLUSIVE (see HitBox).
static const HitBox kTimeTabHitBoxes[] = {
    {TapKind::TimeTab, 0, 11, 0, 48, 40},   // TODAY  (x 11..48 = 38px; gap 49,50)
    {TapKind::TimeTab, 1, 51, 0, 88, 40},   // 30D    (x 51..88 = 38px; gap 89,90)
    {TapKind::TimeTab, 2, 91, 0, 128, 40},  // ALL    (x 91..128 = 38px)
};
static const size_t kTimeTabHitBoxCount = sizeof(kTimeTabHitBoxes) / sizeof(kTimeTabHitBoxes[0]);

// --- Agent-chip hit-boxes (landscape px) — phase 12 ---
// The right band of the top bar holds the 4-segment agent control (ALL + claude/codex/
// gemini). Four 38px-wide targets with 2px dead gaps, starting at x=150 so the group is
// DISJOINT from the time tabs (which end at x=128) with a wide ~21px dead band between
// the two groups — a near-miss never flips the wrong axis. Index matches usage::Agent
// (0=ALL, 1=claude-code, 2=codex, 3=gemini). Inclusive bounds.
static const HitBox kAgentHitBoxes[] = {
    {TapKind::AgentChip, 0, 150, 0, 187, 40},  // ALL     (x 150..187)
    {TapKind::AgentChip, 1, 190, 0, 227, 40},  // claude  (gap 188,189)
    {TapKind::AgentChip, 2, 230, 0, 267, 40},  // codex   (gap 228,229)
    {TapKind::AgentChip, 3, 270, 0, 307, 40},  // gemini  (gap 268,269)
};
static const size_t kAgentHitBoxCount = sizeof(kAgentHitBoxes) / sizeof(kAgentHitBoxes[0]);

// The combined routing table the firmware loop hands to routeTap: time tabs first, then
// agent chips. The two groups are geometrically disjoint, so first-match-wins is
// unambiguous (asserted in the native suite).
static const HitBox kAllHitBoxes[] = {
    {TapKind::TimeTab, 0, 11, 0, 48, 40},
    {TapKind::TimeTab, 1, 51, 0, 88, 40},
    {TapKind::TimeTab, 2, 91, 0, 128, 40},
    {TapKind::AgentChip, 0, 150, 0, 187, 40},
    {TapKind::AgentChip, 1, 190, 0, 227, 40},
    {TapKind::AgentChip, 2, 230, 0, 267, 40},
    {TapKind::AgentChip, 3, 270, 0, 307, 40},
};
static const size_t kAllHitBoxCount = sizeof(kAllHitBoxes) / sizeof(kAllHitBoxes[0]);

// Released-and-stable window before another tap is accepted (debounce / no re-arm under
// a held press). Resistive PENIRQ can re-assert up to ~250ms into a held press, so the
// release must be continuously valid-contact-free this long before a new tap counts;
// 200ms separates real chatter from a deliberate second tap. Tune up on-device if a
// long press ever registers twice (the hardware-gate check).
static const TouchTiming kTouchTiming = {/* releaseStableMs */ 200};

}  // namespace ui
