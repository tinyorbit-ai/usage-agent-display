# 2026-06-06 — ccusage went multi-agent; the Codex data-source gap closed itself

Part of [[../index]]. A note, not an incident — a deferred risk that an upstream
dependency quietly retired for us.

## What happened

Through phases 1–5 the brief's "Claude Code **+ Codex**" promise was carried by the
**provider seam**, not real Codex data: ccusage 16.2.4 exposed no usable Codex flag on
this machine, so we shipped the provider-agnostic collector and proved it with fixture
providers rather than fabricate numbers (see [[../improvements]] phase-1 deferral and
the [[../retro]] "Codex data source still stubbed" open thread).

Running `npx -y ccusage@latest monthly --json` on 2026-06-06 returns rows tagged with
`metadata.agents`, and across five months this machine shows **three agents detected
natively — `claude`, `codex`, `gemini`** — plus a `--help` listing a dozen more
(opencode, amp, droid, copilot, qwen, kimi, …). Live cross-check: 3.36 B tokens / ~$2,385
across 12 models spanning all three vendors.

## Why it matters

The single biggest functional gap named in the retro is **closed at the source**. And it
closed with **zero core changes** — exactly the bet [[../decisions/0004-ingest-dedup-model]]
made when it kept `provider`/`model` as open strings and the aggregation
provider-agnostic. The 3-year-fit work in phase 5 (the `Collector` registry,
`USAGE_CCUSAGE_CMD`) means adding Gemini/Codex is now just *pointing the daemon at the
right ccusage subcommand*, not new aggregation code. This is the seam paying off rather
than a feature we had to build.

## What this does NOT fix

The **producer-bucket timezone limit** is unchanged. ccusage still pre-aggregates by the
producer machine's local calendar date with no intra-day timestamps, so month/projection/
budget near a day boundary still inherit that limit ([[../improvements]] phases 2–3). The
unlock for *that* remains a direct-parse collector reading raw per-event timestamps — so
the two threads the retro bundled together have now **split**: the data-source half is
done upstream; only the timestamp-granularity half still warrants the direct-parse ADR.

## Decision it forces

- Treat the multi-agent invocation as the **default daemon collector** going forward;
  the per-provider daemon split (`USAGE_PROVIDER` + per-provider command) is how we tag
  rows. Recorded against [[../decisions/0002-ccusage-invocation]] (consequences updated).
- The direct-parse collector is now justified **only** by the TZ-precision limit, not by
  missing Codex data. Lower priority than the retro implied.
