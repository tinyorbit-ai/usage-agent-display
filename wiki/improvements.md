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

## Phase 8

- **Firmware can't reach the public HTTPS URL yet.** The CYD does plain HTTP to a LAN
  address. The public server is `https://usage.<baseDomain>` (TLS) — the ESP32 needs
  `WiFiClientSecure` (cert/SNI, more flash + a root CA) to hit it. On the home LAN the
  panel can keep using the VM's local/tailscale address over HTTP; remote HTTPS is a
  follow-up ([[decisions/0013-distribution-and-deployment]]).
- **The GitHub repo must be pushed (private) for the VM to clone it.** vibe-realm
  `repos.json` points at `git@github.com:matteo-hertel/usage-agent-display.git`; create +
  push it, and ensure the VM's deploy key has read access.
- **Doppler key must be set:** `USAGE_AGENT_BEARER_TOKEN` (the shared secret) and,
  optionally, `USAGE_AGENT_BUDGET_USD`. The daemons get the same token value.
- **ccusage isn't bundled in the daemon binary.** It's spawned, so a target machine needs
  `bunx` (install Bun) or `npx` (`USAGE_CCUSAGE_CMD="npx -y ccusage@20.0.6"`). Bundling
  would need a stable ccusage library API, which it doesn't have ([[decisions/0002-ccusage-invocation]]).
- **Per-app `bun install` in a workspace child.** vibe-realm root-installs the monorepo
  (links `@usage/shared`) then per-app installs `packages/server` — fine in practice, but
  if a deploy ever resolves the workspace dep oddly, prefer the root install as source of truth.

## Phase 7

- **Tabs cycle on any tap, not per-tab tapping.** Tap-anywhere → next timeframe via the
  XPT2046 PENIRQ line (GPIO36), which needs no touch-coordinate calibration. Per-tab
  tapping (tap "30D" to jump straight there) needs a touch calibration pass — deferred
  for robustness over polish ([[decisions/0012-panel-visual-system-v2]]).
- **`last_used` is null in practice.** The server field works, but session `activity_at`
  isn't populating from ccusage v20 (session `metadata.lastActivity`), so the footer
  falls back to `active_machine`/blank. Confirm where v20 exposes session activity, or
  derive last-used from the daily series. Same date-granularity caveat would apply.
- **The live firmware fetch/parse is NOT host-tested.** `main.cpp` was rewritten
  standalone for phase 7 and no longer uses `usage_state.h`, so the new poll/`fillTf`
  JSON path has no off-device test — a regression against
  [[decisions/0007-firmware-host-testable-core]]. Extract the parse into a host-compilable
  core (as phase 1 did) or delete the now-unused `usage_state.h`. Highest-value cleanup.
- **Graph is constant across tabs.** The tokens/day-14d bars don't change when you switch
  TODAY/30D/ALL (they're a fixed recent-trend strip). Could make the graph timeframe-aware
  (e.g. hourly for TODAY, monthly for ALL) — deferred; the constant trend reads fine.

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
