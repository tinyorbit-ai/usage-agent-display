# What I'd do with more time

Part of [[index]]. Running, honest list. Deliberate scope cuts go here too —
"deferred X for Y" is a positive signal, not an apology.

## Phase 1

- **Codex collector data-source wiring deferred — provider seam is in place.** The
  brief wants combined Claude Code **+ Codex** usage. ccusage 16.2.4 exposes no
  documented Codex flag on this machine (the old `@ccusage/codex` package now says "use
  ccusage instead"), so rather than fabricate Codex numbers, phase 1 ships the
  provider-tagged collector **seam** ([[decisions/0002-ccusage-invocation]] /
  [[decisions/0004-ingest-dedup-model]]): adding Codex is a new `Collector` emitting the
  same row shape with `provider: "codex"`, and the server's aggregation is already
  provider-agnostic (proven by a two-provider aggregation test + the fixture e2e). What
  remains is resolving the *real* Codex data source (confirm the ccusage Codex
  invocation, or a direct `~/.codex` parse as its own ADR). The hard part — correct
  cross-machine, multi-provider dedup — is done; this is plumbing behind a settled seam.
- **gitleaks not installed locally** — `scan:secrets` uses a focused fallback regex scan
  (bearer/WiFi shapes over tracked files) until `brew install gitleaks` makes the full
  default ruleset available. Config (`.gitleaks.toml`) is committed and ready.
- **Daemon retry is "skip until next tick"**, not backoff/queue. Fine for a desk panel
  (next interval re-posts the same cumulative totals; nothing is lost), but a long
  server outage means no catch-up burst — acceptable given idempotent cumulative posts.

## Phase 2

- **Month-to-date timezone is a boundary choice, not a re-bucketing (inherent limit).**
  ccusage groups daily usage by the *producer machine's* local calendar date and gives
  no intra-day timestamps, so the server can't re-bucket a day into a different TZ. The
  declared `USAGE_RECKONING_TZ` governs *which month is "current"* — one consistent
  boundary across all machines — but the daily bucket dates stay producer-local. Near a
  month edge a far-TZ machine's date can differ by a day. Fixing this fully would mean
  collecting raw per-event timestamps (a direct-parse collector, its own ADR) instead of
  ccusage's pre-aggregated daily rows. Deferred — the current behavior is the best
  available from ccusage and is documented at the query (Codex phase-2 review).

## Phase 3

- **Projection & budget inherit the producer-bucket TZ limit.** EOD/month projection and
  the budget's MTD selection pick daily rows by date-bucket prefix in the declared TZ,
  but the buckets are producer-local dates — so near a day/month boundary a far-TZ
  machine's rows may fall on the "wrong" side. Same root cause and same deferral as the
  month-to-date note above (Codex phase-3 review). Fixing needs raw timestamps.
- **The price table is a flat current-rate estimate, not historical.** All-time
  `priced_usd` values every stored token at today's table rate, so it diverges from
  ccusage's per-period cost (which used the rates in effect then). Acceptable for an
  instrument — it's stamped with `PRICING_VERSION` and ADR 0009 calls it an estimate —
  but a true historical cost would need per-period rate tables.
