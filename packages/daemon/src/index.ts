/**
 * Daemon entrypoint. Loads config from env, builds the ccusage collector and the
 * poster, and runs the loop. `bun run packages/daemon/src/index.ts`.
 *
 * The bearer token comes from env and is never logged; the logger here only ever
 * prints counts and statuses.
 */
import { ConfigError, loadConfig } from "./config.ts";
import { ccusageCollector } from "./collector.ts";
import { makePoster } from "./post.ts";
import { runLoop } from "./loop.ts";

function log(msg: string, ctx?: Record<string, unknown>): void {
  const suffix = ctx ? " " + JSON.stringify(ctx) : "";
  process.stdout.write(`[daemon] ${msg}${suffix}\n`);
}

let config;
try {
  config = loadConfig();
} catch (e) {
  if (e instanceof ConfigError) {
    process.stderr.write(`[daemon] config error: ${e.message}\n`);
    process.exit(1);
  }
  throw e;
}

const collector = ccusageCollector({ provider: config.provider, reports: config.reports });
const poster = makePoster({ serverUrl: config.serverUrl, token: config.token });

log("starting", {
  machine_id: config.machineId,
  server: config.serverUrl,
  provider: config.provider,
  interval_ms: config.intervalMs,
});

const stop = runLoop(
  { machineId: config.machineId, collectors: [collector], poster, log },
  config.intervalMs,
);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    log("stopping", { signal: sig });
    stop();
    process.exit(0);
  });
}
