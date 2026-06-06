/**
 * Production entrypoint. Reads config from the environment (the bearer token is
 * NEVER a committed literal — ADR 0003), opens the SQLite file, and serves the app.
 * `bun run packages/server/src/index.ts`.
 */
import { Db } from "./db.ts";
import { createApp } from "./app.ts";
import { makeLogger } from "./log.ts";
import { pruneExpired, resolveRetentionDays, RetentionConfigError } from "./retention.ts";

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
const port = Number(process.env.PORT ?? 3410);
const staleAfterSeconds = Number(process.env.USAGE_STALE_AFTER_SECONDS ?? 120);
// Default the reckoning timezone to the server's own zone; override with env.
const timezone =
  process.env.USAGE_RECKONING_TZ ??
  Intl.DateTimeFormat().resolvedOptions().timeZone ??
  "UTC";
// Optional monthly budget; absent/0 disables the budget line.
const budgetRaw = Number(process.env.USAGE_BUDGET_USD ?? 0);
const budgetUsd = Number.isFinite(budgetRaw) && budgetRaw > 0 ? budgetRaw : null;

const db = new Db(dbPath);
const logger = makeLogger();
const app = createApp({ db, token, logger, summary: { staleAfterSeconds, timezone, budgetUsd } });

// Retention: prune rows not re-posted within the window, daily (phase 5, ADR 0011).
// A typo'd value fails fast rather than silently disabling pruning forever.
let retentionDays: number | null;
try {
  retentionDays = resolveRetentionDays(process.env);
} catch (e) {
  if (e instanceof RetentionConfigError) {
    process.stderr.write(`[fatal] ${e.message}\n`);
    process.exit(1);
  }
  throw e;
}
const pruneOnce = (): void => {
  const removed = pruneExpired(db, retentionDays, Date.now());
  if (removed > 0) logger.info("retention prune", { removed, retentionDays });
};
pruneOnce();
const pruneTimer = setInterval(pruneOnce, 24 * 3600_000);

const server = Bun.serve({ port, fetch: app.fetch });
logger.info("server listening", { port: server.port, db: dbPath, retentionDays });

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    logger.info("shutting down", { signal: sig });
    clearInterval(pruneTimer);
    server.stop();
    db.close();
    process.exit(0);
  });
}
