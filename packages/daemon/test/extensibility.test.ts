// Phase 5 gate (automated): a NEW provider slots in through the collector interface
// and flows ingest → dedup → /usage/summary (appears in by_provider[] and the combined
// total) with ZERO change to aggregation code. This test imports db.ts / summary.ts
// UNCHANGED — the only new thing is a custom Collector.
import { describe, expect, test } from "bun:test";
import { buildCollectors, type Collector, type Exec } from "../src/collector.ts";
import { tick } from "../src/loop.ts";
import { makePoster } from "../src/post.ts";
import { Db } from "../../server/src/db.ts";
import { createApp } from "../../server/src/app.ts";
import { makeLogger } from "../../server/src/log.ts";
import type { UsageSummary } from "@usage/shared";

const TOKEN = "ext-secret";

// A brand-new provider that is NOT ccusage — it implements the Collector interface
// directly and emits normalized rows for provider "cursor". This is the "third
// provider" the gate asks for: a different source behind the same seam.
const cursorCollector: Collector = {
  provider: "cursor",
  async collect() {
    return {
      rows: [
        { provider: "cursor", model: "cursor-fast", token_category: "output", report_type: "daily", bucket: "2026-06-06", tokens: 4242, cost_usd: 0 },
        { provider: "cursor", model: "cursor-fast", token_category: "input", report_type: "daily", bucket: "2026-06-06", tokens: 100, cost_usd: 0 },
      ],
      skipped: 0,
    };
  },
};

describe("provider extensibility (3-year fit)", () => {
  test("a new collector's provider appears in by_provider and the combined total", async () => {
    const db = new Db(":memory:");
    const app = createApp({ db, token: TOKEN, logger: makeLogger(() => {}) });
    // Route the poster straight at the in-memory app — a real ingest over the contract.
    const poster = makePoster({
      serverUrl: "http://x",
      token: TOKEN,
      fetchFn: (url, init) => app.fetch(new Request(url as string, init as RequestInit)),
    });

    // An existing claude-code collector plus the brand-new cursor one, side by side.
    const claude: Collector = {
      provider: "claude-code",
      async collect() {
        return {
          rows: [{ provider: "claude-code", model: "claude-opus-4-7", token_category: "output", report_type: "daily", bucket: "2026-06-06", tokens: 1000, cost_usd: 0 }],
          skipped: 0,
        };
      },
    };

    const res = await tick({ machineId: "mbp-14", collectors: [claude, cursorCollector], poster });
    expect(res.outcome).toMatchObject({ ok: true });

    const summary = (await (await app.fetch(new Request("http://x/usage/summary", { headers: { authorization: `Bearer ${TOKEN}` } }))).json()) as UsageSummary;

    // cursor shows up as its own provider...
    const cursor = summary.by_provider.find((p) => p.provider === "cursor");
    expect(cursor).toBeDefined();
    expect(cursor!.tokens).toBe(4342); // 4242 + 100

    // ...and is folded into the combined hero total alongside claude-code.
    expect(summary.totals.tokens).toBe(1000 + 4342);
    expect(summary.by_provider.map((p) => p.provider).sort()).toEqual(["claude-code", "cursor"]);
    db.close();
  });

  test("a new provider added via the buildCollectors REGISTRY reaches the summary", async () => {
    // Codex catch: exercise the real registry wiring, not just a hand-built Collector.
    const db = new Db(":memory:");
    const app = createApp({ db, token: TOKEN, logger: makeLogger(() => {}) });
    const poster = makePoster({
      serverUrl: "http://x",
      token: TOKEN,
      fetchFn: (url, init) => app.fetch(new Request(url as string, init as RequestInit)),
    });

    // ccusage-shaped JSON for a brand-new provider's command, served via a stub exec.
    const exec: Exec = async () =>
      JSON.stringify({ daily: [{ date: "2026-06-06", modelBreakdowns: [{ modelName: "windsurf-1", outputTokens: 321, cost: 0 }] }] });
    const collectors = buildCollectors([{ provider: "windsurf", reports: ["daily"], command: ["windsurf-usage"] }], exec);

    await tick({ machineId: "mbp-14", collectors, poster });
    const summary = (await (await app.fetch(new Request("http://x/usage/summary", { headers: { authorization: `Bearer ${TOKEN}` } }))).json()) as UsageSummary;

    expect(summary.by_provider.find((p) => p.provider === "windsurf")?.tokens).toBe(321);
    expect(summary.totals.tokens).toBe(321);
    db.close();
  });
});
