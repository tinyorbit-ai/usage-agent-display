# 0006 — Cost attribution grain: replicate per category row, de-duplicate per model/bucket

Part of [[../index]]. Status: **accepted** (2026-06-05, phase 1 build).

## Context

[[0004-ingest-dedup-model]] makes the snapshot row granular: the dedup key includes
`token_category`, so one ccusage model/bucket becomes **four** rows (input, output,
cache_read, cache_write). But ccusage reports **cost per model/bucket**, not per
token category. The row schema carries a single `cost_usd` column, so we had to decide
*which* row(s) carry the cost without it summing to 4× the truth.

## Decision

Every category row for a given (machine, provider, model, report_type, bucket) carries
the **same** full model/bucket `cost_usd` (replicated). The hero **token** total sums
`tokens` across all daily rows normally. The hero **cost** total is computed by taking
the cost **once per (machine, provider, model, bucket) group** (`MAX(cost_usd)` per
group) and summing those — so replication never inflates it.

## Why

- **Tokens and cost live at different natural grains** (per-category vs per-model).
  Replicate-then-dedup keeps each row self-describing (you can read any row and know
  its model's cost) while the aggregation stays correct.
- **Robust to a zero category.** Alternatives that pin cost to one designated category
  row (e.g. "cost rides on the output row") break if that category is absent or zero.
  Replication has no such fragile assumption.
- **Idempotent under re-post.** A re-posted model/bucket upserts the same replicated
  cost on each category row; the group-wise `MAX` still yields exactly one cost. The
  idempotency test asserts cost does not multiply on re-post.

## Alternatives

- **Cost on a single canonical category row, 0 elsewhere.** Simpler SUM, but
  nondeterministic/fragile when that category is missing; surprising to read a row
  whose cost is 0 despite real spend. Rejected.
- **A separate `costs` table at model/bucket grain.** Cleanest in theory, but a second
  write path and join for a number that is "supporting, not hero" in phase 1. Deferred;
  revisit if phase-3 pricing wants per-category cost (it computes from tokens × price,
  so likely won't need stored per-category cost).

## Consequences

- The summary's cost query groups by (machine, provider, model, bucket) before summing.
  Documented in `packages/server/src/db.ts` (`heroCostStmt`).
- Phase-3 cost-as-an-instrument can recompute cost from token granularity × per-model
  pricing and need not trust ccusage's `cost_usd` at all; this decision doesn't block
  that.
