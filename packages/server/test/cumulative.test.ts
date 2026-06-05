// Gate (c): the real ccusage case. Same dedup key posted tokens=100 then tokens=150
// ⇒ total becomes 150, NOT 250. Newest received value wins; no double-count. This is
// the dedup correctness the brief calls the hard part — falsified by the most likely
// regression (naive append).
import { describe, expect, test } from "bun:test";
import { getSummary, ingest, makeHarness, row } from "./helpers.ts";

describe("cumulative update for the same key", () => {
  test("100 then 150 for the same key ⇒ total 150, not 250", async () => {
    const h = makeHarness();
    await ingest(h, "mbp-14", [row({ tokens: 100 })]);
    expect((await getSummary(h)).tokens).toBe(100);

    await ingest(h, "mbp-14", [row({ tokens: 150 })]);
    expect((await getSummary(h)).tokens).toBe(150);
  });

  test("a different bucket is a different key and DOES add", async () => {
    const h = makeHarness();
    await ingest(h, "mbp-14", [row({ bucket: "2026-06-05", tokens: 100 })]);
    await ingest(h, "mbp-14", [row({ bucket: "2026-06-06", tokens: 150 })]);

    // distinct days are distinct keys → they sum.
    expect((await getSummary(h)).tokens).toBe(250);
  });
});
