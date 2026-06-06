# Learnings

Part of [[index]]. Running log appended by `forge-review`. Newest on top. One entry
per review pass that found something worth remembering. Later builds/reviews read
and enforce these.

<!-- Entry shape:
## YYYY-MM-DD — Phase N — <short title>
- **Found:** <what the review caught>
- **Fixed:** <how it was resolved>
- **Rule to remember:** <generalizable lesson, phrased so the next build avoids it> -->

## 2026-06-06 — Phase 12 — A green host suite + a clean build is not "it runs on the device"
- **Found:** (on-device flash, not any automated check) The reworked `updateGraph()` set the
  LVGL bar chart's `point_count` to 1 at boot (before the first poll, `dailyN == 0`). LVGL's
  bar renderer spaces columns with `/ (point_cnt - 1)` → **IntegerDivideByZero**, boot loop.
  All three host suites passed, `pio` linked clean, and the HTML mock looked right — only the
  hardware flash caught it. See [[notes/2026-06-06-chart-point-count-divide-by-zero]].
- **Fixed:** clamp `point_count` to a minimum of 2; write 0 to the extra point(s). An empty
  axis draws flat zero bars instead of crashing.
- **Rule to remember:** Logic that renders "from current state" must be correct for the
  EMPTY state that exists before the first fetch — a device's first render is almost always
  of no data. And third-party draw/widget routines have arithmetic preconditions (here an
  implicit "≥ 2 points" from a `n-1` divisor): keep inputs inside their domain. The
  host-testable core can't reach the LVGL/SPI render path, so the **on-device hardware gate
  is load-bearing**, not ceremony — a firmware phase isn't done when the suite is green.

## 2026-06-06 — Phase 12 — Bound the body at READ time, and never narrow a wide value to a display int
- **Found:** (codex, 1 high + 2 med) (a) `parsePanel` enforced `kMaxBodyBytes`, but the
  firmware called `http.getString()` FIRST — the whole oversized body was allocated on the
  heap before the cap ran, so the DoS guard couldn't actually prevent the OOM it existed to
  stop. (b) Per-day token counts (billions) were stored as 32-bit `long` and cast straight
  to LVGL's 16-bit `lv_coord_t` for the bars — any day > 32k tokens wrapped to a garbage
  height, silently lying. (c) The `n==0` graph path set the point count to 1 but wrote no
  value, so LVGL kept the previous first bar after the axis emptied.
- **Fixed:** (a) `readBoundedBody()` streams into a fixed buffer and aborts the moment a
  declared or streamed length crosses `kMaxBodyBytes` — the cap is enforced before the heap
  fills. (b) Token series are `long long` end-to-end; the chart normalizes each bar to a
  fixed `0..kGraphScale` range against the series' own 64-bit max, so nothing is ever
  narrowed to the raw coord type. (c) `updateGraph` writes EVERY declared point by index
  (clear-before-fill), including a 0 in the empty path.
- **Rule to remember:** A size cap that runs AFTER the allocation is decorative — enforce it
  at the boundary where the bytes arrive. And never cast a wide domain value (token counts,
  timestamps) directly into a narrow UI/coord type; normalize into the display range first.
  "Set the point count" is not "set the points" — write every cell you declare.

## 2026-06-06 — Phase 11 — A sensor's "present" pin is not the same as "valid reading"
- **Found:** (codex, high) The touch loop trusted XPT2046 `getPoint()` x/y on any
  PENIRQ-low sample but ignored the pressure (`z`). On a noisy/low-pressure edge the chip
  returns stale coordinates at `z≈0`, so a phantom edge could route the *previous*
  coordinate and flip to the wrong tab. (codex also caught: hit-box geometry didn't match
  its own doc — `{11..49}` is 39px with a 1px gap, not the documented 38px/2px-gap.)
- **Fixed:** Folded pressure into the host-tested core: `touchGate` now takes `rawZ` and a
  per-board `minPressure`; a sample counts as a touch only when PENIRQ asserts AND `z`
  clears the threshold — so an invalid-pressure edge can neither route nor consume a
  press. Added a host test (PENIRQ asserted + low z → no tap, press not consumed). Fixed
  the hit-boxes to true 38px with 2px dead gaps and asserted both gap pixels route to None.
