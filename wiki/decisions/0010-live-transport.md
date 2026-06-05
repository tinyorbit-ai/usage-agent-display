# 0010 — Live transport: fast poll + firmware interpolation, not SSE

Part of [[../index]]. Status: **accepted** (2026-06-06, phase 4). *(The plan called
this "ADR 0008"; 0008 was taken by the display design system, so it is 0010.)*

## Context

Phase 4 makes the panel feel alive: a ticking hero, a scrolling 1h sparkline, an
active-machine glow — "without hammering the backend." The data still originates from
a per-interval daemon → server pipeline. We had to choose how the panel gets fresh
enough data to feel live, and how to fill the gaps between updates.

## Decision

**Keep polling — at a modest interval — and interpolate on the firmware.** The CYD
polls `/usage/summary` every few seconds; between polls the hero **eases** toward the
last confirmed total (the host-tested `Ticker`), the sparkline scrolls only when a new
bucket arrives, and the active machine glows. No SSE, no WebSocket, no server push.

- The ticker is **bounded**: never display above the last confirmed total; a higher
  confirmed total eases up; a lower one (correction / day rollover) is an explicit
  reset. Empty sparkline buckets render flat (0) — never phantom burn.
- **Motion budget (locked):** the hero always ticks; the sparkline scrolls only on a
  new bucket; the glow is a slow subtle pulse — never more than the hero plus one
  secondary element in motion at once.
- **Polling stays cheap:** a few-second interval with backoff on error; the summary is
  a tiny compact JSON, and the server computes it from indexed queries.

## Why

- **Self-contained firmware** ([[0001-shape-daemon-api-cyd]]) — the panel owns its
  smoothness via interpolation; it degrades to last-good on a blip without a dropped
  push connection to recover.
- **No persistent connections on an ESP32** — SSE/WebSocket means holding sockets open
  and server-side connection state for one screen; polling a stateless endpoint is far
  simpler to self-host and reason about.
- **"Live" is a feel, not sub-second truth** — the underlying data updates on the
  daemon's interval anyway; interpolating between polls delivers the *feel* of live
  without pretending to more freshness than exists (the bounded ticker guarantees we
  never show un-confirmed numbers).

## Alternatives

- **Server-Sent Events / WebSocket push.** Genuinely lower-latency, but adds persistent
  connections, reconnection logic, and server connection state — disproportionate for a
  desk panel, and the daemon interval is the real freshness floor anyway. Deferred;
  revisit only if poll latency ever feels inadequate (it won't at this cadence).
- **Unbounded extrapolation** (predict and animate past the confirmed total). Rejected:
  it would show numbers that never happened — dishonest, and ugly on a correction.

## Consequences

- The hero's smoothness is a firmware concern (`Ticker`), independent of network
  timing; it is pure and host-tested so the bound ("never above confirmed") can't
  regress silently.
- The server must expose the burn series (`sparkline_1h`) and `active_machine`; both are
  computed from append-only total samples (see the live rollup).
- If a future need for true push appears, it slots in behind the same `/usage/summary`
  shape (the firmware would just receive the same payload more often).
