// Gate (d): canonical report type. Fixtures with daily + session + monthly rows for
// the same usage ⇒ the hero reflects ONLY daily. Adding session/monthly rows does NOT
// change it. Without this the gate passes while the hero silently 2–3× inflates.
import { describe, expect, test } from "bun:test";
import { getSummary, ingest, makeHarness, row } from "./helpers.ts";

describe("hero counts only the canonical (daily) report type", () => {
  test("session and monthly rows do not inflate the hero", async () => {
    const h = makeHarness();

    // The same 1000 tokens, reported three ways by ccusage.
    await ingest(h, "mbp-14", [row({ report_type: "daily", bucket: "2026-06-05", tokens: 1000 })]);
    const dailyOnly = await getSummary(h);
    expect(dailyOnly.tokens).toBe(1000);

    await ingest(h, "mbp-14", [
      row({ report_type: "session", bucket: "sess-abc", tokens: 1000 }),
      row({ report_type: "monthly", bucket: "2026-06", tokens: 1000 }),
    ]);

    // Hero must be unchanged — session/monthly are stored but never summed in.
    const withOthers = await getSummary(h);
    expect(withOthers.tokens).toBe(1000);
  });

  test("hero COST is also daily-only — session/monthly cost never inflates it", async () => {
    const h = makeHarness();
    await ingest(h, "mbp-14", [row({ report_type: "daily", bucket: "2026-06-05", tokens: 10, cost_usd: 2.5 })]);
    await ingest(h, "mbp-14", [
      row({ report_type: "session", bucket: "sess-1", tokens: 10, cost_usd: 2.5 }),
      row({ report_type: "monthly", bucket: "2026-06", tokens: 10, cost_usd: 2.5 }),
    ]);
    expect((await getSummary(h)).cost_usd).toBeCloseTo(2.5, 6);
  });
});
