// Gate (b): re-posting the IDENTICAL snapshot does not change the total.
import { describe, expect, test } from "bun:test";
import { getSummary, ingest, makeHarness, row } from "./helpers.ts";

describe("idempotent re-posts", () => {
  test("posting the same snapshot twice leaves the total unchanged", async () => {
    const h = makeHarness();
    const rows = [row({ tokens: 415279 })];

    await ingest(h, "mbp-14", rows);
    const first = await getSummary(h);
    expect(first.tokens).toBe(415279);

    // The daemon re-runs on its interval and re-posts the same cumulative data.
    await ingest(h, "mbp-14", rows);
    const second = await getSummary(h);
    expect(second.tokens).toBe(415279);
  });

  test("re-posting cost does not multiply it", async () => {
    const h = makeHarness();
    const rows = [
      row({ token_category: "input", tokens: 19, cost_usd: 0.69 }),
      row({ token_category: "output", tokens: 6107, cost_usd: 0.69 }),
    ];
    await ingest(h, "mbp-14", rows);
    await ingest(h, "mbp-14", rows);

    const s = await getSummary(h);
    // cost is replicated across the model/bucket's category rows; it counts once.
    expect(s.cost_usd).toBeCloseTo(0.69, 6);
  });
});
