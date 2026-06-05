// Auth gate: a POST to /ingest AND a GET to /usage/summary, each without and with a
// wrong bearer token, return 401. Both endpoints are bearer-protected.
import { describe, expect, test } from "bun:test";
import { authedPost, makeHarness, payload, row, summaryRequest, TOKEN } from "./helpers.ts";

describe("bearer auth on both endpoints", () => {
  const good = payload("mbp-14", [row()]);

  test("POST /ingest with no token → 401", async () => {
    const h = makeHarness();
    const res = await h.app.fetch(
      new Request("http://x/ingest", { method: "POST", body: JSON.stringify(good) }),
    );
    expect(res.status).toBe(401);
  });

  test("POST /ingest with wrong token → 401, writes nothing", async () => {
    const h = makeHarness();
    const res = await h.app.fetch(authedPost(good, "wrong-token"));
    expect(res.status).toBe(401);
    // and the store stayed empty
    const summary = await h.app.fetch(summaryRequest());
    expect(((await summary.json()) as { totals: { tokens: number } }).totals.tokens).toBe(0);
  });

  test("GET /usage/summary with no token → 401", async () => {
    const h = makeHarness();
    const res = await h.app.fetch(new Request("http://x/usage/summary", { method: "GET" }));
    expect(res.status).toBe(401);
  });

  test("GET /usage/summary with wrong token → 401", async () => {
    const h = makeHarness();
    const res = await h.app.fetch(summaryRequest("nope"));
    expect(res.status).toBe(401);
  });

  test("the correct token is accepted on both endpoints", async () => {
    const h = makeHarness();
    expect((await h.app.fetch(authedPost(good, TOKEN))).status).toBe(200);
    expect((await h.app.fetch(summaryRequest(TOKEN))).status).toBe(200);
  });
});
