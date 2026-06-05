// Phase 2 gate (automated, cross-TZ): "this month" is reckoned in ONE declared
// timezone so machines in different zones roll up consistently. The same instant
// near a month boundary lands in different months depending on the declared TZ.
import { describe, expect, test } from "bun:test";
import { reckoningMonth } from "../src/summary.ts";
import { getFullSummary, ingest, makeHarness, row } from "./helpers.ts";

describe("reckoningMonth", () => {
  // 2026-07-01T01:30Z: already July in UTC, still June 30 in Los Angeles (UTC-7).
  const instant = Date.parse("2026-07-01T01:30:00.000Z");

  test("the same instant yields different months per declared timezone", () => {
    expect(reckoningMonth(instant, "UTC")).toBe("2026-07");
    expect(reckoningMonth(instant, "America/Los_Angeles")).toBe("2026-06");
    expect(reckoningMonth(instant, "Asia/Tokyo")).toBe("2026-07");
  });
});

describe("month-to-date honours the declared timezone", () => {
  const instant = Date.parse("2026-07-01T01:30:00.000Z");

  test("LA reckoning counts June data; UTC reckoning counts July data", async () => {
    const june = makeHarness(instant, { staleAfterSeconds: 120, timezone: "America/Los_Angeles" });
    await ingest(june, "mbp-14", [
      row({ bucket: "2026-06-30", tokens: 600 }),
      row({ bucket: "2026-07-01", tokens: 50 }),
    ]);
    const sJune = await getFullSummary(june);
    expect(sJune.month.month).toBe("2026-06");
    expect(sJune.month.tokens).toBe(600);

    const utc = makeHarness(instant, { staleAfterSeconds: 120, timezone: "UTC" });
    await ingest(utc, "mbp-14", [
      row({ bucket: "2026-06-30", tokens: 600 }),
      row({ bucket: "2026-07-01", tokens: 50 }),
    ]);
    const sUtc = await getFullSummary(utc);
    expect(sUtc.month.month).toBe("2026-07");
    expect(sUtc.month.tokens).toBe(50);
  });
});
