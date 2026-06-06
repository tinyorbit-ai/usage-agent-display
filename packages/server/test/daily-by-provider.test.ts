// Phase 10 gate (automated): /usage/summary carries `daily_by_provider` — the combined
// `daily` token series split per provider, index-aligned to `daily`'s ACTUAL bucket axis
// (the latest buckets-with-data, length can be < 14, gaps collapsed — NOT a fixed-14
// calendar). Fixtures use the SHAPE production emits (≥2 machines, ≥2 models per provider,
// 4 replicated category rows, a re-posted/deduped row) with distinct per-index AND
// per-provider values, so a reversed/shifted series, a SUM-vs-dedup error, a fixed-14
// assumption, or a combined↔split drift all FAIL. See wiki/learnings.md 2026-06-06.
import { describe, expect, test } from "bun:test";
import type { SnapshotRow, TokenCategory, UsageSummary } from "@usage/shared";
import { getFullSummary, ingest, makeHarness, row } from "./helpers.ts";

const CONFIG = { staleAfterSeconds: 120, timezone: "UTC" };
const CATS: TokenCategory[] = ["input", "output", "cache_read", "cache_write"];

/** The 4 replicated category rows the real daemon emits for one (machine,model,bucket). */
function quad(over: Partial<SnapshotRow>, perCategoryTokens: number): SnapshotRow[] {
  return CATS.map((token_category) => row({ ...over, token_category, tokens: perCategoryTokens, cost_usd: 0 }));
}

/** Sum over providers at each index equals the combined `daily` — the structural invariant. */
function expectConsistent(s: UsageSummary): void {
  const split = s.daily_by_provider!;
  for (let i = 0; i < s.daily.length; i++) {
    const sum = Object.values(split).reduce((a, arr) => a + (arr[i] ?? 0), 0);
    expect(sum).toBe(s.daily[i]!.tokens);
  }
}

