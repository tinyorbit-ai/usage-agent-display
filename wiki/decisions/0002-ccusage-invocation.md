# 0002 — ccusage invocation: pinned dependency, not global install

Part of [[../index]]. Status: **accepted** (2026-06-05, plan).

## Context

The per-machine daemon reads Claude Code + Codex usage by shelling out to `ccusage
--json`. `ccusage` is **not** installed globally on this machine (`which ccusage` →
not found), and it will run on several machines. ccusage's Codex support is beta and
its CLI/log format is evolving, so the version actually used matters for
reproducibility.

## Decision

Pin `ccusage` as a **dependency of the daemon package** (`packages/daemon`) and invoke
the local binary (via `bunx ccusage` resolving the pinned version / `node_modules/.bin`),
never a globally-installed one. The daemon shells `ccusage --json` (claude + codex,
unified) and forwards the normalized output.

## Why

- **Reproducible across machines** — every daemon runs the same pinned version; no
  "works on my laptop" drift from differing global installs.
- **No per-run network fetch** — unlike `bunx ccusage@latest`, the pinned dep is
  installed once with the daemon.
- **Daemon stays format-agnostic** — it parses ccusage's stable JSON shape (it has an
  `Agent`/provider column), not raw provider logs. When ccusage breaks on a Codex
  format change, we bump one pinned version, not rewrite a parser.

## Alternatives

- **`bunx ccusage@latest` on demand** — always current, but needs network each run and
  silently changes behavior under us. Rejected: unreproducible.
- **Require a global `ccusage` install** — one less dep, but version drift across
  machines and an undocumented prerequisite. Rejected.
- **Parse `~/.claude/projects` + `~/.codex` JSONL directly** — no ccusage dependency,
  but re-implements an evolving, beta-volatile format. Rejected for now; kept as a
  fallback option if ccusage proves unreliable (would be its own ADR).

## Consequences

- The daemon's `package.json` pins ccusage; upgrades are a deliberate version bump
  recorded in the build log.
- Treat ccusage output as **observability, not billing truth** — cost is best-effort
  (echoed in [[../brief]] non-goals note).
- A `collector` seam wraps the ccusage call so a future direct-parse or a new provider
  slots in behind the same interface ([[0004-ingest-dedup-model]]).
- **Update 2026-06-06:** ccusage went multi-agent — `monthly --json` now tags rows with
  `metadata.agents` and detects `claude` + `codex` + `gemini` natively (the beta Codex
  gap this ADR worried about is gone). The pinned-dependency decision stands; the daemon
  now points its collector at the relevant ccusage subcommand per provider. See
  [[../notes/2026-06-06-ccusage-multi-agent]]. The direct-parse fallback is now motivated
  only by the producer-bucket TZ limit, not by missing provider data.
