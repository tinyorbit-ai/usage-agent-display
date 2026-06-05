// Phase 5: retention prunes rows not re-posted within the window, and leaves fresh
// rows (and the current total) intact.
import { describe, expect, test } from "bun:test";
import type { StoredSnapshot } from "../src/db.ts";
import { Db } from "../src/db.ts";
import { pruneExpired, resolveRetentionDays, RetentionConfigError } from "../src/retention.ts";

function stored(receivedAt: number, bucket: string, tokens: number): StoredSnapshot {
  return {
    machine_id: "mbp-14",
    provider: "claude-code",
    model: "claude-opus-4-7",
    token_category: "output",
    report_type: "daily",
    bucket,
    tokens,
    cost_usd: 0,
    collected_at: "2026-06-06T12:00:00.000Z",
    received_at: receivedAt,
  };
}

describe("snapshot retention", () => {
  test("prunes rows older than the cutoff, keeps fresh ones and the total", () => {
    const db = new Db(":memory:");
    const now = Date.parse("2026-06-06T12:00:00.000Z");
    const old = now - 500 * 86_400_000; // ~500 days ago
    db.upsertMany([stored(old, "2025-01-20", 111), stored(now, "2026-06-06", 222)]);
    expect(db.heroTokens()).toBe(333);

    const removed = db.pruneSnapshotsBefore(now - 400 * 86_400_000);
    expect(removed).toBe(1); // only the ~500-day-old row
    expect(db.heroTokens()).toBe(222); // fresh row + its total survive
    db.close();
  });

  test("a re-post refreshes received_at so an active bucket is never pruned", () => {
    const db = new Db(":memory:");
    const now = Date.parse("2026-06-06T12:00:00.000Z");
    // first seen long ago...
    db.upsertMany([stored(now - 500 * 86_400_000, "2026-06-06", 100)]);
    // ...but re-posted today (cumulative grew) → received_at is now.
    db.upsertMany([stored(now, "2026-06-06", 900)]);

    expect(db.pruneSnapshotsBefore(now - 400 * 86_400_000)).toBe(0);
    expect(db.heroTokens()).toBe(900);
    db.close();
  });
});

describe("retention config (resolveRetentionDays)", () => {
  test("defaults to 400 when unset", () => {
    expect(resolveRetentionDays({})).toBe(400);
    expect(resolveRetentionDays({ USAGE_RETENTION_DAYS: "" })).toBe(400);
  });

  test("an explicit 0 disables retention (null)", () => {
    expect(resolveRetentionDays({ USAGE_RETENTION_DAYS: "0" })).toBeNull();
  });

  test("a typo'd value FAILS FAST — never silently disables pruning", () => {
    expect(() => resolveRetentionDays({ USAGE_RETENTION_DAYS: "400d" })).toThrow(RetentionConfigError);
    expect(() => resolveRetentionDays({ USAGE_RETENTION_DAYS: "-5" })).toThrow(RetentionConfigError);
  });

  test("pruneExpired uses the configured cutoff; null is a no-op", () => {
    const db = new Db(":memory:");
    const now = Date.parse("2026-06-06T12:00:00.000Z");
    db.upsertMany([
      {
        machine_id: "m", provider: "claude-code", model: "claude-opus-4-7", token_category: "output",
        report_type: "daily", bucket: "2024-01-01", tokens: 1, cost_usd: 0,
        collected_at: "2024-01-01T00:00:00.000Z", received_at: now - 500 * 86_400_000,
      },
    ]);
    expect(pruneExpired(db, null, now)).toBe(0); // disabled → nothing pruned
    expect(pruneExpired(db, 400, now)).toBe(1); // 400-day window → the old row goes
    db.close();
  });
});
