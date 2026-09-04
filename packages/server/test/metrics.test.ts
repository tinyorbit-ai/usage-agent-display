// Phase 8: GET /metrics is bearer-protected exactly like /ingest and /usage/summary
// (it must never be exempted — the app is publicly reachable), and its body reflects
// real activity: an ingest bumps the counters and gauges.
import { describe, expect, test } from "bun:test";
import { ingest, makeHarness, row } from "./helpers.ts";

function metricsRequest(token?: string): Request {
  return new Request("http://x/metrics", {
    method: "GET",
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

describe("GET /metrics", () => {
  test("no token → 401", async () => {
    const h = makeHarness();
    const res = await h.app.fetch(new Request("http://x/metrics", { method: "GET" }));
    expect(res.status).toBe(401);
  });

  test("wrong token → 401", async () => {
    const h = makeHarness();
    const res = await h.app.fetch(metricsRequest("wrong"));
    expect(res.status).toBe(401);
  });

  test("correct token → 200 Prometheus text exposition", async () => {
    const h = makeHarness();
    const res = await h.app.fetch(metricsRequest("test-bearer-secret-0xCAFE"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; version=0.0.4; charset=utf-8");
    const body = await res.text();
    expect(body).toContain("usage_build_info{version=");
    expect(body).toContain("usage_ingest_total 0");
    expect(body).toContain('usage_db_rows{table="snapshots"} 0');
  });

  test("an accepted ingest is reflected in the ingest + row-count gauges", async () => {
    const h = makeHarness();
    await ingest(h, "mbp-14", [row()]);
    const res = await h.app.fetch(metricsRequest("test-bearer-secret-0xCAFE"));
    const body = await res.text();
    expect(body).toContain("usage_ingest_total 1");
    expect(body).toContain('usage_db_rows{table="snapshots"} 1');
    expect(body).not.toContain("usage_last_ingest_timestamp_seconds 0\n");
  });

  test("a rejected ingest is reflected in the ingest-errors counter, not accepted", async () => {
    const h = makeHarness();
    await h.app.fetch(
      new Request("http://x/ingest", {
        method: "POST",
        headers: { authorization: "Bearer test-bearer-secret-0xCAFE", "content-type": "application/json" },
        body: "not json",
      }),
    );
    const res = await h.app.fetch(metricsRequest("test-bearer-secret-0xCAFE"));
    const body = await res.text();
    expect(body).toContain("usage_ingest_total 0");
    expect(body).toContain("usage_ingest_errors_total 1");
  });

  test("counts its own requests via usage_http_requests_total", async () => {
    const h = makeHarness();
    await h.app.fetch(new Request("http://x/health"));
    const res = await h.app.fetch(metricsRequest("test-bearer-secret-0xCAFE"));
    const body = await res.text();
    expect(body).toContain('usage_http_requests_total{path="/health",status="200"} 1');
  });
});
