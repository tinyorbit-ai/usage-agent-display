# 0013 — Distribution & deployment: compiled daemon + self-host server

Part of [[../index]]. Status: **accepted** (2026-06-06, phase 8).

## Context

Phase 1–7 ran everything on one machine. To use this for real the server must be
reachable from any machine (home, laptop, work laptop) and the daemon must install on
machines that don't have the repo. The owner runs a private multi-repo deploy system
(PM2 + Doppler + Cloudflare Tunnel) on a VM.

## Decision

1. **Daemon ships as a single compiled binary.** `bun build --compile` embeds the Bun
   runtime + the daemon into one file, per platform (macOS arm64/x64, linux x64) via
   `scripts/build-daemon.ts` → `dist/`. Config stays env-driven (`USAGE_SERVER_URL`,
   `USAGE_BEARER_TOKEN`, `USAGE_MACHINE_ID`). ccusage is **not** bundled — the daemon
   still spawns it, so the host needs `bunx`/`npx` (or `USAGE_CCUSAGE_CMD`).
2. **Server deploys via the self-host deploy system**, not a bespoke recipe. It carries a
   `packages/server/ecosystem.config.js` (PM2 app `usage`, `interpreter: bun`, Doppler
   `envVars`, `publicInternet.enabled`). The repo is listed in the deploy system's `repos.json`
   with `appsDir: "packages"`; the deploy system clones, root-installs the workspace,
   and runs it.
3. **Public URL, bearer-gated.** `publicInternet` → a Cloudflare Tunnel hostname
   `https://usage.<baseDomain>`. Safe to expose because *every* data request needs the
   shared bearer token (read path included, [[0003-daemon-auth-bearer]]). The only
   unauthenticated route is `GET /health` (liveness; no data).
4. **One secret, one source.** `USAGE_BEARER_TOKEN` lives in Doppler
   (`USAGE_AGENT_BEARER_TOKEN`); the same value goes on each daemon and the firmware
   `config.h`. No token literal in any repo.

## Why

- A compiled binary is the lowest-friction install on a machine that isn't a checkout —
  copy one file, set three env vars, run.
- Reusing the self-host deploy system means PM2 lifecycle, Doppler secret injection, HTTPS, and the
  tunnel are already solved; the app just declares what it needs.
- A public URL + bearer is the simplest "reachable from anywhere" that doesn't add an
  auth system we don't need — the token we already have *is* the auth.

## Alternatives

- **Tailscale-only (no public URL).** Private and simple, but every machine must be on
  the tailnet; the brief wants "any machine". Bearer-gated public URL is more portable.
  (Tailscale remains available as the VM's own hostname.)
- **Docker image for the server.** Heavier than the existing PM2/Bun path the deploy system
  already runs; no benefit here.
- **Bundle ccusage into the daemon binary.** ccusage is a CLI without a stable library
  API; spawning the pinned CLI keeps the daemon format-agnostic ([[0002-ccusage-invocation]]).

## Consequences

- `dist/` binaries are build artifacts (gitignored); rebuild with `bun run build:daemon`.
- The deploy system's `repos.json` gains a `usage-agent-display` entry (owner commits there — that
  repo is confidential). The GitHub repo must exist + be pushed for the VM to clone it.
- **Firmware still speaks plain HTTP to a LAN address.** Reaching the *public HTTPS* URL
  from the ESP32 needs `WiFiClientSecure` (TLS) — deferred to a follow-up
  ([[../improvements]]); on the home LAN the CYD can keep hitting the VM's local/tailscale
  address over HTTP.