- **Rule to remember:** An interrupt/"present" line (PENIRQ, DataReady, a GPIO flag) only
  says *a* reading exists, not that it's *valid*. Gate on the value's own quality signal
  (pressure, CRC, range) before acting, and put that gate in the host-tested core — not as
  an untested one-liner in the I/O shell. And when a comment states a geometry (px sizes,
  gaps), assert it: a 1px drift between doc and table is invisible until a finger finds it.

## 2026-06-06 — Phase 10 — An open string used as an object key needs a null-prototype map
- **Found:** (codex, high) `daily_by_provider` was assembled into a plain `{}` keyed by the
  **open-string** `provider` id. An id colliding with an Object.prototype member
  (`__proto__`, `constructor`, `toString`, …) made `series[p] ??= […]` read the inherited
  member (truthy ⇒ no own key written) and then `series[p][i] = tokens` **mutate
  `Object.prototype` process-wide** — dropping that provider's series (breaking the
  Σ-providers === daily invariant) AND polluting the prototype for the whole server. The
  field passed validation (`provider` is any 1–256-char string), so it was reachable.
- **Fixed:** Build the map with `Object.create(null)` (no inherited names ⇒ every open id is
  a plain own key); added a regression test with provider ids `__proto__`/`constructor`
  asserting both become real keys, the sum invariant holds, and `Object.prototype` is not
  polluted.
- **Rule to remember:** When an **open/untrusted string** becomes an **object key**, use
  `Object.create(null)` or a `Map` — never a plain `{}`. This is the key-side twin of the
  existing open-string traps (dedup key via `JSON.stringify`, anchored price matching): an
  open string in any structural position (dedup key, map key, price class) is a
  silent-collision/pollution trap until it's contained.

## 2026-06-06 — Retro synthesis (P6–9) — An architectural discipline needs a tripwire, or it erodes
- **Pattern (P7, carried through P8/P9):** the host-testable firmware core
  ([[decisions/0007-firmware-host-testable-core]]) — a *"kept"* win in the 1–5 retro —
  silently regressed the moment phase 7's UI ambition rewrote `main.cpp` standalone, and
  stayed regressed across four landings despite being flagged its own "highest-value
  cleanup" each time. The discipline had no automated enforcement, so the first phase with
  a reason to bypass it did, and nothing failed.
- **Standing rule:** if you *rely* on an architectural invariant (host-testable parse, no
  raw SQL, append-only schema, additive contract), give it an automated tripwire that
  fails the gate when violated — a prose ADR is a wish, not a guard. And when a phase
  defers its own named "highest-value cleanup," the **next** phase's build opens by
  triaging it: keep-deferred (state why) or do-now. A deferral nobody revisits is invisible
  debt, not a scope cut.

## 2026-06-06 — Retro synthesis (P6–9) — A quiet review log means the work changed shape, not that it got safe
- **Pattern:** phases 6–9 produced **zero** new learnings entries; phases 1–5 produced
  fourteen. The difference wasn't review rigor — it was work type. P1–5 wrote to the
  dedup-keyed store (where every high-severity catch lived); P6–9 were
  integration/ops/packaging (pin bump, compiled binaries, deploy config, TLS, secret
  redaction), where the verification grain is "first light on real hardware / binary
  boots clean / leak re-scan clean," not "Codex finds a silent overwrite."
- **Standing rule:** match the gate to the work's failure mode. Dedup-store writes →
  adversarial diff review + the dedup-write checklist below. Integration/ops/hardware →
  runtime proof (real device, real subprocess, real scan), because the bugs there don't
  live in the diff. Don't read an empty learnings log as "nothing to catch" — ask whether
  the *right kind* of verification ran for the kind of work it was.

## 2026-06-06 — Retro synthesis — Scrutinize every write to the deduped store
- **Pattern (across P1/P2/P4/P5):** the single biggest source of high-severity findings
  was writes to the dedup-keyed store that silently collide or overwrite — destructive
  floor-to-0, arrival-order vs activity-order, same-ms collapse, duplicate provider keys.
