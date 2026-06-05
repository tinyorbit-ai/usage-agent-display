// Phase 2 gate (automated): /usage/summary v2 carries by_provider[], by_machine[],
// session, month, last_sync — each computed correctly from fixtures (exact values).
import { describe, expect, test } from "bun:test";
import type { SnapshotRow, TokenCategory } from "@usage/shared";
import { getFullSummary, ingest, makeHarness, row } from "./helpers.ts";

// Fixed reckoning so month-to-date is deterministic. Harness clock is 2026-06-05.
const CONFIG = { staleAfterSeconds: 120, timezone: "UTC" };

const CATS: TokenCategory[] = ["input", "output", "cache_read", "cache_write"];

/** The four replicated-cost category rows the real daemon emits for one model/bucket. */
function categoryRows(over: Partial<SnapshotRow>, perCategoryTokens: number, modelCost: number): SnapshotRow[] {
  return CATS.map((token_category) => row({ ...over, token_category, tokens: perCategoryTokens, cost_usd: modelCost }));
}

describe("v2 summary breakdowns", () => {
  test("by_provider splits the daily total across providers", async () => {
    const h = makeHarness(undefined, CONFIG);
    await ingest(h, "mbp-14", [
      row({ provider: "claude-code", model: "opus", tokens: 100, cost_usd: 1 }),
      row({ provider: "codex", model: "gpt-5", tokens: 40, cost_usd: 0.5 }),
    ]);
    const s = await getFullSummary(h);

    expect(s.v).toBe(2);
    const cc = s.by_provider.find((p) => p.provider === "claude-code")!;
    const codex = s.by_provider.find((p) => p.provider === "codex")!;
    expect(cc.tokens).toBe(100);
    expect(cc.cost_usd).toBeCloseTo(1, 6);
    expect(codex.tokens).toBe(40);
    expect(s.totals.tokens).toBe(140);
  });

  test("by_machine splits per machine and includes age + stale flag", async () => {
    const h = makeHarness(undefined, CONFIG);
    await ingest(h, "mbp-14", [row({ tokens: 100 })]);
    await ingest(h, "studio", [row({ tokens: 250 })]);
    h.clock.advance(10_000);
    const s = await getFullSummary(h);

    expect(s.by_machine).toHaveLength(2);
    const mbp = s.by_machine.find((m) => m.machine === "mbp-14")!;
    expect(mbp.tokens).toBe(100);
    expect(mbp.age_seconds).toBe(10);
    expect(mbp.stale).toBe(false);
  });

  test("v2 cost is de-duplicated across replicated category rows, never 4×", async () => {
    // The daemon emits 4 category rows per model with the SAME cost replicated. A
    // MAX→SUM regression in the rollups would 4× the cost here while tokens still sum.
    const h = makeHarness(undefined, CONFIG);
    await ingest(h, "mbp-14", categoryRows({ provider: "claude-code", bucket: "2026-06-05" }, 10, 2.0));
    const s = await getFullSummary(h);

    expect(s.totals.tokens).toBe(40); // tokens DO sum across categories
    expect(s.totals.cost_usd).toBeCloseTo(2.0, 6); // cost counts ONCE
    expect(s.by_provider[0]!.cost_usd).toBeCloseTo(2.0, 6);
    expect(s.by_machine[0]!.cost_usd).toBeCloseTo(2.0, 6);
    expect(s.month.cost_usd).toBeCloseTo(2.0, 6);
  });

  test("session cost is also de-duplicated across replicated category rows", async () => {
    const h = makeHarness(undefined, CONFIG);
    await ingest(
      h,
      "mbp-14",
      categoryRows({ report_type: "session", bucket: "s1", activity_at: Date.parse("2026-06-05T11:00:00Z") }, 5, 1.5),
    );
    const s = await getFullSummary(h);
    expect(s.session!.tokens).toBe(20);
    expect(s.session!.cost_usd).toBeCloseTo(1.5, 6);
  });

  test("active session is picked by activity_at even within a SINGLE ingest", async () => {
    // Codex catch: one ccusage poll returns ALL sessions → one ingest, one received_at
    // for every row. activity_at (lastActivity) must break the tie, not received_at.
    const h = makeHarness(undefined, CONFIG);
    await ingest(h, "mbp-14", [
      row({ report_type: "session", bucket: "sess-A", tokens: 10, activity_at: Date.parse("2026-06-05T11:00:00Z") }),
      row({ report_type: "session", bucket: "sess-B", tokens: 20, activity_at: Date.parse("2026-06-05T11:30:00Z") }),
    ]);
    const s = await getFullSummary(h);
    expect(s.session!.tokens).toBe(20); // sess-B is the more recently active one
  });

  test("session reports the most-recently-active session's burn", async () => {
    const h = makeHarness(undefined, CONFIG);
    // an older session on studio
    await ingest(h, "studio", [row({ report_type: "session", bucket: "sess-old", tokens: 500 })]);
    h.clock.advance(5_000);
    // a newer session on mbp-14 — this is the "current" one
    await ingest(h, "mbp-14", [
      row({ report_type: "session", bucket: "sess-new", model: "opus", tokens: 30, cost_usd: 0.2 }),
      row({ report_type: "session", bucket: "sess-new", model: "haiku", tokens: 12, cost_usd: 0.01 }),
    ]);
    const s = await getFullSummary(h);

    expect(s.session).not.toBeNull();
    expect(s.session!.machine).toBe("mbp-14");
    expect(s.session!.tokens).toBe(42); // 30 + 12 across two models
    expect(s.session!.cost_usd).toBeCloseTo(0.21, 6);
  });

  test("month-to-date sums only daily buckets in the reckoning month", async () => {
    const h = makeHarness(undefined, CONFIG); // clock = 2026-06
    await ingest(h, "mbp-14", [
      row({ bucket: "2026-06-01", tokens: 100 }),
      row({ bucket: "2026-06-30", tokens: 200 }),
      row({ bucket: "2026-05-31", tokens: 999 }), // previous month — excluded
    ]);
    const s = await getFullSummary(h);

    expect(s.month.month).toBe("2026-06");
    expect(s.month.tokens).toBe(300);
  });

  test("empty store yields empty breakdowns and null session/last_sync", async () => {
    const h = makeHarness(undefined, CONFIG);
    const s = await getFullSummary(h);
    expect(s.totals.tokens).toBe(0);
    expect(s.by_provider).toEqual([]);
    expect(s.by_machine).toEqual([]);
    expect(s.session).toBeNull();
    expect(s.last_sync).toBeNull();
    expect(s.month.tokens).toBe(0);
  });
});
