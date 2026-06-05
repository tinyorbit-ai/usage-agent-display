// Locks the wire contract: the dedup key's field order/shape (it mirrors the server's
// PRIMARY KEY) and that it is collision-safe across open-string fields.
import { describe, expect, test } from "bun:test";
import { CANONICAL_REPORT_TYPE, snapshotDedupKey, type SnapshotRow } from "../src/index.ts";

const base: SnapshotRow = {
  provider: "claude-code",
  model: "claude-opus-4-7",
  token_category: "output",
  report_type: "daily",
  bucket: "2026-06-05",
  tokens: 1,
  cost_usd: 0,
};

// Matches any C0 control byte (NUL .. US). Built from char codes so the test source
// itself stays free of control characters.
const CONTROL_BYTE = new RegExp(`[\\u0000-\\u001f]`);

describe("snapshotDedupKey", () => {
  test("is stable and order-sensitive across the six key fields", () => {
    expect(snapshotDedupKey("mbp-14", base)).toBe(snapshotDedupKey("mbp-14", { ...base }));
    expect(snapshotDedupKey("mbp-14", base)).not.toBe(snapshotDedupKey("studio", base));
    expect(snapshotDedupKey("mbp-14", base)).not.toBe(
      snapshotDedupKey("mbp-14", { ...base, bucket: "2026-06-06" }),
    );
  });

  test("ignores the non-key fields tokens and cost_usd", () => {
    expect(snapshotDedupKey("mbp-14", base)).toBe(
      snapshotDedupKey("mbp-14", { ...base, tokens: 999, cost_usd: 4.2 }),
    );
  });

  test("is collision-safe when a field contains a separator character", () => {
    // A naive space/delimiter join would collide these two distinct rows.
    const a = snapshotDedupKey("m", { ...base, provider: "a", model: "b c" });
    const b = snapshotDedupKey("m", { ...base, provider: "a b", model: "c" });
    expect(a).not.toBe(b);
  });

  test("contains no NUL or control bytes (regression: the key was once NUL-joined)", () => {
    expect(CONTROL_BYTE.test(snapshotDedupKey("mbp-14", base))).toBe(false);
  });

  test("the canonical report type is daily", () => {
    expect(CANONICAL_REPORT_TYPE).toBe("daily");
  });
});
