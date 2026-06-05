import type { SnapshotRow } from "@usage/shared";

/** One snapshot row with sane defaults; override what a test cares about. */
export function row(over: Partial<SnapshotRow> = {}): SnapshotRow {
  return {
    provider: "claude-code",
    model: "claude-opus-4-7",
    token_category: "output",
    report_type: "daily",
    bucket: "2026-06-05",
    tokens: 100,
    cost_usd: 0,
    ...over,
  };
}
