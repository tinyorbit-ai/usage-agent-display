# 0003 — Daemon → API auth: shared bearer token

Part of [[../index]]. Status: **accepted** (2026-06-05, plan).

## Context

Per-machine daemons POST usage snapshots to the central API over a network (LAN /
Tailscale). The system is single-tenant and self-hosted, but an unauthenticated
`/ingest` would let anything on the network corrupt the store with bogus snapshots.
We need *enough* auth, not a product-grade identity system.

## Decision

A **shared bearer token**: one secret held in an env var on each daemon and the
server. The daemon sends `Authorization: Bearer <token>`; the server rejects `/ingest`
without the matching token. Run it over LAN/Tailscale on top of that.

## Why

- **Right-sized for single-tenant** — one secret, trivial to rotate, no accounts/CA.
- **Stops the real threat** — accidental or stray POSTs corrupting aggregation.
- **Composes with network trust** — Tailscale/LAN already limits reachability; the
  token is defense-in-depth, not the only wall.

## Alternatives

- **Tailscale-only, no app auth** — zero code, but anything on the tailnet can write,
  and it couples correctness to network posture. Rejected as the *sole* control.
- **mTLS / client certs** — strongest, but cert lifecycle management is real ceremony
  for a desk panel. Rejected as overkill at this scope.

## Consequences

- Token lives in daemon + server config (env), never committed; setup docs cover it.
- `GET /usage/summary` (read-only, consumed by the CYD) may stay unauthenticated or
  use the same token — decided at the firmware phase (a simple token in firmware
  config is fine; the screen only reads).
- If multi-device write trust ever needs per-machine revocation, revisit with
  per-machine tokens (a new ADR).
