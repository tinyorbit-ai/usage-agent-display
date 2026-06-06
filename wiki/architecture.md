# Architecture — usage-agent-display

Part of [[index]]. The 30-second version. Why → ADRs.

## The shape (locked: [[decisions/0001-shape-daemon-api-cyd]])

```
 machine A                         machine B                 (… N machines)
 ┌───────────────┐                 ┌───────────────┐
 │ daemon (Bun)  │                 │ daemon (Bun)  │
 │  ccusage --json                 │  ccusage --json
 │  → normalize  │                 │  → normalize  │
 │  → POST /ingest (bearer)        │  → POST /ingest (bearer)
 └──────┬────────┘                 └──────┬────────┘
        │                                 │
        └──────────────┬──────────────────┘
                       ▼
        ┌──────────────────────────────────┐
        │ central service — Bun + SQLite    │
        │  POST /ingest  (auth, dedup upsert)│
        │  aggregate / rollup / project      │
        │  GET  /usage/summary  (compact)    │
        └──────────────┬────────────────────┘
                       │  HTTP GET poll
                       ▼
        ┌──────────────────────────────────┐
        │ CYD — ESP32-2432S028R             │
        │  PlatformIO · LVGL · TFT_eSPI     │
        │  WiFi → poll → render tiles       │
        │  tokens(hero) > cost > provider > …│
        └──────────────────────────────────┘
```

## The central bet

Keep the CYD **dumb and self-contained** (it polls JSON and renders; degrades to
last-good + honest stale age on network blips), and put all the hard correctness
(dedup, clock-skew tolerance, aggregation, projection) **server-side**. ccusage is
the parser so the daemon never learns evolving log formats — see
[[decisions/0002-ccusage-invocation]].

## Data model (SQLite) — provider-agnostic, granular from day one

`snapshots` (raw, upsert):
`machine_id · provider · model · token_category(input|output|cache_read|cache_write)
· report_type(daily|session|monthly) · bucket(date/session id) · tokens · cost_usd ·
collected_at(daemon clock) · received_at(server clock) · raw_json`

- **Dedup key** = `(machine_id, provider, model, token_category, report_type, bucket)`
  → upsert. **Conflict resolution = server `received_at`** (not daemon `collected_at`,
  which is untrusted/clock-skewable); snapshots with an implausibly future
  `collected_at` are rejected/quarantined. Re-posting is idempotent.
  ([[decisions/0004-ingest-dedup-model]])
- **Hero/total aggregation uses ONE canonical `report_type` (`daily`)** — `session` and
  `monthly` are separate views and are **never summed into** the hero, or the same
  tokens count 2–3×. (Codex review catch.)
- **Granular by `model` + `token_category` from phase 1** even though phase 1 only
  *displays* the combined total — phase 3 pricing is per-model/per-category, and
  ccusage retains only ~30 days locally, so a later schema widening would permanently
  lose history. Cheap to store now; impossible to backfill later.
- **`provider` and `model` are open strings**, not enums — adding Cursor/Gemini is a new
  collector emitting the same row shape, never a schema rewrite (3-year fit).

## The `/usage/summary` contract (firmware's stable interface)

Versioned, grows per phase. v1 (phase 1) carries the hero only; later phases add
fields without breaking older firmware:

```jsonc
{
  "v": 2,                                                      // phase 2 (was 1)
  "generated_at": "<iso>",
  "last_sync": { "machine": "mbp-14", "age_seconds": 27 },     // honest freshness
  "totals": { "tokens": 14200000, "cost_usd": 12.40 },         // hero = tokens
  "by_provider": [{ "provider": "claude-code", "tokens": 0, "cost_usd": 0 }],
  "by_machine":  [{ "machine": "mbp-14", "tokens": 0, "cost_usd": 0,
                    "age_seconds": 27, "stale": false }],      // stale degrades gracefully
  "session": { "machine": "mbp-14", "tokens": 0, "cost_usd": 0 }, // or null — active session
  "month":   { "month": "2026-06", "tokens": 0, "cost_usd": 0 },  // reckoned in one TZ
  "cost": {                                                       // phase 3 — instrument
    "pricing_version": "2026-06-01", "priced_usd": 0,            // priced from our table
    "unpriced_tokens": 0, "partial": false,                     // unknown models surfaced
    "projection": { "eod_usd": 0, "month_usd": 0 },             // linear from elapsed fraction
    "budget": { "limit_usd": 0, "used_pct": 0, "over_budget": false } // or null
  },
  "sparkline_1h": { "bucket_seconds": 60, "buckets": [0, 0, 0] }, // phase 4 — 1h burn series
  "active_machine": "mbp-14"                                       // most recent positive delta, or null
}
```

## Updates since phase 5 (kept honest)

