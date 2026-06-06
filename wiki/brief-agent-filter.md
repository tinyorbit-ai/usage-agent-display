# Feature Brief — Agent Filter (two-dimensional tabs)

Part of [[index]]. A feature on top of the shipped panel ([[brief]]).
Shape locked in [[decisions/0014-agent-filter-direct-tap]]. Status: **filled.**

## What it is

The CYD panel gains a second tab dimension. Today the top bar has time tabs
(`TODAY / 30D / ALL`) on the left and a static `ALL AGENTS` label on the right. That
static label becomes a **4-segment agent control** mirroring the time tabs:
`ALL` + three brand-colored chips (Claude · Codex · Gemini). The screen now renders a
2-D selection — **(timeframe × agent)**. Time stays the main driver; agent defaults to
`ALL`. Tapping `CODEX` filters the *entire* readout — hero tokens, cost, and the 14-day
graph — to Codex only, drawn in its brand color. Tap `ALL` to return to the combined view.

Both tab groups become **direct-tap** (tap the exact chip), retiring the old
any-tap-cycles-time behavior.

## Who & when

Same single user, same desk, same mid-session glance — but now the question is
sharper: *"how hard am I leaning on **Codex** specifically right now — its tokens, its
cost, its trend?"* The moment: glance up, tap the Codex chip, read its isolated burn
without leaving the editor; tap ALL to zoom back out.

## How it should feel

Consistent with the panel's "live mission-control" feel. The agent control must read
as a **peer of the time tabs** — same segmented-pill shape, same highlight-the-active
treatment — so the two-axis model is obvious at a glance. Tapping a chip should feel
like a deliberate, landed selection (direct hit), not a guess.

## The hard / interesting part

1. **Real touch, reversing a deliberate choice.** The firmware currently senses only
   *that* a touch happened (PENIRQ), not *where* — chosen specifically to avoid
   calibration ([[decisions/0012-panel-visual-system-v2]]). Direct-tap needs XPT2046
   coordinate reading, calibration, and per-chip hit-testing for **two** tab groups.
   This is the knot and the main risk.
2. **Tap-target ergonomics on a 2.8" resistive screen.** Four agent chips in the
   ~150px top-right band are small (~37×22px). Hit-testing must be forgiving (generous
   bounding boxes, debounce) so a slightly-off press still lands.
3. **Per-agent graph data.** The hero and cost per (timeframe × provider) are already
   in the API payload; the 14-day graph is **combined-only**. The backend must emit a
   per-provider daily series so the graph can redraw for one agent.

## The friction it replaces

Today the three agent rows are a static read-only breakdown — you can see the split,
but you cannot *isolate* one agent's hero number, cost, or trend. To reason about a
single agent's burn you mentally subtract the others. The friction is **attention**:
no way to focus the whole instrument on one agent at a glance.

## Smallest useful version

User chose to ship the whole feature at once (no client-only intermediate). The thinnest
*end-to-end* slice that proves it: one agent chip, direct-tapped via real touch
coordinates, filtering hero + cost + graph with the backend serving per-provider daily.

## Three-year fit

**Sharper niche.** This deepens the existing tool rather than widening it — the panel
gets better at the one job it already does (glanceable agent usage), not more jobs.

## Constraints

- ESP32-2432S028R, PlatformIO/LVGL/TFT_eSPI, host-testable pure core
  ([[decisions/0005-cyd-board-and-toolchain]], [[decisions/0007-firmware-host-testable-core]]).
- Reuse the existing palette and brand colors (`kClaude/kCodex/kGemini`) and the
  segmented-pill visual language already used by the time tabs.
- Backend change limited to adding a per-provider daily series to `/usage/summary`;
  no schema change (per-provider daily is already derivable — see `db.ts`).
- State is **(timeframe, agent)**, both independently selectable, agent default `ALL`,
  time default `30D` (unchanged).

## Non-goals

- **Not** a control surface — touch still only navigates views; it never triggers
  actions, settings, or writes.
- **Not** per-machine filtering — this axis is provider only.
- **Not** a fourth metric — the metric hierarchy (tokens → cost → split) is unchanged;
  the filter re-scopes the *same* instrument, it doesn't add a new number.
- **Not** keeping the old any-tap-cycle model as a fallback — direct-tap fully replaces it.

## Shape chosen

**Top 4-segment agent control + full direct-tap.** Picked over (a) coarse two-zone
cycling and (b) emphasis-only filtering because the user wants the agent control to be a
true peer of the time tabs and to re-scope the whole readout — the most ambitious shape
on every axis (direct-tap both groups, full filter incl. graph, shipped together).

## What you're drawn to / unsure about

Drawn to: the clean two-axis mental model. Unsure about: whether finger-direct-tap on
4 small chips is reliable enough on resistive touch — the open risk the plan must de-risk
(generous hit-boxes, calibration, on-device testing).
