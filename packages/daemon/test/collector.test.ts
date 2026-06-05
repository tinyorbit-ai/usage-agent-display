// Collector: provider tagging across report types, argv shape (no shell string), and
// per-report isolation — one report type failing doesn't sink the others.
import { describe, expect, test } from "bun:test";
import { buildCollectors, ccusageCollector, type Exec } from "../src/collector.ts";

const dailyJson = JSON.stringify({
  daily: [{ date: "2026-06-05", modelBreakdowns: [{ modelName: "m", outputTokens: 10, cost: 0.1 }] }],
});
const sessionJson = JSON.stringify({
  sessions: [{ sessionId: "s1", modelBreakdowns: [{ modelName: "m", outputTokens: 5, cost: 0.05 }] }],
});

describe("ccusageCollector", () => {
  test("invokes ccusage per report with an argv array and the --json flag", async () => {
    const calls: string[][] = [];
    const exec: Exec = async (argv) => {
      calls.push(argv);
      return argv.includes("daily") ? dailyJson : sessionJson;
    };
    const collector = ccusageCollector({ provider: "claude-code", reports: ["daily", "session"], exec, command: ["bunx", "ccusage"] });
    const { rows } = await collector.collect();

    expect(calls).toEqual([
      ["bunx", "ccusage", "daily", "--json"],
      ["bunx", "ccusage", "session", "--json"],
    ]);
    expect(rows.every((r) => r.provider === "claude-code")).toBe(true);
    expect(rows.filter((r) => r.report_type === "daily")).toHaveLength(4);
    expect(rows.filter((r) => r.report_type === "session")).toHaveLength(4);
  });

  test("a failing report type is isolated; other reports still collected", async () => {
    const exec: Exec = async (argv) => {
      if (argv.includes("session")) throw new Error("ccusage codex parse error");
      return dailyJson;
    };
    const collector = ccusageCollector({ provider: "claude-code", reports: ["daily", "session"], exec });
    const { rows, skipped } = await collector.collect();

    expect(rows).toHaveLength(4); // daily survived
    expect(skipped).toBe(1); // session counted as skipped, not thrown
  });

  test("non-JSON stdout is skipped, not crashed", async () => {
    const exec: Exec = async () => "not json at all";
    const collector = ccusageCollector({ provider: "claude-code", reports: ["daily"], exec });
    const { rows, skipped } = await collector.collect();
    expect(rows).toHaveLength(0);
    expect(skipped).toBe(1);
  });
});

describe("buildCollectors registry", () => {
  test("builds one collector per provider spec, each tagged + using its command", async () => {
    const calls: string[][] = [];
    const exec: Exec = async (argv) => {
      calls.push(argv);
      return dailyJson;
    };
    const collectors = buildCollectors(
      [
        { provider: "claude-code", reports: ["daily"], command: ["bunx", "ccusage"] },
        { provider: "cursor", reports: ["daily"], command: ["cursor-usage"] },
      ],
      exec,
    );
    expect(collectors.map((c) => c.provider)).toEqual(["claude-code", "cursor"]);

    await Promise.all(collectors.map((c) => c.collect()));
    expect(calls).toContainEqual(["bunx", "ccusage", "daily", "--json"]);
    expect(calls).toContainEqual(["cursor-usage", "daily", "--json"]);
  });

  test("rejects duplicate provider labels (they'd collide in the dedup key)", () => {
    expect(() =>
      buildCollectors([
        { provider: "claude-code", reports: ["daily"] },
        { provider: "claude-code", reports: ["daily"] },
      ]),
    ).toThrow(/duplicate provider/);
  });
});
