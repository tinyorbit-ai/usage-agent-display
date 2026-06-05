# 0004 — Ingest & dedup model: (machine, provider, type, bucket) upsert, provider-agnostic

Part of [[../index]]. Status: **accepted** (2026-06-05, plan).

## Context

Cross-machine aggregation correctness is the brief's stated hard part. ccusage reports
**cumulative** totals per provider per time bucket (daily/session/monthly). Daemons
re-run on an interval and re-post overlapping data; multiple machines post
independently with their own clocks. Naive append would double-count; a brittle schema
would block the 3-year-fit goal of adding providers without a rewrite.

## Decision

Store raw `snapshots` keyed for dedup by **`(machine_id, provider, model,
token_category, report_type, bucket)`**, and **upsert** for that key. Three rules
hardened by the plan-time adversarial review:

1. **Conflict resolution = server `received_at`, not daemon `collected_at`.** The
   daemon's clock is untrusted (skew, replay, stale retry). The server stamps
   `received_at` on arrival and the most-recently-*received* snapshot for a key wins.
   A snapshot whose daemon `collected_at` is implausibly in the future is
   rejected/quarantined, not stored.
2. **Hero/total aggregation uses ONE canonical `report_type` (`daily`).** `session`
   and `monthly` rows are stored for their own views but are **never summed into** the
   combined hero total — otherwise the same tokens count 2–3× across report types.
3. **Granular rows from phase 1** — `model` and `token_category`
   (`input|output|cache_read|cache_write`) are columns from the start. `provider` and
   `model` are **open strings**, not enums.

Aggregates = sum of deduped current `daily` rows across machines & providers.

## Why

- **Idempotent re-posts** — re-running the daemon for "today" overwrites, never
  double-counts, because daily totals are cumulative.
- **Clock-skew tolerant** — conflict resolution uses the *server* clock
  (`received_at`), so a machine with a wrong/drifting clock can't overwrite good data
  with stale values. `last_sync.age` is reported honestly per machine so the panel
  never claims fresher-than-true.
- **No cross-report double-count** — pinning the hero to one canonical report type is
  the difference between a correct total and a silently 2–3× inflated one.
- **Future-proof pricing without data loss** — model/category granularity means
  phase-3 per-model pricing needs no migration and no lost history (ccusage keeps only
  ~30 days locally).
- **Provider-agnostic** — a new provider (Cursor, Gemini) is a new `provider`/`model`
  string from a new collector; zero schema/aggregation changes (3-year fit).

## Alternatives

- **Append-only event log + windowed sums** — flexible, but must de-overlap cumulative
  ccusage reports anyway and costs more storage/complexity for a single-tenant box.
  Rejected for now; the raw `raw_json` column keeps the door open to reconstruct one.
- **`provider` as an enum / separate tables per provider** — type-safe but every new
  provider is a migration. Rejected: directly fights the extensibility goal.

## Consequences

- Re-ingest is safe and cheap → daemons can post frequently without coordination.
- Historical correction is automatic (a corrected cumulative total just upserts).
- Retention: ccusage may only retain ~30 days locally by default; long-term history
  needs our store to keep deduped rows (retention policy decided at the ops phase).
- A thin `collector` interface (input: machine env → output: normalized snapshot rows)
  is the extension seam; ccusage is the first implementation
  ([[0002-ccusage-invocation]]).