- **Contract grew (still additive, `v` unchanged).** `/usage/summary` now also carries
  `timeframes` (today / d30 / all — tokens + cost + active-day count + per-provider),
  a 14-point `daily` series for the bar graph, and `last_used` (phase 7). A new
  **unauthenticated `GET /health`** liveness route sits in front of the bearer gate
  (phase 8); every data route still requires the token.
- **Per-provider daily series (phase 10, shipped).** `/usage/summary` adds an **optional**
  `daily_by_provider`, an object keyed by **open provider id**
  (`{"claude-code": [...], "codex": [...], …}`), so the firmware can redraw the bar graph
  for one filtered agent. Each array is index-aligned to `daily`: `daily_by_provider[p][i]`
  is provider `p`'s tokens on `daily[i].date`, so **`length === daily.length`** and the
  buckets/order match `daily` exactly. **NOT a fixed-14 array** — `daily` is the latest
  buckets-*with-data* (`< 14` possible, calendar gaps collapsed), and each provider series
  is reindexed onto that axis, zero-filling buckets where the provider had no row. Every
  provider that appears in any timeframe's `by_provider` gets a key; one with all-time usage
  but nothing in the graph window is an explicit `daily.length`-long **all-zeros** array,
  never a missing key (so a filtered graph renders an honest empty series, never a fallback
  to the combined one). The split is derived from the **same base query** as the combined
  `daily` (canonical daily rows, flat `SUM(tokens)`, single `GROUP BY provider, bucket` — no
  N+1), so `Σ_p daily_by_provider[p][i] === daily[i].tokens` holds by construction (asserted
  as a test tripwire). Provider-agnostic (open keys, not enum fields); additive (`v`
  unchanged, optional so pre-phase-10 firmware ignores it). The field is bounded to the
  providers actually present and the serialized summary stays ≤ ~6KB (measured 2607 B at a
  worst-realistic 4×3×14 load) — the shipped firmware still parses `/usage/summary` with an
  **unbounded** `JsonDocument` (`main.cpp:286`), so the small bound matters until phase 12
  moves the live parse onto the bounded host-tested core. Powers the agent filter
  ([[decisions/0014-agent-filter-direct-tap]]).
- **Two-axis tabs + real touch (phases 11–12).** The CYD top bar becomes a 2-D selection
  — time tabs (left) × a 4-segment agent control (right, replacing the static `ALL
  AGENTS` label). Both groups are **direct-tap**: the firmware reads XPT2046 coordinates
  on a dedicated SPI bus (the PENIRQ any-tap-cycle model is retired), routes the tap via
  a pure host-tested `routeTap(x,y)`, and re-scopes hero + cost + graph to the selected
  provider. See [[decisions/0014-agent-filter-direct-tap]] (feature shape) and
  [[decisions/0015-touch-input-stack]] (touch driver + calibration).
- **Multi-agent for real.** ccusage v20 reports claude + codex + gemini natively; the
  daemon derives each row's provider from the model name (phase 6,
  [[notes/2026-06-06-ccusage-multi-agent]]).
- **Panel UI v2.** The CYD renders the "C2" design — pixel font, timeframe tabs
  (tap-to-cycle via PENIRQ), tokens/day graph (phase 7, [[decisions/0012-panel-visual-system-v2]]).
- **Distribution & deploy.** Daemon ships as a single `bun --compile` binary; the server
  deploys on a self-host PM2 + Doppler + Cloudflare-Tunnel VM at a bearer-gated public
  URL; the CYD speaks HTTP on-LAN or HTTPS to the public URL (phase 8–9,
  [[decisions/0013-distribution-and-deployment]]).

## Decisions index

- [[decisions/0001-shape-daemon-api-cyd]] — component shape & polling
- [[decisions/0002-ccusage-invocation]] — pinned dependency, not global install
- [[decisions/0003-daemon-auth-bearer]] — shared bearer token
- [[decisions/0004-ingest-dedup-model]] — dedup key & provider-agnostic schema
- [[decisions/0005-cyd-board-and-toolchain]] — ESP32-2432S028R + PlatformIO/LVGL
- [[decisions/0006-cost-attribution-grain]] · [[decisions/0007-firmware-host-testable-core]]
  · [[decisions/0008-display-design-system]] · [[decisions/0009-pricing-source-and-projection]]
  · [[decisions/0010-live-transport]] · [[decisions/0011-retention-policy]]
- [[decisions/0012-panel-visual-system-v2]] — pixel font + timeframe tabs (phase 7)
- [[decisions/0013-distribution-and-deployment]] — compiled daemon + public deploy (phase 8)
- [[decisions/0014-agent-filter-direct-tap]] — direct-tap time × agent tabs + full-readout filter (phases 10–12)
- [[decisions/0015-touch-input-stack]] — XPT2046 on dedicated SPI + baked calibration (phases 11–12)
