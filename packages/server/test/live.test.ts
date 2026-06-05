// Phase 4 gate (automated): the 1h burn sparkline buckets correctly, and active_machine
// is the machine with the most recent POSITIVE token delta in the window — NOT the
// most-recently-synced daemon (which posts on a timer even when idle).
import { describe, expect, test } from "bun:test";
import { buildLive } from "../src/live.ts";
import { getFullSummary, ingest, makeHarness, row } from "./helpers.ts";

const CONFIG = { staleAfterSeconds: 120, timezone: "UTC" };

// Drive cumulative growth by re-posting a daily bucket with a rising total. Each ingest
// records a sample at the current clock, so deltas land in time buckets.
async function burn(h: ReturnType<typeof makeHarness>, machine: string, total: number): Promise<void> {
  await ingest(h, machine, [row({ bucket: "2026-06-05", token_category: "output", tokens: total })]);
}

describe("sparkline bucketing", () => {
  test("burn lands in the bucket of the sample time; empty buckets are 0", async () => {
    const h = makeHarness(undefined, CONFIG);
    const start = h.clock.ms;

    await burn(h, "mbp-14", 100); // t0: establishes baseline (no prior → no delta)
    h.clock.advance(60_000);
    await burn(h, "mbp-14", 300); // +200 at +1min
    h.clock.advance(180_000);
    await burn(h, "mbp-14", 350); // +50 at +4min

    const live = buildLive(h.db, h.clock.ms);
    expect(live.sparkline_1h.bucket_seconds).toBe(60);
    expect(live.sparkline_1h.buckets).toHaveLength(60);

    // Exact bucketing (Codex catch — assert indexes, not just totals). With now at
    // +4min and a 60min window of 60×1min buckets, windowStart = now-3600s:
    //   +200 at +1min  → bucket floor((3420s)/60) = 57
    //   +50  at +4min (==now) → floor(3600s/60)=60, clamped to the last bucket 59
    expect(live.sparkline_1h.buckets[57]).toBe(200);
    expect(live.sparkline_1h.buckets[59]).toBe(50);
    // every other bucket is exactly 0 (real gaps).
    live.sparkline_1h.buckets.forEach((b, i) => {
      if (i !== 57 && i !== 59) expect(b).toBe(0);
    });
    void start;
  });

  test("a downward correction contributes no negative/phantom burn", async () => {
    const h = makeHarness(undefined, CONFIG);
    await burn(h, "mbp-14", 500);
    h.clock.advance(60_000);
    await burn(h, "mbp-14", 400); // correction downward — must not subtract or add
    const live = buildLive(h.db, h.clock.ms);
    expect(live.sparkline_1h.buckets.every((b) => b >= 0)).toBe(true);
    expect(live.sparkline_1h.buckets.reduce((a, b) => a + b, 0)).toBe(0);
  });
});

describe("active_machine = latest positive delta, not latest sync", () => {
  test("an idle machine that syncs last is NOT active; the burning one is", async () => {
    const h = makeHarness(undefined, CONFIG);
    // Both establish a baseline.
    await burn(h, "mbp-14", 100);
    await burn(h, "studio", 100);

    h.clock.advance(60_000);
    await burn(h, "mbp-14", 500); // mbp-14 actually burns (+400)

    h.clock.advance(60_000);
    await burn(h, "studio", 100); // studio re-posts the SAME total (idle, +0) — syncs latest

    const live = buildLive(h.db, h.clock.ms);
    // studio synced most recently but burned nothing → mbp-14 is the active machine.
    expect(live.active_machine).toBe("mbp-14");
  });

  test("no burn anywhere → active_machine is null", async () => {
    const h = makeHarness(undefined, CONFIG);
    await burn(h, "mbp-14", 100);
    h.clock.advance(60_000);
    await burn(h, "mbp-14", 100); // no delta
    expect(buildLive(h.db, h.clock.ms).active_machine).toBeNull();
  });

  test("the sparkline + active_machine appear in the full summary", async () => {
    const h = makeHarness(undefined, CONFIG);
    await burn(h, "mbp-14", 100);
    h.clock.advance(60_000);
    await burn(h, "mbp-14", 250);
    const s = await getFullSummary(h);
    expect(s.sparkline_1h.buckets).toHaveLength(60);
    expect(s.active_machine).toBe("mbp-14");
  });
});
