# 0011 — Retention: prune by last-write age, not by bucket date

Part of [[../index]]. Status: **accepted** (2026-06-06, phase 5).

## Context

The server's `snapshots` table is deduped (one row per key), so it grows only with
*distinct* keys — but over years, accumulating daily/session buckets across machines
still grows unbounded for a box meant to run unattended. ccusage retains only ~30 days
locally ([[0004-ingest-dedup-model]]), so old buckets are never re-posted once they
fall out of that window. We needed a retention policy that's safe (never drops live
data) and simple (no scheduler infra).

## Decision

**Prune any snapshot row whose newest write (`received_at`) is older than
`USAGE_RETENTION_DAYS` (default 400).** The daemon re-posts current cumulative data
every tick, refreshing `received_at` on every still-active bucket — so only buckets
that have aged out of ccusage's ~30-day window (and are therefore never re-sent) ever
go stale enough to prune. Runs once at startup and daily thereafter. The phase-4
`total_samples` table is separately pruned to a 2h window.

## Why

- **Safe by construction** — a bucket that's still being reported keeps a fresh
  `received_at` and is never eligible; pruning can only remove genuinely abandoned rows.
  Even if a row were pruned and then re-posted, the upsert simply re-creates it with the
  correct cumulative value (idempotent).
- **No date parsing / mixed grains** — pruning by `received_at` treats daily, session,
  and monthly rows uniformly. Pruning by `bucket` date would have to special-case the
  `YYYY-MM` (monthly) vs `YYYY-MM-DD` (daily) vs session-id (session) formats.
- **Zero infra** — a `setInterval` in the server process; no cron/systemd timer to
  install for a single self-hosted box.

## Alternatives

- **Prune by bucket calendar date** (drop buckets older than N days). Rejected: mixed
  bucket grains, and it would fight a machine that legitimately back-reports an old day.
- **Never prune.** Rejected: unbounded growth defeats "runs unattended"; SQLite would
  keep every day forever.
- **A separate timer service (cron/systemd).** Rejected as overkill — the server is
  always running anyway, so it can prune itself.

## Consequences

- `USAGE_RETENTION_DAYS` is the one knob (default 400 ≈ 13 months, comfortably past
  ccusage's window). 0/unset disables pruning.
- Long-term history beyond the retention window is intentionally not kept; if that's
  ever wanted, archive deduped rows before prune (its own decision).
