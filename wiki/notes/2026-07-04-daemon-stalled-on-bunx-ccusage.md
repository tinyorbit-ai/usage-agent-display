# 2026-07-04 — Local daemon stalled inside `bunx ccusage`

Part of [[../index]]. Operational incident: the `epic` daemon process was alive, but the
display only showed fresh `work-mbp` data.

## Timeline

1. The display showed the work laptop's Claude total, while this Mac had fresh local Claude
   usage that was not appearing.
2. `launchctl list` showed `com.usage.daemon` alive as PID 878, started 2026-06-26.
3. `GET /usage/summary` showed `work-mbp` fresh at 27s, but `epic` stale at 129807s.
4. The `epic` process tree showed PID 878 waiting on `bunx ccusage daily --json`, started
   2026-07-03 09:18:10, with a child `bun add ccusage@latest --no-summary --no-cache --force`
   still running in `/private/tmp/bunx-501-ccusage@latest`.
5. Running the repo-local pinned `packages/daemon/node_modules/.bin/ccusage daily --json`
   completed successfully and returned current local data.

## Root cause

The installed service had `USAGE_CCUSAGE_CMD=/Users/mhdev/.bun/bin/bunx ccusage`. In the
launchd environment that resolved through Bun's temporary `bunx` install path and started a
network install of `ccusage@latest`; that install hung. The daemon awaited the child with no
timeout, and the loop intentionally schedules the next tick only after the current tick
finishes. One stuck external command therefore stopped every later collect/post tick while
the parent daemon process still looked healthy.

## Decision forced

The daemon now treats external collectors as fallible dependencies with a watchdog. Each
ccusage report subprocess has a configurable timeout, and the one-command installer writes
`USAGE_CCUSAGE_CMD` as a JSON argv array containing the absolute Bun binary plus the pinned
workspace ccusage script in `packages/daemon/node_modules/.bin/ccusage`. `bunx ccusage` is
no longer a generated service default because it violates
[[../decisions/0002-ccusage-invocation]]'s no-per-run-network intent.

## What it demonstrates

- **A live parent process is not a live data path.** The freshness source of truth is the
  server's accepted post age, not whether launchd still has a PID.
- **Every external command needs a wall-clock bound.** The daemon correctly isolated thrown
  collector errors, but a never-exiting child is a different failure mode.
- **Pinned dependency decisions must survive packaging.** The package pinned ccusage, but
  the generated service config escaped through bare `bunx ccusage`, reintroducing `latest`
  and network behavior at runtime.