describe("phase 10 — daily_by_provider", () => {
  test("exact per-index split, aligned to a <14 axis with a calendar gap, production shape", async () => {
    // Axis = the four buckets-with-data 06-01 / 06-03 / 06-04 / 06-05 (06-02 is a real gap):
    // daily.length === 4, NOT 14, and not contiguous. Each (provider,bucket) total is built
    // from ≥2 machines / ≥2 models / 4 replicated category rows so a SUM-vs-dedup or a
    // cross-machine/cross-model double-count would change the asserted numbers.
    const h = makeHarness(undefined, CONFIG);
    await ingest(h, "mbp-14", [
      ...quad({ provider: "claude-code", model: "opus", bucket: "2026-06-01" }, 10), // cc B0 = 40
      ...quad({ provider: "claude-code", model: "opus", bucket: "2026-06-04" }, 22), // cc B2 = 88
      ...quad({ provider: "claude-code", model: "opus", bucket: "2026-06-05" }, 5), //  cc B3 part = 20
      ...quad({ provider: "codex", model: "gpt-5", bucket: "2026-06-03" }, 9), //       codex B1 = 36
    ]);
    await ingest(h, "studio", [
      ...quad({ provider: "claude-code", model: "sonnet", bucket: "2026-06-03" }, 15), // cc B1 = 60
      ...quad({ provider: "claude-code", model: "sonnet", bucket: "2026-06-05" }, 8), //  cc B3 part = 32 ⇒ B3 = 52
      ...quad({ provider: "codex", model: "gpt-5", bucket: "2026-06-01" }, 11), //        codex B0 = 44
      ...quad({ provider: "codex", model: "o3", bucket: "2026-06-05" }, 7), //            codex B3 = 28
      // codex has NO row on 2026-06-04 (B2) → must be an explicit 0, not a dropped slot.
    ]);
    // A re-posted (deduped) row: re-send one B3 cc quad verbatim. Upsert by key ⇒ no
    // double-count; cc[3] must stay 52, proving the split rides on deduped stored rows.
    h.clock.advance(5_000);
    await ingest(h, "mbp-14", quad({ provider: "claude-code", model: "opus", bucket: "2026-06-05" }, 5));

    const s = await getFullSummary(h);

    // Axis is the actual buckets-with-data, length 4 (NOT 14), gap collapsed.
    expect(s.daily.map((d) => d.date)).toEqual(["2026-06-01", "2026-06-03", "2026-06-04", "2026-06-05"]);
    expect(s.daily).toHaveLength(4);

    const split = s.daily_by_provider!;
    // Exact arrays, position by position — a reversed or off-by-one series fails here.
    expect(split["claude-code"]).toEqual([40, 60, 88, 52]);
    expect(split["codex"]).toEqual([44, 36, 0, 28]);

    // Every provider array is length-aligned to the combined axis (4), never a fixed 14.
    for (const arr of Object.values(split)) expect(arr).toHaveLength(s.daily.length);

    // Sparse provider: explicit 0 at the bucket it had no usage on (index 2), not a gap.
    expect(split["codex"]![2]).toBe(0);

    // Structural consistency: Σ providers === combined daily, bucket by bucket.
    expect(s.daily.map((d) => d.tokens)).toEqual([84, 96, 88, 80]); // 40+44, 60+36, 88+0, 52+28
    expectConsistent(s);
  });

  test("provider present in a timeframe but idle on the graph window ⇒ daily.length all-zeros, not a missing key", async () => {
    // 15 days of claude-code usage ⇒ axis = latest 14 (daily.length === 14); the oldest day
    // (2026-05-22) falls off. gemini's ONLY usage is on that fallen-off day, so gemini has
    // all-time usage (it appears in timeframes' by_provider) yet nothing on the graph axis.
    const h = makeHarness(undefined, CONFIG);
    const days: string[] = [];
    for (let d = 22; d <= 31; d++) days.push(`2026-05-${d}`); // 05-22 … 05-31
    for (let d = 1; d <= 5; d++) days.push(`2026-06-0${d}`); // 06-01 … 06-05  → 15 days
    expect(days).toHaveLength(15);
    await ingest(
      h,
      "mbp-14",
      days.map((bucket, k) => row({ provider: "claude-code", model: "opus", bucket, tokens: 100 + k })),
    );
    // gemini only on the day that falls off the latest-14 axis.
    await ingest(h, "studio", [row({ provider: "gemini", model: "gemini-3-pro", bucket: "2026-05-22", tokens: 500 })]);

    const s = await getFullSummary(h);

    expect(s.daily).toHaveLength(14); // latest-14, the 15th (05-22) dropped
    expect(s.daily[0]!.date).toBe("2026-05-23"); // 05-22 fell off the front
    const split = s.daily_by_provider!;

    // gemini is present all-time → MUST have a key, as a same-length all-zeros array.
    expect(s.by_provider.some((p) => p.provider === "gemini")).toBe(true);
    expect(split["gemini"]).toEqual(new Array(14).fill(0));
    expect(split["gemini"]).toHaveLength(s.daily.length);

    // Every provider in by_provider has a key in the split (present ⇒ key present).
    for (const p of s.by_provider) expect(split[p.provider]).toBeDefined();
    expectConsistent(s);
  });

  test("splits only canonical daily rows — session/monthly rows for the same provider don't inflate", async () => {
    const h = makeHarness(undefined, CONFIG);
    await ingest(h, "mbp-14", [
      row({ provider: "claude-code", model: "opus", bucket: "2026-06-05", tokens: 30 }), // the only daily row
      row({ provider: "claude-code", model: "opus", report_type: "session", bucket: "s1", tokens: 9999,
            activity_at: Date.parse("2026-06-05T11:00:00Z") }),
      row({ provider: "claude-code", model: "opus", report_type: "monthly", bucket: "2026-06", tokens: 5000 }),
    ]);
    const s = await getFullSummary(h);

    expect(s.daily).toHaveLength(1); // session/monthly buckets do not become graph buckets
    expect(s.daily_by_provider!["claude-code"]).toEqual([30]); // daily only, not 9999/5000
    expectConsistent(s);
  });

  test("open provider ids that collide with Object.prototype members are real keys, not dropped (and don't pollute)", async () => {
    // `provider` is an open string. With a plain `{}` map, an id like `__proto__` /
    // `constructor` makes `series[p] ??=` read the inherited member (truthy ⇒ no own key)
    // and then mutate Object.prototype — silently dropping that provider's series and
    // polluting the prototype process-wide. The null-prototype map fixes both. (codex catch.)
    const h = makeHarness(undefined, CONFIG);
    await ingest(h, "mbp-14", [
      row({ provider: "__proto__", model: "a", bucket: "2026-06-04", tokens: 11 }),
      row({ provider: "__proto__", model: "a", bucket: "2026-06-05", tokens: 13 }),
      row({ provider: "constructor", model: "b", bucket: "2026-06-04", tokens: 5 }),
      row({ provider: "claude-code", model: "opus", bucket: "2026-06-05", tokens: 7 }),
    ]);
    const s = await getFullSummary(h);
    const split = s.daily_by_provider!;

    // Axis = [06-04, 06-05]; every provider (incl. the prototype-colliding ids) is a key.
    expect(s.daily.map((d) => d.date)).toEqual(["2026-06-04", "2026-06-05"]);
    expect(Object.getOwnPropertyNames(split).sort()).toEqual(["__proto__", "claude-code", "constructor"]);

    // Read via descriptor so the `__proto__` accessor never interferes with the assertion.
    const val = (k: string): unknown => Object.getOwnPropertyDescriptor(split, k)?.value;
    expect(val("__proto__")).toEqual([11, 13]);
    expect(val("constructor")).toEqual([5, 0]); // sparse on 06-05 ⇒ explicit 0
    expect(val("claude-code")).toEqual([0, 7]);

    // Sum invariant survives prototype-colliding provider ids (no dropped key).
    expect(s.daily.map((d) => d.tokens)).toEqual([16, 20]); // 11+5+0, 13+0+7
    expectConsistent(s);

    // Building the map did not pollute Object.prototype with the bar indices.
    expect(Object.prototype.hasOwnProperty("0")).toBe(false);
    expect(Object.prototype.hasOwnProperty("1")).toBe(false);
  });

  test("empty store ⇒ empty daily and an empty split object", async () => {
    const h = makeHarness(undefined, CONFIG);
    const s = await getFullSummary(h);
    expect(s.daily).toEqual([]);
    expect(s.daily_by_provider).toEqual({});
  });

  test("serialized summary stays ≤ ~6KB at a worst-realistic load (firmware parses it unbounded today)", async () => {
    // The currently-shipped firmware parses /usage/summary with an unbounded JsonDocument
    // (main.cpp:286), so a large additive payload risks a parse-fail / heap-spike before
    // phase 12 moves the parse onto the bounded core. Bound the field by keeping it to the
    // providers actually present and assert the whole serialized summary stays small under a
    // worst-realistic fixture: 4 machines × 3 providers × 2 models × 14 distinct days.
    //
    // SCOPE (codex phase-10 review): this proves the *realistic* deployment bound — the
    // brief's three-year fit is the 3 branded agents, and phase 12 renders exactly those 3
    // fixed chips. It does NOT prove an *adversarial* bound: the contract accepts unbounded
    // providers / 256-char ids, and the summary as a whole has been provider/machine-unbounded
    // since phases 2/7 (by_provider, by_machine, timeframes). That residual risk is owned by
    // phase 12's bounded on-device parse, recorded in wiki/improvements.md — not by a
    // server-side cap here (a cap would break the present⇒key + Σ==daily gate invariants).
    const h = makeHarness(undefined, CONFIG);
    const machines = ["mbp-14", "studio", "mini", "laptop"];
    const providers: { provider: string; models: [string, string] }[] = [
      { provider: "claude-code", models: ["opus", "sonnet"] },
      { provider: "codex", models: ["gpt-5", "o3"] },
      { provider: "gemini", models: ["gemini-3-pro", "gemini-3-flash"] },
    ];
    const days: string[] = [];
    for (let d = 23; d <= 31; d++) days.push(`2026-05-${d}`); // 05-23 … 05-31
    for (let d = 1; d <= 5; d++) days.push(`2026-06-0${d}`); //  06-01 … 06-05  → 14 days
    expect(days).toHaveLength(14);

    for (const m of machines) {
      const rows: SnapshotRow[] = [];
      for (const p of providers) {
        for (const model of p.models) {
          for (const [k, bucket] of days.entries()) {
            rows.push(...quad({ provider: p.provider, model, bucket }, 1000 + k));
          }
        }
      }
      await ingest(h, m, rows);
    }

    const s = await getFullSummary(h);
    expect(s.daily).toHaveLength(14);
    expect(Object.keys(s.daily_by_provider!)).toHaveLength(3);

    const bytes = new TextEncoder().encode(JSON.stringify(s)).length;
    // ~6KB ceiling for the shipped firmware's unbounded parse (ADR-recorded; phase 12
    // moves the live parse onto the bounded host-tested core).
    expect(bytes).toBeLessThanOrEqual(6 * 1024);
  });
});
