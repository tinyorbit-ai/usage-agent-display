/**
 * A deterministic stand-in for the ccusage binary, used by the ops smoke check so the
 * daemon can be started from its documented command and post predictable data without
 * depending on real local usage. Invoked as `stub-ccusage <report> --json`.
 */
const report = process.argv[2];

const breakdown = (out: number) => [{ modelName: "claude-opus-4-7", outputTokens: out, cost: 0.01 }];

const payloads: Record<string, unknown> = {
  daily: { daily: [{ date: "2026-06-06", modelBreakdowns: breakdown(777) }] },
  session: {
    sessions: [{ sessionId: "smoke-s1", lastActivity: "2026-06-06T10:00:00.000Z", modelBreakdowns: breakdown(50) }],
  },
  monthly: { monthly: [{ month: "2026-06", modelBreakdowns: breakdown(777) }] },
};

process.stdout.write(JSON.stringify(payloads[report ?? ""] ?? {}));
