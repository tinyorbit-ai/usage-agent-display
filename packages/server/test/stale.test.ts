// Phase 2 gate (automated): with no snapshot newer than STALE_AFTER_SECONDS, the
// machine's age exceeds it and it is flagged stale:true — the degrade-gracefully path.
import { describe, expect, test } from "bun:test";
import { getFullSummary, ingest, makeHarness, row } from "./helpers.ts";

describe("staleness flagging", () => {
  test("a machine goes stale once its age passes the threshold", async () => {
    const h = makeHarness(undefined, { staleAfterSeconds: 60, timezone: "UTC" });
    await ingest(h, "mbp-14", [row({ tokens: 100 })]);

    // within threshold → fresh
    h.clock.advance(30_000);
    let s = await getFullSummary(h);
    expect(s.by_machine[0]!.stale).toBe(false);
    expect(s.by_machine[0]!.age_seconds).toBe(30);

    // past threshold → stale, age keeps climbing
    h.clock.advance(40_000); // now 70s old
    s = await getFullSummary(h);
    expect(s.by_machine[0]!.stale).toBe(true);
    expect(s.by_machine[0]!.age_seconds).toBe(70);
  });

  test("partial: one machine fresh, one stale (the panel's partial state)", async () => {
    const h = makeHarness(undefined, { staleAfterSeconds: 60, timezone: "UTC" });
    await ingest(h, "studio", [row({ tokens: 1 })]); // will age out
    h.clock.advance(90_000);
    await ingest(h, "mbp-14", [row({ tokens: 2 })]); // fresh
    const s = await getFullSummary(h);

    const studio = s.by_machine.find((m) => m.machine === "studio")!;
    const mbp = s.by_machine.find((m) => m.machine === "mbp-14")!;
    expect(studio.stale).toBe(true);
    expect(mbp.stale).toBe(false);
  });

  test("a silent machine still appears (stale), never vanishes from the panel", async () => {
    const h = makeHarness(undefined, { staleAfterSeconds: 60, timezone: "UTC" });
    await ingest(h, "studio", [row({ report_type: "session", bucket: "s1", tokens: 5 })]); // session only, no daily
    h.clock.advance(120_000);
    const s = await getFullSummary(h);

    const studio = s.by_machine.find((m) => m.machine === "studio")!;
    expect(studio).toBeDefined();
    expect(studio.tokens).toBe(0); // no daily rows, but the tile is present
    expect(studio.stale).toBe(true);
  });
});
