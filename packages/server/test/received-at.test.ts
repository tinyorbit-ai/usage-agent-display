// received_at GOVERNS (Codex catch): a write whose server received_at is older than
// what's stored must not clobber it. Exercises the DB upsert guard directly with
// controlled received_at values (the app stamps these from the monotonic server clock).
import { describe, expect, test } from "bun:test";
import type { StoredSnapshot } from "../src/db.ts";
import { Db } from "../src/db.ts";

function stored(receivedAt: number, tokens: number): StoredSnapshot {
  return {
    machine_id: "mbp-14",
    provider: "claude-code",
    model: "claude-opus-4-7",
    token_category: "output",
    report_type: "daily",
    bucket: "2026-06-05",
    tokens,
    cost_usd: 0,
    collected_at: "2026-06-05T12:00:00.000Z",
    received_at: receivedAt,
  };
}

describe("upsert conflict resolution by received_at", () => {
  test("a stale (older received_at) write cannot overwrite fresher data", () => {
    const db = new Db(":memory:");
    db.upsertMany([stored(1000, 150)]);
    expect(db.heroTokens()).toBe(150);

    db.upsertMany([stored(500, 999)]); // older arrival — must be ignored
    expect(db.heroTokens()).toBe(150);
    db.close();
  });

  test("a fresher (newer received_at) write does overwrite", () => {
    const db = new Db(":memory:");
    db.upsertMany([stored(1000, 150)]);
    db.upsertMany([stored(2000, 200)]);
    expect(db.heroTokens()).toBe(200);
    db.close();
  });

  test("an equal received_at write is allowed (idempotent retry within the same ms)", () => {
    const db = new Db(":memory:");
    db.upsertMany([stored(2000, 200)]);
    db.upsertMany([stored(2000, 200)]);
    expect(db.heroTokens()).toBe(200);
    db.close();
  });
});
