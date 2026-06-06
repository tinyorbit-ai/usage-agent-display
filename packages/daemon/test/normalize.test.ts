// Normalizer: real ccusage JSON shapes → snapshot rows. Four category rows per
// model breakdown, cost replicated per model/bucket, correct bucket field per report
// type, and malformed entries skipped (not crashed) since the format is beta.
import { describe, expect, test } from "bun:test";
import type { SnapshotRow } from "@usage/shared";
import { normalizeReport, providerForModel } from "../src/normalize.ts";

// Trimmed from a real `ccusage daily --json` row.
const dailyReport = {
  daily: [
    {
      date: "2026-04-19",
      inputTokens: 19,
      outputTokens: 6107,
      cacheCreationTokens: 57867,
      cacheReadTokens: 351286,
      totalTokens: 415279,
      totalCost: 0.69008175,
      modelsUsed: ["claude-opus-4-7"],
      modelBreakdowns: [
        {
          modelName: "claude-opus-4-7",
          inputTokens: 19,
          outputTokens: 6107,
          cacheCreationTokens: 57867,
          cacheReadTokens: 351286,
          cost: 0.69008175,
        },
      ],
    },
  ],
};

function byCategory(rows: SnapshotRow[]): Record<string, SnapshotRow> {
  return Object.fromEntries(rows.map((r) => [r.token_category, r]));
}

describe("normalizeReport — daily", () => {
  const { rows, skipped } = normalizeReport(dailyReport, "daily", "daily", "claude-code");

  test("emits one row per token category", () => {
    expect(skipped).toBe(0);
    expect(rows).toHaveLength(4);
    expect(new Set(rows.map((r) => r.token_category))).toEqual(
      new Set(["input", "output", "cache_read", "cache_write"]),
    );
  });

  test("maps ccusage fields to categories correctly", () => {
    const c = byCategory(rows);
    expect(c.input!.tokens).toBe(19);
    expect(c.output!.tokens).toBe(6107);
    expect(c.cache_write!.tokens).toBe(57867); // cacheCreationTokens
    expect(c.cache_read!.tokens).toBe(351286); // cacheReadTokens
  });

  test("the four category tokens sum to ccusage totalTokens", () => {
    const sum = rows.reduce((a, r) => a + r.tokens, 0);
    expect(sum).toBe(415279);
  });

  test("tags provider, report_type, bucket=date", () => {
    for (const r of rows) {
      expect(r.provider).toBe("claude-code");
      expect(r.report_type).toBe("daily");
      expect(r.bucket).toBe("2026-04-19");
      expect(r.model).toBe("claude-opus-4-7");
    }
  });

  test("replicates the model/bucket cost across every category row", () => {
    for (const r of rows) expect(r.cost_usd).toBeCloseTo(0.69008175, 8);
  });
});

describe("normalizeReport — session and monthly buckets", () => {
  test("session uses sessionId as the bucket and the 'sessions' array", () => {
    const report = {
      sessions: [
        {
          sessionId: "sess-xyz",
          modelBreakdowns: [{ modelName: "gpt-5", inputTokens: 10, outputTokens: 20, cost: 0.01 }],
        },
      ],
    };
    const { rows } = normalizeReport(report, "session", "sessions", "codex");
    expect(rows.every((r) => r.bucket === "sess-xyz")).toBe(true);
    expect(rows.every((r) => r.report_type === "session")).toBe(true);
    expect(rows.every((r) => r.provider === "codex")).toBe(true);
  });

  test("session rows carry activity_at from lastActivity; daily rows do not", () => {
    const sessionReport = {
      sessions: [
        {
          sessionId: "sess-1",
          lastActivity: "2026-06-05T11:30:00.000Z",
          modelBreakdowns: [{ modelName: "opus", outputTokens: 5, cost: 0.1 }],
        },
      ],
    };
    const { rows } = normalizeReport(sessionReport, "session", "sessions", "claude-code");
    expect(rows.every((r) => r.activity_at === Date.parse("2026-06-05T11:30:00.000Z"))).toBe(true);

    const dailyReport2 = {
      daily: [{ date: "2026-06-05", modelBreakdowns: [{ modelName: "opus", outputTokens: 5, cost: 0 }] }],
    };
    const { rows: dailyRows } = normalizeReport(dailyReport2, "daily", "daily", "claude-code");
    expect(dailyRows.every((r) => r.activity_at === undefined)).toBe(true);
  });

  test("monthly uses month as the bucket", () => {
    const report = {
      monthly: [
        { month: "2026-05", modelBreakdowns: [{ modelName: "claude-opus-4-7", outputTokens: 5, cost: 0 }] },
      ],
    };
    const { rows } = normalizeReport(report, "monthly", "monthly", "claude-code");
    expect(rows.every((r) => r.bucket === "2026-05")).toBe(true);
  });
});

