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
