# What I'd do with more time

Part of [[index]]. Running, honest list. Deliberate scope cuts go here too —
"deferred X for Y" is a positive signal, not an apology.

## Phase 1

- **✅ RESOLVED (2026-06-06) — Codex (and Gemini) data source now native in ccusage.**
  Was: the provider seam shipped but real Codex usage wasn't collected (ccusage 16.2.4
  exposed no usable Codex flag). As of 2026-06-06, `ccusage monthly --json` tags rows
  with `metadata.agents` and detects **`claude`, `codex`, `gemini`** natively (plus
  opencode/amp/droid/copilot/qwen/kimi via subcommands) — closed at the source with
  **zero core changes**, exactly as the provider-agnostic schema
  ([[decisions/0004-ingest-dedup-model]]) bet. Full writeup:
  [[notes/2026-06-06-ccusage-multi-agent]]. The only remaining piece is *operational* —
  point each daemon's collector at the right ccusage subcommand and tag the provider.
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

## Retro action items (2026-06-06)

- **~~Confirm the Codex data source~~ — done upstream (2026-06-06); now only the TZ half
  remains.** ccusage went multi-agent ([[notes/2026-06-06-ccusage-multi-agent]]), so the
  data-source half is closed. The direct-parse collector (raw `~/.codex` / `~/.claude`
  per-event timestamps) is now justified **solely** by the producer-bucket TZ limit, not
  by missing Codex data — lower priority than this item originally implied.
- **Hardware/visual gates pending one board bring-up** — live A→B update (P1), tile
  states + desaturated-photo legibility (P2), cost tile (P3), sparkline/glow/ticker (P4),
  unattended full-day run (P5). Batched to the end; board now on USB.

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
