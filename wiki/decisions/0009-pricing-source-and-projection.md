# 0009 — Pricing source & projection method

Part of [[../index]]. Status: **accepted** (2026-06-06, phase 3). *(The plan called
this "ADR 0007"; 0007 was taken during phase 1's build, so it is 0009.)*

## Context

Phase 3 turns cost into an instrument: model-aware spend, EOD/month projection, and an
optional budget. ccusage emits its own `cost_usd`, but it's a black box per model and
gives us no way to (a) price the granular per-category tokens distinctly, (b) project
forward, or (c) know when a model is *unpriced* vs genuinely $0. We needed our own
pricing so the panel can be honest about estimate uncertainty.

## Decision

**Price from our own versioned table, over the granular rows stored since phase 1.** A
per-model, per-token-category table (USD per million tokens), matched to a model by a
lowercased **substring** so it tolerates version suffixes (`claude-opus-4-7` → `opus`)
and stays provider-agnostic. `PRICING_VERSION` stamps every estimate.

- **Unknown model ≠ $0.** Tokens for a model absent from the table accrue to
  `unpriced_tokens`; `partial: true` flags the estimate so the panel shows it as
  approximate, never silently wrong.
- **Projection = linear extrapolation from elapsed fraction.** EOD = today's priced
  spend ÷ (fraction of today elapsed); month = MTD spend ÷ (fraction of month elapsed),
  both reckoned in the declared timezone (consistent with month-to-date). Below one
  minute into a period the fraction is clamped — return spend-so-far, no divide-by-near-zero.
- **Budget is month-based burndown.** `used_pct` = MTD priced spend ÷ limit × 100;
  `over_budget` when MTD exceeds the limit. Absent/0 limit → `budget: null`.
- `totals.cost_usd` stays ccusage-derived (back-compat, the quick number); the new
  `cost` block is the priced instrument the phase-3 panel reads.

## Why

- **Honesty about uncertainty** — `unpriced_tokens`/`partial` makes "we don't price this
  model" visible instead of understating spend. This is the whole point of the phase.
- **Granularity already paid for** — phase 1 stored `model` + `token_category` precisely
  so this needs no migration and no lost history ([[0004-ingest-dedup-model]]).
- **Linear projection is honest and legible** — a desk panel wants "at this rate, ~$X",
  not a forecast model. Elapsed-fraction extrapolation is transparent and testable.
- **Estimate, not billing** — consistent with treating ccusage as observability
  ([[0002-ccusage-invocation]]); `PRICING_VERSION` makes a stale table identifiable.

## Alternatives

- **Trust ccusage `cost_usd`.** Rejected: opaque per category, no projection, and can't
  distinguish unknown-model from $0.
- **Fetch live prices from an API.** Rejected: a network dependency and moving target for
  a self-hosted desk panel; a versioned static table is reproducible and offline.
- **Non-linear projection (e.g. weight recent hours).** Deferred: phase 4's live window
  already captures recent burn; a linear day/month projection is the honest baseline.

## Consequences

- Prices are maintained by hand; a rate change is a `PRICING_VERSION` bump recorded in
  the build log. They will drift from real invoices — acceptable for an instrument.
- The price table is the extension seam for a new provider's models (add an entry), in
  the same spirit as the collector seam.
- Firmware surfaces `over_budget` as a glanceable alert; projection/budget render in the
  cost tile.
