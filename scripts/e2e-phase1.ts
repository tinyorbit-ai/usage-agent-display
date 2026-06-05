/**
 * Phase-1 end-to-end check (the scripted gate, exit 0 on match). Boots the REAL
 * server over HTTP on an ephemeral port, POSTs fixture snapshots from two distinct
 * machine_ids with the bearer token — including a re-post with an updated cumulative
 * value, plus session/monthly rows that must NOT inflate the hero — then GETs
 * /usage/summary and asserts the combined post-dedup, daily-only token total.
 *
 * Run: bun run scripts/e2e-phase1.ts
 */
import { Db } from "../packages/server/src/db.ts";
import { createApp } from "../packages/server/src/app.ts";
import { makeLogger } from "../packages/server/src/log.ts";
import type { IngestPayload, SnapshotRow, TokenCategory, UsageSummary } from "@usage/shared";

const TOKEN = "e2e-phase1-secret";

function categoryRows(
  provider: string,
  model: string,
  reportType: SnapshotRow["report_type"],
  bucket: string,
  counts: Record<TokenCategory, number>,
  cost = 0,
): SnapshotRow[] {
  return (Object.keys(counts) as TokenCategory[]).map((token_category) => ({
    provider,
    model,
    token_category,
    report_type: reportType,
    bucket,
    tokens: counts[token_category],
    cost_usd: cost,
  }));
}

function daily(bucket: string, counts: Record<TokenCategory, number>): SnapshotRow[] {
  return categoryRows("claude-code", "claude-opus-4-7", "daily", bucket, counts);
}

async function main(): Promise<void> {
  const db = new Db(":memory:");
  // Quiet logger so the e2e output is just the assertions.
  const app = createApp({ db, token: TOKEN, logger: makeLogger(() => {}) });
  const server = Bun.serve({ port: 0, fetch: app.fetch });
  const base = `http://localhost:${server.port}`;

  const post = async (payload: IngestPayload, token = TOKEN): Promise<Response> =>
    fetch(`${base}/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
    });

  const getSummary = async (): Promise<UsageSummary> => {
    const res = await fetch(`${base}/usage/summary`, { headers: { authorization: `Bearer ${TOKEN}` } });
    return (await res.json()) as UsageSummary;
  };

  const fail = (msg: string): never => {
    server.stop();
    db.close();
    console.error(`✗ e2e FAILED: ${msg}`);
    process.exit(1);
  };

  try {
    // --- auth: unauthorized writes and reads are refused ---
    const noAuth = await fetch(`${base}/usage/summary`);
    if (noAuth.status !== 401) fail(`GET without token expected 401, got ${noAuth.status}`);
    const badPost = await post({ machine_id: "x", collected_at: new Date().toISOString(), rows: daily("2026-06-05", { input: 1, output: 1, cache_read: 1, cache_write: 1 }) }, "wrong");
    if (badPost.status !== 401) fail(`POST with wrong token expected 401, got ${badPost.status}`);

    const now = new Date().toISOString();

    // --- machine A: two days of daily usage, plus session + monthly (must not inflate) ---
    await post({
      machine_id: "mbp-14",
      collected_at: now,
      rows: [
        ...daily("2026-06-04", { input: 10, output: 20, cache_write: 30, cache_read: 40 }), // 100
        ...daily("2026-06-05", { input: 100, output: 200, cache_write: 300, cache_read: 400 }), // 1000
        ...categoryRows("claude-code", "claude-opus-4-7", "session", "sess-x", { input: 0, output: 1000, cache_read: 0, cache_write: 0 }),
        ...categoryRows("claude-code", "claude-opus-4-7", "monthly", "2026-06", { input: 0, output: 1000, cache_read: 0, cache_write: 0 }),
      ],
    });

    // --- machine B: one day ---
    await post({
      machine_id: "studio",
      collected_at: now,
      rows: daily("2026-06-05", { input: 5, output: 15, cache_write: 25, cache_read: 55 }), // 100
    });

    // total now: 100 (A 6-04) + 1000 (A 6-05) + 100 (B 6-05) = 1200, daily only
    const before = await getSummary();
    if (before.totals.tokens !== 1200) fail(`expected 1200 before re-post, got ${before.totals.tokens}`);

    // --- re-post machine A's 2026-06-05 with an UPDATED cumulative value ---
    // cache_read grows 400 -> 900, so that day becomes 1500 (overwrite, not add).
    await post({
      machine_id: "mbp-14",
      collected_at: new Date().toISOString(),
      rows: daily("2026-06-05", { input: 100, output: 200, cache_write: 300, cache_read: 900 }), // 1500
    });

    // expected: 100 (A 6-04) + 1500 (A 6-05, overwritten) + 100 (B 6-05) = 1700
    const summary = await getSummary();
    const expected = 1700;
    if (summary.totals.tokens !== expected) {
      fail(`expected ${expected} after re-post (dedup + daily-only), got ${summary.totals.tokens}`);
    }
    if (!summary.last_sync || summary.last_sync.machine !== "mbp-14") {
      fail(`expected last_sync to be the freshest machine (mbp-14), got ${JSON.stringify(summary.last_sync)}`);
    }

    console.log(`✓ e2e PASS — combined daily total = ${summary.totals.tokens} (dedup + daily-only + 2 machines)`);
  } finally {
    server.stop();
    db.close();
  }
}

await main();
