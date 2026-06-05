/**
 * Phase-5 ops smoke check: start the SERVER and the DAEMON from their *documented*
 * commands (real subprocesses, real HTTP, real bearer auth) and assert data flows
 * end to end. The daemon uses the stub ccusage so the check is deterministic and
 * needs no real local usage. Exit 0 on success.
 *
 * Run: bun run scripts/smoke-ops.ts
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UsageSummary } from "@usage/shared";

const repo = new URL("..", import.meta.url).pathname;
const TOKEN = "smoke-ops-secret";
const PORT = 8137; // an unlikely-busy port for the smoke
const base = `http://localhost:${PORT}`;
const tmp = mkdtempSync(join(tmpdir(), "usage-ops-"));
const dbPath = join(tmp, "smoke.db");

const procs: { kill: () => void }[] = [];
const cleanup = (): void => {
  for (const p of procs) {
    try {
      p.kill();
    } catch {
      /* already gone */
    }
  }
  rmSync(tmp, { recursive: true, force: true });
};
const fail = (msg: string): never => {
  cleanup();
  console.error(`✗ ops smoke FAILED: ${msg}`);
  process.exit(1);
};

async function waitFor(check: () => Promise<boolean>, what: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch {
      /* not ready yet */
    }
    await Bun.sleep(250);
  }
  fail(`timed out waiting for ${what}`);
}

const authed = (): Promise<Response> => fetch(`${base}/usage/summary`, { headers: { authorization: `Bearer ${TOKEN}` } });
const authedSummary = async (): Promise<UsageSummary> => (await authed()).json() as Promise<UsageSummary>;

// 1) Start the server from its documented command.
const server = Bun.spawn(["bun", "run", "packages/server/src/index.ts"], {
  cwd: repo,
  env: { ...process.env, USAGE_BEARER_TOKEN: TOKEN, PORT: String(PORT), USAGE_DB_PATH: dbPath, USAGE_RECKONING_TZ: "UTC" },
  stdout: "ignore",
  stderr: "ignore",
});
procs.push(server);

await waitFor(async () => (await fetch(base)).status === 401, "server to listen");

// Auth is enforced: no token → 401, correct token → 200 + a v2 summary.
if ((await fetch(`${base}/usage/summary`)).status !== 401) fail("server did not require auth");
const first = await authed();
if (first.status !== 200) fail(`authed summary returned ${first.status}`);
if (((await first.json()) as UsageSummary).v !== 2) fail("server did not return a v2 summary");

// 2) Start the daemon from its documented command, pointed at the stub ccusage.
const daemon = Bun.spawn(["bun", "run", "packages/daemon/src/index.ts"], {
  cwd: repo,
  env: {
    ...process.env,
    USAGE_BEARER_TOKEN: TOKEN,
    USAGE_SERVER_URL: base,
    USAGE_MACHINE_ID: "smoke-machine",
    USAGE_INTERVAL_SECONDS: "1",
    USAGE_CCUSAGE_CMD: "bun run scripts/fixtures/stub-ccusage.ts",
  },
  stdout: "ignore",
  stderr: "ignore",
});
procs.push(daemon);

// 3) Within a few ticks the stub's daily total (777) should appear via the daemon.
await waitFor(async () => (await authedSummary()).totals.tokens > 0, "daemon to post usage");

const summary = await authedSummary();
if (summary.totals.tokens !== 777) fail(`expected daily total 777 from the stub, got ${summary.totals.tokens}`);
if (!summary.by_provider.some((p) => p.provider === "claude-code")) fail("expected claude-code in by_provider");
if (!summary.by_machine.some((m) => m.machine === "smoke-machine")) fail("expected smoke-machine in by_machine");

console.log(`✓ ops smoke PASS — server + daemon started from documented commands; total=${summary.totals.tokens} flowed end to end`);
cleanup();
process.exit(0);
