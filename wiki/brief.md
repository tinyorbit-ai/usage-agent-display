# Brief — usage-agent-display

Part of [[index]]. Status: **filled.** Shape locked in [[decisions/0001-shape-daemon-api-cyd]].

## What it is

A physical desk panel — a Cheap Yellow Display (CYD: an ESP32 board with a 2.8"
touch LCD) — that shows my aggregated AI-coding usage across all my machines, live.
A tiny daemon on each machine reads my local Claude Code and Codex usage (via
`ccusage`), ships normalized snapshots to a small central service, and the CYD polls
one compact endpoint and renders the numbers as glanceable tiles. The hero number is
**total tokens used**; cost, per-provider split, and everything else hang off it.

## Who & when

Just me, at my desk, while I'm working with coding agents. The specific moment:
mid-session, I glance up from the editor to the panel sitting next to the monitor to
see how hard I'm leaning on the agents right now — tokens flowing, what it's costing,
which provider, across which machine — without breaking flow to run a CLI. Single-user
by design (see non-goals).

## How it should feel

**Live mission-control.** Not a refreshed webpage — a console that feels *alive*: the
token burn visibly ticks, a rolling sparkline scrolls, the currently-active machine
glows. Glanceable from across the room, but alive up close. Touch is for navigating
views, never for control.

## The hard / interesting part

Three knots, in order of likely difficulty:
1. **Cross-machine aggregation correctness** — making two+ machines' numbers agree:
   dedup, clock skew, and an *honest* "last sync age" so the panel never lies about
   how fresh it is.
2. **Making "live" real on an ESP32** — a burn rate that ticks and a sparkline that
   scrolls, rendered in firmware, without hammering the backend.
3. **Tiny-screen information hierarchy** — a 2.8" screen forces brutal triage of
   what earns a pixel. The hierarchy is fixed (below) so this is a solved constraint,
   not a recurring fight.

## Metric hierarchy (the fixed design backbone)

In strict priority order — this drives every layout decision:
1. **Total tokens used** — the hero number. Biggest, brightest, the thing that ticks.
2. **Cost** — supporting number, treated as a real *instrument* not a footnote
   (model-aware pricing, end-of-day and month projection, optional budget line).
3. **Per-provider split** — Claude Code vs Codex.
4. **Everything else** — per-machine split, current-session burn, rolling 1h,
   month-to-date, last-sync age.

## The friction it replaces

Today: run `ccusage` in a terminal, per machine, and mentally stitch the numbers
together — which means I basically never do it, and have no cross-machine or live
sense of my usage at all. The friction is *attention* (context-switch out of the
editor to a CLI) and the fact that there is no aggregated view to switch *to*.

## Smallest useful version (phase-1 seed)

**Two machines aggregated, showing real combined totals.** Daemon on two machines →
central Bun+SQLite API → CYD shows the combined hero token count (and cost) that is
genuinely the sum across both. Proves the aggregation — the hard part — end to end on
day one. Live-tick, sparkline, and cost projection are *later* phases building toward
the locked vision; phase 1 is the thinnest thing that's already true and on the desk.

## Three-year fit

**More essential, bigger surface.** This should grow into a real personal ops panel:
more providers (Cursor, Gemini, …), more tiles, possibly multiple CYDs. Consequence
for the plan: the ingest schema and normalization must stay **provider-agnostic and
extensible** from the start — adding a provider should be a new collector + a row
shape, never a rewrite. (Adopted via the ambition pass.)

## Constraints

- **CYD hardware** — ESP32 + 2.8" touch LCD; firmware in C++ (LVGL / TFT_eSPI).
- **Bun + TypeScript** for both the per-machine daemon and the central API.
- **SQLite** for storage — single file, zero-ops, right-sized for self-hosted single
  tenant.
- **`ccusage --json`** is the data source for Claude Code + Codex local logs.
- **Self-hosted** — central API runs on my own box (homelab/VPS/LAN).

## Non-goals

- **Not multi-user / not a product.** Just me, my machines. No auth tiers, accounts,
  sharing, or "others can use it." Single-tenant by design.
- **No control actions.** Display-only. The CYD never triggers agent runs, pauses
  sessions, or sends commands back. Touch navigates views, nothing more.
- **No cloud / self-hosted only.** No third-party hosted SaaS, no third-party cloud
  storage of my usage data.
- *Note:* "not billing-accurate" was **deliberately not** made a non-goal — cost is a
  first-class output (best-effort from `ccusage`), shown honestly as an estimate, not
  hand-waved away.

## Shape chosen

**Per-machine daemon → central Bun+SQLite HTTP API → CYD polls JSON and renders tiles
in firmware.** Chosen over (a) CYD blitting a server-rendered PNG card and (b) MQTT
push: polling-JSON keeps the firmware self-contained and robust (research's
"polling + cache" pattern) with no broker dependency, while still leaving room to make
"live" real via fast polling / SSE later. See
[[decisions/0001-shape-daemon-api-cyd]].

## What surprised you

Genuinely **unknown yet** — I couldn't name it in advance. Three candidates to watch
as it gets built, so we notice which one it turns out to be:
- cross-machine aggregation correctness being the real work (plumbing, not pixels);
- a live burn tile in my eyeline actually *changing how I use the agents*;
- the 2.8" screen forcing harder information-hierarchy decisions than expected.
The metric hierarchy above is a deliberate down-payment against the third.
