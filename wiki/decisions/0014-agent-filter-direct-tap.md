# 0014 — Agent filter: direct-tap tabs + full-readout filtering

Part of [[../index]]. Status: **accepted** (2026-06-06). Amends the touch model of
[[0012-panel-visual-system-v2]] (replaces tap-to-cycle with direct-tap).

## Context

The panel shows a per-provider breakdown as three static rows (Claude/Codex/Gemini)
but cannot *isolate* one provider: the hero, cost, and 14-day graph are always combined.
The user wants a second selection axis — pick an agent the way you already pick a
timeframe — so the whole instrument re-scopes to one provider.

Two facts constrain the design:
- **Touch is intentionally "dumb."** Firmware reads only the PENIRQ line (touched /
  not), and *any* tap cycles the timeframe — chosen in [[0012-panel-visual-system-v2]]
  to avoid touch calibration.
- **Data asymmetry.** Per-(timeframe × provider) **tokens and cost** are already in
  `/usage/summary` (`timeframes[tf].by_provider[]`); the firmware just doesn't read
  cost yet. But the 14-day `daily` series is **combined-only**.

## Decision

1. **Two direct-tap tab groups.** Replace the static `ALL AGENTS` label with a
   4-segment agent control (`ALL` + Claude/Codex/Gemini chips) mirroring the time tabs.
   Both groups become **direct-tap**: read XPT2046 touch coordinates, calibrate, and
   hit-test each chip. The old any-tap-cycles-time behavior is retired entirely.
2. **State is (timeframe × agent).** Independently selectable. Time stays the primary
   driver; agent defaults to `ALL`, time default stays `30D`.
3. **Full-readout filter.** Selecting an agent re-scopes hero **and** cost **and** the
   14-day graph to that provider, drawn in its brand color (`kClaude/kCodex/kGemini`).
   `ALL` restores the combined view.
4. **Backend emits per-provider daily.** Add a per-provider daily series to
   `/usage/summary` so the graph can redraw for one agent. No schema change — the data
   is already derivable in `db.ts`.
5. **Ship together.** Backend + firmware land as one feature, not a client-only stage.

## Why

- A 4-segment control that looks and behaves like the time tabs makes the two-axis model
  self-evident — the agent control reads as a peer, not a bolt-on.
- Filtering the *entire* readout (not just emphasizing a row) is what makes a single
  agent's burn/cost/trend legible at a glance — the actual friction being removed.
- Direct-tap (vs. cycling) lets the user jump straight to an agent; the user explicitly
  wanted this for **both** axes, accepting the calibration cost.

## Alternatives

- **Coarse two-zone cycling** (left half cycles time, right half cycles agent): keeps
  calibration cheap, but you cycle rather than jump, and it fights the "tap the exact
  chip" intent. Rejected.
- **One combined cycle** through all time×agent combos: zero new hardware code, but no
  direct selection. Rejected.
- **Emphasis-only filter** (highlight a row, hero stays combined): lightest, but the
  hero — the whole point of the panel — wouldn't react to the filter. Rejected.
- **Client-only first, graph later**: matches prototype-first habit, but the user chose
  the complete feature in one go. Rejected for this feature.

## Consequences

- Reverses [[0012-panel-visual-system-v2]]'s "no calibration" simplicity — the panel now
  owns a touch-calibration + hit-test path, the main new risk.
- Tap targets in the ~150px top-right band are small (~37×22px) on resistive touch;
  hit-boxes must be generous and debounced, and verified on-device.
- Firmware must start reading per-provider `cost_usd` (already in payload) and a new
  per-provider daily series (new payload field).
- Adds an axis of state the renderer must thread through hero/cost/graph consistently.
- Chips map to the **production provider ids** (`claude-code`, `codex`, `gemini`) — not
  the display labels. The payload/lookup uses `claude-code`, so a chip keyed on `claude`
  would silently resolve to zeros (caught in the hardening reviewer pass).
