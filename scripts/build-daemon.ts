/**
 * Build the daemon as a single self-contained executable per platform (phase 8), so it
 * can be dropped onto a laptop / work laptop with no repo checkout. `bun build --compile`
 * embeds the Bun runtime + the daemon's JS into one file.
 *
 *   bun run build:daemon
 *
 * NOTE: the daemon shells out to ccusage at runtime (it does not bundle it). The target
 * machine needs `bunx`/`npx` on PATH, or set USAGE_CCUSAGE_CMD. See dist/README after build.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const ENTRY = join(ROOT, "packages/daemon/src/index.ts");
const OUT = join(ROOT, "dist");
mkdirSync(OUT, { recursive: true });

const targets = [
  { target: "bun-darwin-arm64", out: "usage-daemon-macos-arm64" },
  { target: "bun-darwin-x64", out: "usage-daemon-macos-x64" },
  { target: "bun-linux-x64", out: "usage-daemon-linux-x64" },
];

let failed = false;
for (const { target, out } of targets) {
  const outfile = join(OUT, out);
  process.stdout.write(`building ${out} (${target})… `);
  const r = spawnSync(
    "bun",
    ["build", ENTRY, "--compile", "--minify", `--target=${target}`, `--outfile=${outfile}`],
    { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] },
  );
  if (r.status !== 0) {
    failed = true;
    console.log("FAILED");
    process.stderr.write((r.stderr?.toString() ?? "").slice(0, 800) + "\n");
    continue;
  }
  const mb = (statSync(outfile).size / 1e6).toFixed(1);
  console.log(`ok (${mb} MB)`);
}

writeFileSync(
  join(OUT, "README.md"),
  `# usage-daemon — distributable binaries

Single-file daemons (Bun runtime embedded). One per platform — pick yours:

- \`usage-daemon-macos-arm64\` — Apple Silicon Mac
- \`usage-daemon-macos-x64\`  — Intel Mac
- \`usage-daemon-linux-x64\`  — Linux x64

## Run

The daemon reads its config from the environment and posts ccusage totals to the server:

\`\`\`sh
export USAGE_SERVER_URL="https://usage.example.com"   # the public server URL
export USAGE_BEARER_TOKEN="<the shared secret from Doppler>"
export USAGE_MACHINE_ID="laptop"                         # unique per machine
export USAGE_INTERVAL_SECONDS=30
# Optional: pin/override how ccusage is invoked (default: bunx ccusage).
# export USAGE_CCUSAGE_CMD="npx -y ccusage@20.0.6"
./usage-daemon-macos-arm64
\`\`\`

## Requirement: ccusage

The binary embeds Bun for itself but runs **ccusage** as a subprocess, so the machine
needs \`bunx\` (install Bun: \`curl -fsSL https://bun.sh/install | bash\`) or \`npx\`
(set \`USAGE_CCUSAGE_CMD="npx -y ccusage@20.0.6"\`). ccusage reads the local
\`~/.claude\` / \`~/.codex\` / Gemini usage logs.

## Run unattended

Adapt \`deploy/launchd/\` (macOS) — point \`ProgramArguments\` at the binary and set the
env vars above. The daemon retries on the next tick if the server is unreachable;
nothing is lost (cumulative posts are idempotent).
`,
);
console.log(failed ? "\nsome targets failed" : `\nwrote ${targets.length} binaries + README to dist/`);
process.exit(failed ? 1 : 0);