describe("normalizeReport — defensive against drift", () => {
  test("entries missing a bucket field are skipped, not crashed", () => {
    const report = { daily: [{ inputTokens: 5 }, { date: "2026-06-05", modelBreakdowns: [{ modelName: "m", outputTokens: 1, cost: 0 }] }] };
    const { rows, skipped } = normalizeReport(report, "daily", "daily", "claude-code");
    expect(skipped).toBe(1);
    expect(rows).toHaveLength(4);
  });

  test("an entry with no modelBreakdowns synthesizes from top-level totals", () => {
    const report = {
      daily: [{ date: "2026-06-05", modelsUsed: ["claude-opus-4-7"], outputTokens: 42, totalCost: 0.5 }],
    };
    const { rows } = normalizeReport(report, "daily", "daily", "claude-code");
    expect(rows).toHaveLength(4);
    expect(rows.find((r) => r.token_category === "output")!.tokens).toBe(42);
    expect(rows[0]!.model).toBe("claude-opus-4-7");
  });

  test("a non-array report body yields no rows and does not throw", () => {
    expect(normalizeReport({}, "daily", "daily", "claude-code")).toEqual({ rows: [], skipped: 0 });
    expect(normalizeReport(null, "daily", "daily", "claude-code")).toEqual({ rows: [], skipped: 0 });
    expect(normalizeReport("garbage", "daily", "daily", "claude-code")).toEqual({ rows: [], skipped: 0 });
  });

  test("a breakdown with a non-numeric or negative token field is SKIPPED, not zeroed", () => {
    // Codex catch: zeroing would emit rows that UPSERT over a real daily total and
    // silently zero the hero. A corrupt breakdown must produce no rows at all.
    const report = {
      daily: [{ date: "2026-06-05", modelBreakdowns: [{ modelName: "m", inputTokens: -3, outputTokens: "x", cost: 0 }] }],
    };
    const { rows, skipped } = normalizeReport(report, "daily", "daily", "claude-code");
    expect(rows).toHaveLength(0);
    expect(skipped).toBe(1);
  });

  test("a drifted entry (ccusage renamed its token fields) emits NOTHING — it cannot overwrite", () => {
    // All recognized token fields absent → drift. We must not synthesize zero rows
    // that would clobber the last-good value already stored for this bucket.
    const drifted = {
      daily: [{ date: "2026-06-05", modelBreakdowns: [{ modelName: "m", input_tokens: 100, output_tokens: 200, cost: 1 }] }],
    };
    const { rows, skipped } = normalizeReport(drifted, "daily", "daily", "claude-code");
    expect(rows).toHaveLength(0);
    expect(skipped).toBe(1);
  });

  test("one corrupt breakdown is skipped while a sibling good breakdown still emits", () => {
    const report = {
      daily: [
        {
          date: "2026-06-05",
          modelBreakdowns: [
            { modelName: "bad", inputTokens: "oops", cost: 0 },
            { modelName: "good", outputTokens: 50, cost: 0.1 },
          ],
        },
      ],
    };
    const { rows, skipped } = normalizeReport(report, "daily", "daily", "claude-code");
    expect(skipped).toBe(1);
    expect(rows).toHaveLength(4);
    expect(rows.every((r) => r.model === "good")).toBe(true);
  });

  test("a legitimately sparse breakdown (only output present) still emits, absent → 0", () => {
    const report = {
      daily: [{ date: "2026-06-05", modelBreakdowns: [{ modelName: "m", outputTokens: 42, cost: 0.5 }] }],
    };
    const { rows, skipped } = normalizeReport(report, "daily", "daily", "claude-code");
    expect(skipped).toBe(0);
    expect(rows).toHaveLength(4);
    expect(rows.find((r) => r.token_category === "output")!.tokens).toBe(42);
    expect(rows.find((r) => r.token_category === "input")!.tokens).toBe(0);
  });
});

