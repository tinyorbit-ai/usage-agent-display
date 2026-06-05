// Input-validation gate: /ingest REJECTS (400, writes nothing) any out-of-range or
// malformed field rather than clamping; unknown fields are rejected.
import { describe, expect, test } from "bun:test";
import { LIMITS, type SnapshotRow } from "@usage/shared";
import { authedPost, getSummary, makeHarness, payload, row } from "./helpers.ts";

async function post(body: unknown): Promise<number> {
  const h = makeHarness();
  const res = await h.app.fetch(authedPost(body));
  return res.status;
}

describe("strict input validation rejects, never clamps", () => {
  test("negative token count → 400", async () => {
    expect(await post(payload("m", [row({ tokens: -1 })]))).toBe(400);
  });

  test("non-integer token count → 400", async () => {
    expect(await post(payload("m", [row({ tokens: 1.5 })]))).toBe(400);
  });

  test("token count above the sane bound → 400 (not clamped)", async () => {
    expect(await post(payload("m", [row({ tokens: LIMITS.TOKENS_MAX + 1 })]))).toBe(400);
  });

  test("negative cost → 400", async () => {
    expect(await post(payload("m", [row({ cost_usd: -0.01 })]))).toBe(400);
  });

  test("over-long machine_id → 400", async () => {
    expect(await post(payload("x".repeat(LIMITS.STRING_MAX + 1), [row()]))).toBe(400);
  });

  // These deliberately feed malformed values the type system would reject — the whole
  // point is to prove the RUNTIME validator rejects them — so they go through `bad`.
  const bad = (over: Record<string, unknown>): SnapshotRow => ({ ...row(), ...over }) as unknown as SnapshotRow;

  test("unknown token_category → 400", async () => {
    expect(await post(payload("m", [bad({ token_category: "weird" })]))).toBe(400);
  });

  test("unknown report_type → 400", async () => {
    expect(await post(payload("m", [bad({ report_type: "yearly" })]))).toBe(400);
  });

  test("unknown extra field on a row → 400", async () => {
    expect(await post(payload("m", [bad({ surprise: 1 })]))).toBe(400);
  });

  test("unknown extra field on the payload → 400", async () => {
    expect(await post({ ...payload("m", [row()]), surprise: true })).toBe(400);
  });

  test("empty rows array → 400", async () => {
    expect(await post(payload("m", []))).toBe(400);
  });

  test("rows array over the sanity ceiling → 400, writes nothing", async () => {
    const h = makeHarness();
    const many = Array.from({ length: LIMITS.ROWS_MAX + 1 }, () => row({ tokens: 1 }));
    const res = await h.app.fetch(authedPost(payload("m", many)));
    expect(res.status).toBe(400);
    expect((await getSummary(h)).tokens).toBe(0);
  });

  test("an oversized request body → 413, writes nothing", async () => {
    const h = makeHarness();
    // A body whose Content-Length exceeds the cap is rejected before parsing.
    const huge = "x".repeat(LIMITS.BODY_BYTES_MAX + 1);
    const res = await h.app.fetch(
      new Request("http://x/ingest", {
        method: "POST",
        headers: { authorization: "Bearer test-bearer-secret-0xCAFE", "content-type": "application/json" },
        body: JSON.stringify({ machine_id: "m", collected_at: "2026-06-05T12:00:00.000Z", pad: huge }),
      }),
    );
    expect(res.status).toBe(413);
    expect((await getSummary(h)).tokens).toBe(0);
  });

  test("malformed collected_at → 400", async () => {
    expect(await post({ machine_id: "m", collected_at: "not-a-date", rows: [row()] })).toBe(400);
  });

  test("a rejected payload writes nothing", async () => {
    const h = makeHarness();
    await h.app.fetch(authedPost(payload("m", [row({ tokens: 100 }), row({ tokens: -5 })])));
    // the whole payload is rejected atomically — the valid first row is not written
    expect((await getSummary(h)).tokens).toBe(0);
  });

  test("invalid JSON body → 400", async () => {
    const h = makeHarness();
    const res = await h.app.fetch(
      new Request("http://x/ingest", {
        method: "POST",
        headers: { authorization: "Bearer test-bearer-secret-0xCAFE" },
        body: "{not json",
      }),
    );
    expect(res.status).toBe(400);
  });
});