- **Standing rule:** before shipping any phase that writes to or aggregates the deduped
  store, answer in the diff: (a) what new collisions does the key admit? (b) what does a
  malformed/duplicate/repeat input do? (c) does "most recent/latest" order by a real
  timestamp, not by arrival? Treat this as a build-time checklist, not a review surprise.

## 2026-06-06 — Retro synthesis — Test the regression, not the happy path
- **Pattern (across P1/P2/P3/P4/P5):** the most recurring review fix was strengthening a
  test that passed while a real regression would slip through — one-row dedup fixtures,
  totals instead of exact positions, a line-based grep, a hand-built stand-in for the
  real registry path.
- **Standing rule:** for each new test, name the realistic regression that would STILL
  pass it (a 4× dedup error, a reversed series, an unused code path). If you can't, the
  test is too weak — test the shape production emits, the real entry point, and exact
  positions/indexes.

## 2026-06-06 — Phase 5 — A registry of keys must reject duplicates at build time
- **Found:** (Codex, high) `buildCollectors` accepted two specs with the same provider
  label; their rows would share the dedup key and silently overwrite each other
  (undercount), with no error.
- **Fixed:** Reject duplicate `provider` labels when building the registry; added a
  duplicate-provider test.
- **Rule to remember:** When entries become part of a uniqueness key downstream (a dedup
  key, a map key), validate uniqueness where the set is assembled — a silent collision is
  far harder to diagnose later than a loud build-time error.

## 2026-06-06 — Phase 5 — Invalid config must fail fast, not silently disable a safeguard
- **Found:** (Codex, med) A typo'd `USAGE_RETENTION_DAYS` (e.g. "400d") parsed to NaN and
  silently disabled pruning forever — the store would grow unbounded with no signal.
  The command override also whitespace-split, breaking paths with spaces.
- **Fixed:** `resolveRetentionDays` throws on an invalid value (only an explicit 0
  disables); the ccusage command accepts a spaces-safe JSON-array form. Both extracted
  into testable units with tests for the invalid/edge cases.
- **Rule to remember:** A safeguard that turns itself off on malformed input is worse than
  no safeguard — validate and fail fast. And don't bury config parsing in an entrypoint;
  extract it so the failure modes are testable.

## 2026-06-06 — Phase 5 — Test the production wiring, not a hand-built stand-in
- **Found:** (Codex, med) The extensibility gate built a Collector by hand, bypassing the
  `buildCollectors` registry — so the actual registry/config path could break while the
  "third provider" test stayed green.
- **Fixed:** Added a test that adds a provider THROUGH `buildCollectors` and asserts it
  reaches the summary.
- **Rule to remember:** An extensibility/integration test should exercise the real entry
  point users go through, or it proves the seam works only for a path nobody uses.

## 2026-06-06 — Phase 4 — "Append-only" must be enforced by the schema, not the comment
- **Found:** (Codex, high) The samples table was documented append-only but keyed on
  `(machine_id, received_at)` with `ON CONFLICT DO UPDATE`, so two same-millisecond
  ingests collapsed — potentially erasing a delta and skewing active_machine.
- **Fixed:** Real autoincrement `id` primary key (rowid table), plain INSERT, order by
  `(machine_id, received_at, id)`, boundary by `MAX(id)`.
- **Rule to remember:** If you call a table append-only, give it an autoincrement key —
  a natural composite key with upsert is the opposite of append-only and silently merges.

## 2026-06-06 — Phase 4 — Integer easing truncates to a permanent stall
- **Found:** (Codex, med) `tickerStep` advanced by `floor(gap * fraction)`, which is 0
  for small gaps (1–8 at a 0.12 step) — the hero would sit permanently 1–8 below the
  confirmed total. The bounds invariant held, so no test caught it.
- **Fixed:** Advance by at least 1 token when there's a gap and any forward progress;
  added a small-gap "must reach target" test.
