// The collect→post tick: builds a stamped payload, posts it, and survives every
// failure path (collector throws, post fails, zero rows) without crashing the loop.
import { describe, expect, test } from "bun:test";
import type { IngestPayload } from "@usage/shared";
import type { Collector } from "../src/collector.ts";
import type { Poster, PostOutcome } from "../src/post.ts";
import { tick } from "../src/loop.ts";
import { row } from "./fixtures.ts";

function fixedCollector(provider: string, rows = [row()]): Collector {
  return { provider, collect: async () => ({ rows, skipped: 0 }) };
}

function capturePoster(outcome: PostOutcome): { poster: Poster; sent: IngestPayload[] } {
  const sent: IngestPayload[] = [];
  return {
    sent,
    poster: { post: async (p) => { sent.push(p); return outcome; } },
  };
}

describe("tick", () => {
  test("stamps machine_id and an ISO collected_at, then posts the rows", async () => {
    const { poster, sent } = capturePoster({ ok: true, accepted: 1 });
    const fixedNow = Date.parse("2026-06-05T12:00:00.000Z");
    const res = await tick({
      machineId: "mbp-14",
      collectors: [fixedCollector("claude-code")],
      poster,
      now: () => fixedNow,
    });

    expect(res.outcome).toEqual({ ok: true, accepted: 1 });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.machine_id).toBe("mbp-14");
    expect(sent[0]!.collected_at).toBe("2026-06-05T12:00:00.000Z");
    expect(sent[0]!.rows).toHaveLength(1);
  });

  test("multiple collectors are merged into one payload", async () => {
    const { poster, sent } = capturePoster({ ok: true, accepted: 2 });
    await tick({
      machineId: "m",
      collectors: [fixedCollector("claude-code"), fixedCollector("codex", [row({ provider: "codex" })])],
      poster,
    });
    expect(sent[0]!.rows.map((r) => r.provider).sort()).toEqual(["claude-code", "codex"]);
  });

  test("a collector that throws is isolated; the rest still post", async () => {
    const throwing: Collector = { provider: "broken", collect: async () => { throw new Error("ccusage missing"); } };
    const { poster, sent } = capturePoster({ ok: true, accepted: 1 });
    const res = await tick({ machineId: "m", collectors: [throwing, fixedCollector("claude-code")], poster });

    expect(sent).toHaveLength(1); // the healthy collector still produced a post
    expect(res.skipped).toBeGreaterThanOrEqual(1);
  });

  test("zero rows ⇒ nothing posted, no throw", async () => {
    const empty: Collector = { provider: "x", collect: async () => ({ rows: [], skipped: 0 }) };
    const { poster, sent } = capturePoster({ ok: true, accepted: 0 });
    const res = await tick({ machineId: "m", collectors: [empty], poster });
    expect(sent).toHaveLength(0);
    expect(res.outcome).toBe("no-rows");
  });

  test("a failed post is reported, not thrown — the loop can retry next tick", async () => {
    const { poster } = capturePoster({ ok: false, status: 500, error: "server returned 500" });
    const res = await tick({ machineId: "m", collectors: [fixedCollector("claude-code")], poster });
    expect(res.outcome).toEqual({ ok: false, status: 500, error: "server returned 500" });
  });
});
