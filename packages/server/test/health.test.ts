// Phase 8: an unauthenticated GET /health liveness probe for the deploy hub / tunnel.
// It carries no usage data, so it sits in front of the bearer gate — but the data
// endpoints stay protected.
import { describe, expect, test } from "bun:test";
import { makeHarness, summaryRequest } from "./helpers.ts";

describe("/health liveness", () => {
  test("GET /health returns 200 {ok:true} WITHOUT a token", async () => {
    const h = makeHarness();
    const res = await h.app.fetch(new Request("http://x/health", { method: "GET" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("health is not a backdoor — the data endpoint still demands the token", async () => {
    const h = makeHarness();
    expect((await h.app.fetch(summaryRequest("wrong"))).status).toBe(401);
  });
});
