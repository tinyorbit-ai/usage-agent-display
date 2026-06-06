// Phase 7 gate: /usage/summary carries timeframes (today / 30d / all), a daily token
// series for the graph, and last_used — each computed correctly from fixtures.
// Harness clock is 2026-06-05 UTC, so "today" = 2026-06-05 and the 30d cutoff = 2026-05-07.
import { describe, expect, test } from "bun:test";
import { getFullSummary, ingest, makeHarness, row } from "./helpers.ts";

const CONFIG = { staleAfterSeconds: 120, timezone: "UTC" };

describe("phase 7 timeframes / daily / last_used", () => {
  test("today / 30d / all split daily rows by bucket date", async () => {
    const h = makeHarness(undefined, CONFIG);
    await ingest(h, "mbp-14", [
      row({ provider: "claude-code", model: "opus", bucket: "2026-06-05", tokens: 100, cost_usd: 1 }), // today
      row({ provider: "codex", model: "gpt-5", bucket: "2026-05-20", tokens: 40, cost_usd: 0.5 }),     // in 30d, not today
      row({ provider: "gemini", model: "gemini-3-pro", bucket: "2026-01-01", tokens: 7, cost_usd: 0.1 }), // all only
    ]);
    const s = await getFullSummary(h);

    expect(s.timeframes.today.tokens).toBe(100);
    expect(s.timeframes.d30.tokens).toBe(140); // today + 30d
    expect(s.timeframes.all.tokens).toBe(147); // + the old one

    // distinct active days = distinct buckets in the window
    expect(s.timeframes.today.days).toBe(1);
    expect(s.timeframes.d30.days).toBe(2);
    expect(s.timeframes.all.days).toBe(3);

    // per-provider split within a timeframe
    const d30cc = s.timeframes.d30.by_provider.find((p) => p.provider === "claude-code")!;
    const d30codex = s.timeframes.d30.by_provider.find((p) => p.provider === "codex")!;
    expect(d30cc.tokens).toBe(100);
    expect(d30codex.tokens).toBe(40);
    expect(s.timeframes.d30.by_provider.find((p) => p.provider === "gemini")).toBeUndefined();
  });

  test("daily series returns recent buckets oldest→newest", async () => {
    const h = makeHarness(undefined, CONFIG);
    await ingest(h, "mbp-14", [
      row({ bucket: "2026-06-03", tokens: 10 }),
      row({ bucket: "2026-06-05", tokens: 30 }),
      row({ bucket: "2026-06-04", tokens: 20 }),
    ]);
    const s = await getFullSummary(h);
    expect(s.daily.map((d) => d.date)).toEqual(["2026-06-03", "2026-06-04", "2026-06-05"]);
    expect(s.daily.map((d) => d.tokens)).toEqual([10, 20, 30]);
  });

  test("last_used reports the provider with the newest session activity", async () => {
    const h = makeHarness(undefined, CONFIG);
    await ingest(h, "mbp-14", [
      row({ provider: "claude-code", model: "opus", report_type: "session", bucket: "s1",
            tokens: 5, cost_usd: 0, activity_at: Date.parse("2026-06-04T00:00:00.000Z") }),
      row({ provider: "codex", model: "gpt-5", report_type: "session", bucket: "s2",
            tokens: 5, cost_usd: 0, activity_at: Date.parse("2026-06-05T00:00:00.000Z") }),
    ]);
    const s = await getFullSummary(h);
    expect(s.last_used?.provider).toBe("codex");
    expect(s.last_used!.age_seconds).toBeGreaterThanOrEqual(0);
  });

  test("empty DB yields zeroed timeframes, no daily points, null last_used", async () => {
    const h = makeHarness(undefined, CONFIG);
    const s = await getFullSummary(h);
    expect(s.timeframes.all.tokens).toBe(0);
    expect(s.timeframes.all.by_provider).toEqual([]);
    expect(s.daily).toEqual([]);
    expect(s.last_used).toBeNull();
  });
});
