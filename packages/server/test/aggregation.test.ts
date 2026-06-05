// Gate (a): two snapshots from two distinct machine_ids sum correctly into the hero.
import { describe, expect, test } from "bun:test";
import { getSummary, ingest, makeHarness, row } from "./helpers.ts";

describe("aggregation across machines", () => {
  test("two distinct machines sum into the combined hero total", async () => {
    const h = makeHarness();
    await ingest(h, "mbp-14", [row({ tokens: 100 })]);
    await ingest(h, "studio", [row({ tokens: 250 })]);

    const s = await getSummary(h);
    expect(s.tokens).toBe(350);
  });

  test("two providers on one machine sum into the combined hero total", async () => {
    const h = makeHarness();
    await ingest(h, "mbp-14", [
      row({ provider: "claude-code", tokens: 100 }),
      row({ provider: "codex", model: "gpt-5", tokens: 40 }),
    ]);

    const s = await getSummary(h);
    expect(s.tokens).toBe(140);
  });

  test("the four token categories of one model all count toward the hero", async () => {
    const h = makeHarness();
    await ingest(h, "mbp-14", [
      row({ token_category: "input", tokens: 19 }),
      row({ token_category: "output", tokens: 6107 }),
      row({ token_category: "cache_write", tokens: 57867 }),
      row({ token_category: "cache_read", tokens: 351286 }),
    ]);

    const s = await getSummary(h);
    expect(s.tokens).toBe(19 + 6107 + 57867 + 351286);
  });
});