- **Rule to remember:** Integer interpolation needs a minimum step or a fractional
  remainder, or it stalls short of target. Test convergence (reaches target), not just
  the bound (never overshoots).

## 2026-06-06 — Phase 4 — Assert exact positions, not just totals/non-emptiness
- **Found:** (Codex, med) The sparkline test asserted total burn and which values were
  non-zero, so a reversed or off-by-one bucketing would still pass; the firmware "gap"
  test only checked panel classification, never that zero buckets survived parsing.
- **Fixed:** Assert exact bucket indexes server-side; parse the sparkline in the
  host-tested core and assert `[5,0,0,7]` survives unchanged (gaps preserved).
- **Rule to remember:** For ordered/positional data (time-series, buckets), assert the
  exact array/indexes — totals and "is non-empty" let reversal and off-by-one through.

## 2026-06-06 — Phase 3 — Loose substring matching silently mis-prices unknown models
- **Found:** (Codex, high) The price table matched models by substring (with a bare
  `"gpt"` catch-all), so `local-gpt-proxy`, `gpt-oss-120b`, `opus-compatible-test` got
  confidently priced — defeating the whole "unknown model → unpriced, never $0" honesty.
  The test only proved one obviously-unknown name was unpriced.
- **Fixed:** Anchored matching — a Claude model must START with "claude" and name a known
  family; OpenAI/Codex must match a prefix (`gpt-5|gpt-4|o1|o3|codex`); everything else is
  unpriced. Added negative fixtures (substring-but-not-canonical names stay unpriced) and
  real-name fixtures. Verified against real ccusage: opus/sonnet/haiku-4-5/opus-4-8 all price.
- **Rule to remember:** Classifying by `includes(substring)` over open-string identifiers
  is a silent-misclassification trap — anchor to a known prefix/structure, and test the
  *negative* (lookalikes that must NOT match), not just one happy unknown.

## 2026-06-05 — Phase 2 — "Most recent" needs a real activity time, not arrival order
- **Found:** (Codex, high) The active-session pick ordered by `received_at`, but one
  ccusage poll returns ALL sessions → one ingest stamps them with the SAME received_at
  → the tie made "current session" arbitrary. The test masked it by putting each
  session in a separate, time-advanced ingest.
- **Fixed:** Threaded ccusage `lastActivity` → `activity_at` (epoch ms) through the
  contract/validation/schema; the active session orders by `MAX(activity_at)` with
  received_at as a tiebreak. Added a single-ingest multi-session test.
- **Rule to remember:** "Most recent X" must order by X's real timestamp, not by when
  the batch arrived — batched writes share an arrival time and can't be tie-broken by it.
  When a test sets up the scenario across separate writes, ask whether the real producer
  sends it as one batch.

## 2026-06-05 — Phase 2 — A rollup test with one row can't catch a dedup regression
- **Found:** (Codex, med) v2 cost-rollup fixtures used a single token-category row per
  model, so swapping the cost dedup (`MAX`) for `SUM` would 4× real cost yet pass —
  the real daemon emits four replicated-cost rows per model.
- **Fixed:** Added multi-category replicated-cost fixtures for by_provider/by_machine/
  session/month asserting tokens sum but cost counts once.
- **Rule to remember:** Test aggregation with the SHAPE production emits (here: 4
  replicated rows), not a simplified one-row stand-in — otherwise the test can't
  distinguish correct dedup from a 4× overcount.

## 2026-06-05 — Phase 2 — Name the inherent limit instead of faking precision
- **Found:** (Codex, high) Month-to-date used a declared-TZ month *prefix* but filtered
  producer-TZ daily bucket dates — cross-TZ machines near a boundary count by producer
  date. ccusage gives no intra-day timestamps, so true server-TZ re-bucketing is impossible.
- **Fixed:** Documented the guarantee precisely (declared TZ picks the month boundary;
  buckets stay producer-local) at the query and in [[improvements]] — behavior unchanged
  because it's already the best available from ccusage's pre-aggregated data.
- **Rule to remember:** When upstream data can't support the ideal, encode and document
  the *actual* guarantee rather than implying a stronger one. A precise limitation beats
  a silent approximation.

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
