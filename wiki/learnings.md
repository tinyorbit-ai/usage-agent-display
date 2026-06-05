# Learnings

Part of [[index]]. Running log appended by `forge-review`. Newest on top. One entry
per review pass that found something worth remembering. Later builds/reviews read
and enforce these.

<!-- Entry shape:
## YYYY-MM-DD — Phase N — <short title>
- **Found:** <what the review caught>
- **Fixed:** <how it was resolved>
- **Rule to remember:** <generalizable lesson, phrased so the next build avoids it> -->

## 2026-06-05 — Phase 1 — Defensive "floor to 0" is destructive on a dedup-upsert path
- **Found:** (Codex, high) `normalize` floored missing/non-numeric/negative token
  fields to `0`. Because ingest UPSERTs by dedup key, a drifted/corrupt ccusage entry
  would emit zero rows that **overwrite** a real daily total — silently zeroing the
  hero. The normalizer test actually *blessed* this ("floored to 0").
- **Fixed:** `rowsForBreakdown` now SKIPS a breakdown that is corrupt (a present-but-
  non-numeric/negative field) or drifted (no recognized token field present), emitting
  nothing so the last-good stored row survives. Absent fields are still a legitimate 0.
  Tests inverted to assert skip + "a drifted entry cannot overwrite".
- **Rule to remember:** On an upsert/last-write-wins path, a "tolerant" default that
  fabricates a value (0, "", now) is **destructive**, not safe — it clobbers good data.
  Tolerant parsing must DROP the record, never invent a field. Never write a test that
  asserts the clobbering behavior is "fine".

## 2026-06-05 — Phase 1 — Make a stated invariant load-bearing in the code, not just prose
- **Found:** (Codex, high) The ADR says "server `received_at` governs" conflicts, but
  the upsert overwrote **unconditionally** — correct only because the server clock is
  monotonic. A clock rollback or stray writer with an older `received_at` could clobber
  fresher data, and nothing tested the invariant.
- **Fixed:** Added `WHERE excluded.received_at >= snapshots.received_at` to the upsert,
  plus DB-level tests (stale loses, fresher wins, equal idempotent). `received_at` is
  now actually load-bearing.
- **Rule to remember:** If an ADR names an invariant ("X governs"), encode it explicitly
  and test it — don't rely on an incidental property (monotonic clock) that holds today.

## 2026-06-05 — Phase 1 — A line-based static check is a false sense of security
- **Found:** (Codex, med) The no-raw-SQL check scanned one line at a time, so multiline
  template interpolation and variable-built SQL (`db.query(sql)`) passed clean. Also
  missing: a row-count / body-size bound on `/ingest`.
- **Fixed:** Rewrote the check to be whole-file and to require the first arg of
  `query/prepare/exec` to be a literal with no `${…}` (flags variables and multiline
  interpolation); added `ROWS_MAX` + a pre-parse body-byte cap (413) with tests.
- **Rule to remember:** A guard is only as strong as its weakest evasion — write the
  bypass and confirm the guard catches it. Validate size/cardinality bounds, not just
  field shapes, on any endpoint that accepts a list.

## 2026-06-05 — Phase 1 — A stray control byte makes a source file "binary" to git
- **Found:** The shared contract's dedup-key helper was joined on a literal NUL byte
  (`\x00`) instead of a space, which made git treat `packages/shared/src/index.ts` as
  **binary** (no diff/blame) — and a delimiter-join is collision-prone anyway.
- **Fixed:** `snapshotDedupKey` now uses `JSON.stringify` of the fixed-order tuple
  (collision-safe, printable); added a contract test incl. a no-control-byte guard.
- **Rule to remember:** Build a composite key with `JSON.stringify(tuple)`, never a
  delimiter join over open strings. If `git diff` shows a text file as "Binary",
  stop — there's a stray control byte in it.
