/**
 * Test harness: an app wired to an in-memory DB with a controllable clock, plus
 * fixture builders. A `Clock` lets tests advance server time deterministically so
 * "received_at governs" and "last_sync age" are testable without real waiting.
 */
import { Db } from "../src/db.ts";
import { createApp, type App } from "../src/app.ts";
import type { SummaryConfig } from "../src/summary.ts";
import { makeLogger } from "../src/log.ts";
import type { IngestPayload, ReportType, SnapshotRow, TokenCategory, UsageSummary } from "@usage/shared";

export const TOKEN = "test-bearer-secret-0xCAFE";

export class Clock {
  constructor(public ms: number) {}
  now = (): number => this.ms;
  advance(deltaMs: number): void {
    this.ms += deltaMs;
  }
}

export interface Harness {
  app: App;
  db: Db;
  clock: Clock;
  logs: string[];
}

export function makeHarness(
  startMs = Date.parse("2026-06-05T12:00:00.000Z"),
  summary?: SummaryConfig,
): Harness {
  const db = new Db(":memory:");
  const clock = new Clock(startMs);
  const logs: string[] = [];
  const logger = makeLogger((line) => logs.push(line));
  const app = createApp({ db, token: TOKEN, logger, now: clock.now, ...(summary ? { summary } : {}) });
  return { app, db, clock, logs };
}

export function authedPost(body: unknown, token = TOKEN): Request {
  return new Request("http://x/ingest", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

export function summaryRequest(token = TOKEN): Request {
  return new Request("http://x/usage/summary", {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
  });
}

/** One category row with sane defaults; override what a test cares about. */
export function row(over: Partial<SnapshotRow> = {}): SnapshotRow {
  return {
    provider: "claude-code",
    model: "claude-opus-4-7",
    token_category: "output" as TokenCategory,
    report_type: "daily" as ReportType,
    bucket: "2026-06-05",
    tokens: 100,
    cost_usd: 0,
    ...over,
  };
}

export function payload(machineId: string, rows: SnapshotRow[], collectedAt?: string): IngestPayload {
  return {
    machine_id: machineId,
    collected_at: collectedAt ?? "2026-06-05T12:00:00.000Z",
    rows,
  };
}

/** POST a payload through the app and return the parsed JSON + status. */
export async function ingest(
  h: Harness,
  machineId: string,
  rows: SnapshotRow[],
  collectedAt?: string,
): Promise<{ status: number; body: unknown }> {
  const res = await h.app.fetch(authedPost(payload(machineId, rows, collectedAt)));
  return { status: res.status, body: await res.json() };
}

/** GET the summary through the app and return the parsed body. */
export async function getSummary(h: Harness): Promise<{ tokens: number; cost_usd: number; lastSyncAge: number | null }> {
  const body = await getFullSummary(h);
  return {
    tokens: body.totals.tokens,
    cost_usd: body.totals.cost_usd,
    lastSyncAge: body.last_sync ? body.last_sync.age_seconds : null,
  };
}

/** GET the full v2 summary, typed against the contract. */
export async function getFullSummary(h: Harness): Promise<UsageSummary> {
  const res = await h.app.fetch(summaryRequest());
  return (await res.json()) as UsageSummary;
}
