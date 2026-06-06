/**
 * The HTTP surface: `POST /ingest` and `GET /usage/summary`, both bearer-protected.
 * Pure routing + glue — correctness lives in db/validate/summary. Built as a
 * `fetch` handler so it can be unit-tested without binding a socket and served by
 * `Bun.serve` in `index.ts`.
 */
import { LIMITS } from "@usage/shared";
import { type StoredSnapshot, Db } from "./db.ts";
import { isAuthorized } from "./auth.ts";
import { validateIngest } from "./validate.ts";
import { buildSummary, type SummaryConfig } from "./summary.ts";
import { makeLogger, type Logger } from "./log.ts";

/** Default freshness threshold and reckoning timezone if the app isn't configured. */
export const DEFAULT_SUMMARY_CONFIG: SummaryConfig = {
  staleAfterSeconds: 120,
  timezone: "UTC",
};

export interface AppDeps {
  db: Db;
  token: string;
  logger?: Logger;
  /** Injectable clock (epoch ms) for deterministic tests. Defaults to Date.now. */
  now?: () => number;
  /** Freshness threshold + reckoning timezone. Defaults to {@link DEFAULT_SUMMARY_CONFIG}. */
  summary?: SummaryConfig;
}

export interface App {
  fetch(req: Request): Promise<Response>;
  db: Db;
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const unauthorized = (): Response =>
  new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: { "content-type": "application/json", "www-authenticate": "Bearer" },
  });

export function createApp(deps: AppDeps): App {
  const { db, token } = deps;
  const logger = deps.logger ?? makeLogger();
  const now = deps.now ?? Date.now;
  const summaryConfig = deps.summary ?? DEFAULT_SUMMARY_CONFIG;

  async function handleIngest(req: Request): Promise<Response> {
    // Cap the body BEFORE parsing so a giant payload can't exhaust memory. Trust the
    // Content-Length when present; otherwise read the text and measure it ourselves.
    const declared = Number(req.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > LIMITS.BODY_BYTES_MAX) {
      return json({ error: "payload too large" }, 413);
    }
    let raw: string;
    try {
      raw = await req.text();
    } catch {
      return json({ error: "could not read body" }, 400);
    }
    if (raw.length > LIMITS.BODY_BYTES_MAX) {
      return json({ error: "payload too large" }, 413);
    }
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return json({ error: "invalid JSON" }, 400);
    }

    const nowMs = now();
    const result = validateIngest(body, nowMs);
    if (!result.ok) {
      logger.warn("ingest rejected", { error: result.error });
      return json({ error: result.error }, 400);
    }

    const { machine_id, collected_at, rows } = result.value;
    const stored: StoredSnapshot[] = rows.map((r) => ({
      ...r,
      machine_id,
      collected_at,
      received_at: nowMs,
    }));
    db.upsertMany(stored);
    // phase 4: sample the machine's new running total so burn deltas can be bucketed.
    db.recordSample(machine_id, nowMs, db.machineDailyTotal(machine_id));
    logger.info("ingest accepted", { machine_id, rows: stored.length });
    return json({ ok: true, accepted: stored.length });
  }

  function handleSummary(): Response {
    return json(buildSummary(db, now(), summaryConfig));
  }

  return {
    db,
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);

      // Unauthenticated liveness probe (no data) — for the deploy hub / tunnel health
      // checks. Carries nothing sensitive, so it sits in front of the bearer gate.
      if (req.method === "GET" && url.pathname === "/health") {
        return json({ ok: true });
      }

      // Both endpoints require the shared bearer token (read path included).
      if (!isAuthorized(req, token)) return unauthorized();

      if (req.method === "POST" && url.pathname === "/ingest") {
        return handleIngest(req);
      }
      if (req.method === "GET" && url.pathname === "/usage/summary") {
        return handleSummary();
      }
      return json({ error: "not found" }, 404);
    },
  };
}
