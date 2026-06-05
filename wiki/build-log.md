# Build log

Part of [[index]]. One entry per phase: the verifiable gate that was met before
merge. Newest on top. Appended by `forge-ship`.

## Phase 1 — Aggregate two machines, show the number on the CYD
**Branch:** `phase/1-aggregate-and-show` → squashed to `main` (`6038248`)

- Monorepo (Bun workspaces): `@usage/shared` (v1 `/usage/summary` wire contract +
  snapshot types), `@usage/server` (Bun+SQLite: `POST /ingest` dedup-upsert, `GET
  /usage/summary` daily-only hero), `@usage/daemon` (ccusage collector seam →
  normalized rows → bearer POST), `firmware/` (ESP32 LVGL; pure host-tested state core).
- **Why the notable shapes:** dedup keyed by (machine,provider,model,token_category,
  report_type,bucket) with **server `received_at` governing** conflicts and the hero
  pinned to the **`daily`** report type — [[decisions/0004-ingest-dedup-model]]. Cost
  replicated per category row, de-duplicated per model/bucket when summing —
  [[decisions/0006-cost-attribution-grain]]. Firmware split into a dependency-free,
  host-compilable core so the fetch/parse/state matrix is tested without a board —
  [[decisions/0007-firmware-host-testable-core]]. Bearer auth on both endpoints
  ([[decisions/0003-daemon-auth-bearer]]); all SQL through one prepared-statement module.
- **Review (Codex adversarial pass) fixed 5 findings**, incl. two high: a destructive
  "floor-to-0" normalize default that would UPSERT-zero the hero (now skips corrupt/
  drifted breakdowns), and making "received_at governs" load-bearing in the upsert.
  Lessons in [[learnings]].
- **Scope deferred:** real Codex data-source wiring (provider seam shipped); gitleaks
  fallback scan until installed — see [[improvements]].
- **Gate:** `bun run gate` — typecheck + no-raw-SQL static check + secrets scan + 73
  unit tests (aggregation, idempotency, cumulative-dedup 100→150=150, canonical-report
  no-inflation, clock-skew, received_at-governs, auth 401s, validation, log-redaction,
  contract) + firmware off-device state matrix (15/15) + e2e (2 machines, dedup,
  daily-only = 1700) — **green**. Cross-checked with real ccusage: 552 rows round-trip
  daemon→server→summary, daily-only hero ≈ 2.15B tokens.
- **Hardware half (pending, non-blocking):** on-device A→B live-update confirmation to
  be recorded here when at the board (per the plan's hardware-gate rule, the software
  gate unblocks the merge).