// ccusage went multi-agent at v20: every report type buckets on `period`, a single
// daily row can mix agents, and `lastActivity` moved under `metadata`. Provider must
// be derived per model breakdown. See wiki note 2026-06-06-ccusage-multi-agent.
describe("providerForModel — anchored agent attribution", () => {
  test("claude / codex / gemini model families map to their provider", () => {
    expect(providerForModel("claude-opus-4-8", "x")).toBe("claude-code");
    expect(providerForModel("claude-sonnet-4-6", "x")).toBe("claude-code");
    expect(providerForModel("claude-haiku-4-5-20251001", "x")).toBe("claude-code");
    expect(providerForModel("gpt-5", "x")).toBe("codex");
    expect(providerForModel("gpt-5.3-codex", "x")).toBe("codex");
    expect(providerForModel("gemini-3.1-pro-preview", "x")).toBe("gemini");
  });

  test("unknown model falls back to the configured provider", () => {
    expect(providerForModel("some-unknown-llm", "claude-code")).toBe("claude-code");
    expect(providerForModel("", "codex")).toBe("codex");
  });

  test("anchored: a proxy name doesn't masquerade as another vendor", () => {
    // The phase-3 pricing lesson: loose substring matching mis-attributes.
    expect(providerForModel("local-gpt-proxy", "claude-code")).toBe("claude-code");
  });
});

describe("normalizeReport — ccusage v20 shape", () => {
  test("buckets on `period` for every report type", () => {
    const daily = { daily: [{ period: "2026-06-05", modelBreakdowns: [{ modelName: "claude-opus-4-8", outputTokens: 5, cost: 0 }] }] };
    const monthly = { monthly: [{ period: "2026-06", modelBreakdowns: [{ modelName: "gpt-5", outputTokens: 5, cost: 0 }] }] };
    const session = { session: [{ period: "sess-uuid", modelBreakdowns: [{ modelName: "gemini-3-pro", outputTokens: 5, cost: 0 }] }] };
    expect(normalizeReport(daily, "daily", "daily", "x").rows.every((r) => r.bucket === "2026-06-05")).toBe(true);
    expect(normalizeReport(monthly, "monthly", "monthly", "x").rows.every((r) => r.bucket === "2026-06")).toBe(true);
    expect(normalizeReport(session, "session", "session", "x").rows.every((r) => r.bucket === "sess-uuid")).toBe(true);
  });

  test("a single multi-agent daily row fans out into per-provider rows by model", () => {
    // One date, three agents in one row (the real v20 shape: 17/55 rows looked like this).
    const report = {
      daily: [
        {
          period: "2026-05-07",
          metadata: { agents: ["claude", "codex", "gemini"] },
          modelBreakdowns: [
            { modelName: "claude-opus-4-8", outputTokens: 10, cost: 0.1 },
            { modelName: "gpt-5.3-codex", outputTokens: 20, cost: 0.2 },
            { modelName: "gemini-3-pro-preview", outputTokens: 30, cost: 0.3 },
          ],
        },
      ],
    };
    const { rows, skipped } = normalizeReport(report, "daily", "daily", "claude-code");
    expect(skipped).toBe(0);
    expect(rows).toHaveLength(12); // 3 models × 4 categories
    const provByModel = Object.fromEntries(rows.map((r) => [r.model, r.provider]));
    expect(provByModel["claude-opus-4-8"]).toBe("claude-code");
    expect(provByModel["gpt-5.3-codex"]).toBe("codex");
    expect(provByModel["gemini-3-pro-preview"]).toBe("gemini");
    // every provider's tokens landed under the same period bucket
    expect(new Set(rows.map((r) => r.bucket))).toEqual(new Set(["2026-05-07"]));
  });

  test("session activity_at reads metadata.lastActivity (v20) and top-level (legacy)", () => {
    const v20 = {
      session: [{ period: "s1", metadata: { lastActivity: "2026-05-19T08:00:00.000Z" }, modelBreakdowns: [{ modelName: "gpt-5", outputTokens: 1, cost: 0 }] }],
    };
    const { rows } = normalizeReport(v20, "session", "session", "codex");
    expect(rows.every((r) => r.activity_at === Date.parse("2026-05-19T08:00:00.000Z"))).toBe(true);

    const legacy = {
      sessions: [{ sessionId: "s2", lastActivity: "2026-05-20T09:00:00.000Z", modelBreakdowns: [{ modelName: "gpt-5", outputTokens: 1, cost: 0 }] }],
    };
    const { rows: lrows } = normalizeReport(legacy, "session", "sessions", "codex");
    expect(lrows.every((r) => r.activity_at === Date.parse("2026-05-20T09:00:00.000Z"))).toBe(true);
  });
});
