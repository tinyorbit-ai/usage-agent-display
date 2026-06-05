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
  "v": 1,
  "generated_at": "<iso>",
  "last_sync": { "machine": "mbp-14", "age_seconds": 27 },   // honest freshness
  "totals": { "tokens": 14200000, "cost_usd": 12.40 },        // hero = tokens
  // phase 2+: by_provider[], by_machine[], session{}, month{}, window_1h{}
  // phase 3+: projection{ eod_usd, month_usd }, budget{ limit, used_pct }
  // phase 4+: sparkline_1h[] (token buckets), active_machine
}
```

## Decisions index

- [[decisions/0001-shape-daemon-api-cyd]] — component shape & polling
- [[decisions/0002-ccusage-invocation]] — pinned dependency, not global install
- [[decisions/0003-daemon-auth-bearer]] — shared bearer token
- [[decisions/0004-ingest-dedup-model]] — dedup key & provider-agnostic schema
- [[decisions/0005-cyd-board-and-toolchain]] — ESP32-2432S028R + PlatformIO/LVGL
