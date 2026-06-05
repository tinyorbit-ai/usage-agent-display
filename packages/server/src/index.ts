/**
 * Production entrypoint. Reads config from the environment (the bearer token is
 * NEVER a committed literal — ADR 0003), opens the SQLite file, and serves the app.
 * `bun run packages/server/src/index.ts`.
 */
import { Db } from "./db.ts";
import { createApp } from "./app.ts";
import { makeLogger } from "./log.ts";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.length === 0) {
    process.stderr.write(`[fatal] missing required env var ${name}\n`);
    process.exit(1);
  }
  return v;
}

const token = requireEnv("USAGE_BEARER_TOKEN");
const dbPath = process.env.USAGE_DB_PATH ?? "usage.db";
const port = Number(process.env.PORT ?? 8080);
const staleAfterSeconds = Number(process.env.USAGE_STALE_AFTER_SECONDS ?? 120);
// Default the reckoning timezone to the server's own zone; override with env.
const timezone =
  process.env.USAGE_RECKONING_TZ ??
  Intl.DateTimeFormat().resolvedOptions().timeZone ??
  "UTC";

const db = new Db(dbPath);
const logger = makeLogger();
const app = createApp({ db, token, logger, summary: { staleAfterSeconds, timezone } });

const server = Bun.serve({ port, fetch: app.fetch });
logger.info("server listening", { port: server.port, db: dbPath });

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    logger.info("shutting down", { signal: sig });
    server.stop();
    db.close();
    process.exit(0);
  });
}
