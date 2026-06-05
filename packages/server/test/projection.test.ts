// Phase 3 gate (automated): projection extrapolates from elapsed fraction; budget
// used_pct + over_budget. Driven through the full summary so the wiring is tested too.
import { describe, expect, test } from "bun:test";
import { fractionOfDay, fractionOfMonth, project } from "../src/projection.ts";
import { getFullSummary, ingest, makeHarness, row } from "./helpers.ts";

describe("projection math", () => {
  test("fractionOfDay is the share of the day elapsed in the declared TZ", () => {
    // 2026-06-15T06:00:00Z is 06:00 in UTC → quarter of the day.
    const noonUtc = Date.parse("2026-06-15T06:00:00.000Z");
    expect(fractionOfDay(noonUtc, "UTC")).toBeCloseTo(0.25, 4);
  });

  test("fractionOfMonth blends day-of-month and time-of-day", () => {
    // June has 30 days. 2026-06-16T00:00Z → 15 full days elapsed → 15/30 = 0.5.
    const mid = Date.parse("2026-06-16T00:00:00.000Z");
    expect(fractionOfMonth(mid, "UTC")).toBeCloseTo(0.5, 4);
  });

  test("project extrapolates linearly, and clamps very early in the period", () => {
    expect(project(10, 0.25)).toBeCloseTo(40, 6); // a quarter in, $10 → ~$40 EOD
    expect(project(0.01, 0.0001)).toBeCloseTo(0.01, 6); // too early → no wild blow-up
  });
});

describe("projection + budget through the summary", () => {
  // Half the day, half the month elapsed, in UTC.
  const now = Date.parse("2026-06-16T12:00:00.000Z");

  test("EOD ~2× today's spend at midday; month ~2× MTD at mid-month", async () => {
    const h = makeHarness(now, { staleAfterSeconds: 120, timezone: "UTC" });
    // 1M opus output tokens today = $75. (today and this-month both include 06-16.)
    await ingest(h, "mbp-14", [
      row({ model: "claude-opus-4-7", token_category: "output", bucket: "2026-06-16", tokens: 1_000_000, cost_usd: 0 }),
    ]);
    const s = await getFullSummary(h);

    // day is exactly 0.5 elapsed → EOD = 75/0.5 = 150.
    expect(s.cost.projection.eod_usd).toBeCloseTo(150, 4);
    // month is 15.5/30 = 0.5167 elapsed → 75 / 0.5167 ≈ 145.16.
    expect(s.cost.projection.month_usd).toBeCloseTo(145.16, 1);
    expect(s.cost.priced_usd).toBeCloseTo(75, 4);
    expect(s.cost.partial).toBe(false);
  });

  test("budget used_pct and over_budget reflect month-to-date priced spend", async () => {
    const h = makeHarness(now, { staleAfterSeconds: 120, timezone: "UTC", budgetUsd: 50 });
    await ingest(h, "mbp-14", [
      row({ model: "claude-opus-4-7", token_category: "output", bucket: "2026-06-10", tokens: 1_000_000 }), // $75 MTD
    ]);
    const s = await getFullSummary(h);

    expect(s.cost.budget).not.toBeNull();
    expect(s.cost.budget!.limit_usd).toBe(50);
    expect(s.cost.budget!.used_pct).toBeCloseTo(150, 0); // 75 / 50 = 150%
    expect(s.cost.budget!.over_budget).toBe(true);
  });

  test("no budget configured → budget is null", async () => {
    const h = makeHarness(now, { staleAfterSeconds: 120, timezone: "UTC" });
    await ingest(h, "mbp-14", [row({ model: "claude-opus-4-7", token_category: "output", tokens: 100 })]);
    expect((await getFullSummary(h)).cost.budget).toBeNull();
  });

  test("unknown-model tokens make the cost estimate partial", async () => {
    const h = makeHarness(now, { staleAfterSeconds: 120, timezone: "UTC" });
    await ingest(h, "mbp-14", [
      row({ model: "mystery-model", token_category: "output", tokens: 1234 }),
    ]);
    const s = await getFullSummary(h);
    expect(s.cost.partial).toBe(true);
    expect(s.cost.unpriced_tokens).toBe(1234);
    expect(s.cost.priced_usd).toBe(0);
  });
});
