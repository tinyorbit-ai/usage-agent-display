// Gate (e): clock-skew resolution. When the SECOND-received post for a key carries an
// OLDER collected_at, it still wins (server received_at governs). And a post with an
// implausibly future collected_at is rejected.
import { describe, expect, test } from "bun:test";
import { LIMITS } from "@usage/shared";
import { getSummary, ingest, makeHarness, row } from "./helpers.ts";

describe("clock-skew resolution by server received_at", () => {
  test("the second-received post wins even with an older daemon clock", async () => {
    const h = makeHarness();

    // First arrival: daemon clock at 12:05, value 100.
    await ingest(h, "mbp-14", [row({ tokens: 100 })], "2026-06-05T12:05:00.000Z");
    expect((await getSummary(h)).tokens).toBe(100);

    // Server time advances; second arrival carries an EARLIER daemon clock (skew/retry)
    // but a corrected value of 150. received_at governs, so 150 must win.
    h.clock.advance(60_000);
    const res = await ingest(h, "mbp-14", [row({ tokens: 150 })], "2026-06-05T11:00:00.000Z");
    expect(res.status).toBe(200);
    expect((await getSummary(h)).tokens).toBe(150);
  });

  test("a post with an implausibly future collected_at is rejected and writes nothing", async () => {
    const h = makeHarness();
    const future = new Date(h.clock.ms + LIMITS.FUTURE_SKEW_MS + 60_000).toISOString();

    const res = await ingest(h, "mbp-14", [row({ tokens: 999 })], future);
    expect(res.status).toBe(400);

    // Nothing was written.
    expect((await getSummary(h)).tokens).toBe(0);
  });

  test("last_sync age reflects the freshest machine's server clock honestly", async () => {
    const h = makeHarness();
    await ingest(h, "mbp-14", [row({ tokens: 100 })]);
    h.clock.advance(27_000);

    const s = await getSummary(h);
    expect(s.lastSyncAge).toBe(27);
  });
});
