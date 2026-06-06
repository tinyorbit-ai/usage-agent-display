/**
 * One-command daemon install (phase 8/10). Clone the repo on a machine, then:
 *
 *   bun install
 *   USAGE_SERVER_URL=https://usage.your-domain USAGE_BEARER_TOKEN=… bun run daemon:install
 *
 * It compiles the daemon to a single binary and installs a background service that
 * starts on login and auto-restarts (launchd on macOS, systemd --user on Linux).
 * Missing required values are prompted for when run interactively. The bearer token is
 * written only into the local service file (your home dir) — never committed.
 *
 * Re-run any time to rebuild + reinstall (e.g. after `git pull`). Uninstall:
 *   macOS:  launchctl bootout gui/$(id -u)/com.usage.daemon; rm ~/Library/LaunchAgents/com.usage.daemon.plist
 *   Linux:  systemctl --user disable --now usage-daemon
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { hostname, homedir, platform } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const HOME = homedir();
const BIN_DIR = join(HOME, ".usage-agent");
const BIN = join(BIN_DIR, "usage-daemon");
const LABEL = "com.usage.daemon";

function ask(name: string, fallback = ""): string {
  const env = process.env[name];
  if (env && env.trim()) return env.trim();
  if (process.stdin.isTTY) {
    const v = (prompt(`${name}${fallback ? ` [${fallback}]` : ""}:`) ?? "").trim();
    if (v) return v;
  }
  if (fallback) return fallback;
  console.error(`\nMissing required ${name}. Set it as an env var or run interactively.`);
  process.exit(1);
}

function which(cmd: string): string | null {
  const r = spawnSync("command", ["-v", cmd], { shell: true, encoding: "utf8" });
  const first = (r.stdout ?? "").trim().split("\n")[0] ?? "";
  return first && existsSync(first) ? first : null;
}

// --- resolve config ---
const serverUrl = ask("USAGE_SERVER_URL").replace(/\/$/, "");
const token = ask("USAGE_BEARER_TOKEN");
const machineId = ask("USAGE_MACHINE_ID", hostname().replace(/\.local$/i, "").toLowerCase());
const interval = process.env.USAGE_INTERVAL_SECONDS?.trim() || "30";
const provider = process.env.USAGE_PROVIDER?.trim() || "claude-code";

// ccusage runner: explicit override, else absolute bunx/npx (launchd/systemd have a bare PATH).
const ccusageCmd =
  process.env.USAGE_CCUSAGE_CMD?.trim() ||
  (() => {
    const bunx = which("bunx");
    if (bunx) return `${bunx} ccusage`;
    const npx = which("npx");
    if (npx) return `${npx} -y ccusage@20.0.6`;
    console.error("\n⚠ neither bunx nor npx found — install Bun (curl -fsSL https://bun.sh/install | bash)");
    console.error("  or set USAGE_CCUSAGE_CMD to how ccusage should run.");
    process.exit(1);
  })();

// --- build the binary ---
mkdirSync(BIN_DIR, { recursive: true });
console.log("building daemon binary…");
const build = spawnSync(
  "bun",
  ["build", join(ROOT, "packages/daemon/src/index.ts"), "--compile", "--minify", `--outfile=${BIN}`],
  { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] },
);
if (build.status !== 0) {
  console.error(build.stderr?.toString() ?? "build failed");
  process.exit(1);
}
console.log(`  → ${BIN}`);

const env: Record<string, string> = {
  USAGE_SERVER_URL: serverUrl,
  USAGE_BEARER_TOKEN: token,
  USAGE_MACHINE_ID: machineId,
  USAGE_INTERVAL_SECONDS: interval,
  USAGE_PROVIDER: provider,
  USAGE_CCUSAGE_CMD: ccusageCmd,
};

const os = platform();
if (os === "darwin") installLaunchd();
else if (os === "linux") installSystemd();
else {
  console.log(`\nBuilt ${BIN}. No service installer for ${os} — run it directly with the env vars above.`);
}

function xml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function installLaunchd(): void {
  const plistPath = join(HOME, "Library/LaunchAgents", `${LABEL}.plist`);
  const envXml = Object.entries(env)
    .map(([k, v]) => `    <key>${k}</key><string>${xml(v)}</string>`)
    .join("\n");
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${BIN}</string></array>
  <key>EnvironmentVariables</key>
  <dict>
${envXml}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${join(BIN_DIR, "daemon.out.log")}</string>
  <key>StandardErrorPath</key><string>${join(BIN_DIR, "daemon.err.log")}</string>
</dict>
</plist>
`;
  mkdirSync(join(HOME, "Library/LaunchAgents"), { recursive: true });
  writeFileSync(plistPath, plist, { mode: 0o600 });
  const uid = process.getuid?.() ?? 0;
  spawnSync("launchctl", ["bootout", `gui/${uid}/${LABEL}`], { stdio: "ignore" }); // ignore if not loaded
  const load = spawnSync("launchctl", ["bootstrap", `gui/${uid}`, plistPath], { encoding: "utf8" });
  if (load.status !== 0) {
    // Fall back to the classic verb on older macOS.
    spawnSync("launchctl", ["unload", plistPath], { stdio: "ignore" });
    spawnSync("launchctl", ["load", "-w", plistPath], { stdio: "inherit" });
  }
  console.log(`\n✓ installed launchd agent → ${plistPath}`);
  console.log(`  machine_id: ${machineId}   server: ${serverUrl}`);
  console.log(`  logs: ${join(BIN_DIR, "daemon.out.log")}`);
  console.log(`  stop: launchctl bootout gui/${uid}/${LABEL}`);
}

function installSystemd(): void {
  const dir = join(HOME, ".config/systemd/user");
  mkdirSync(dir, { recursive: true });
  const unitEnv = Object.entries(env)
    .map(([k, v]) => `Environment=${k}=${v}`)
    .join("\n");
  const unit = `[Unit]
Description=usage-agent daemon
After=network-online.target

[Service]
ExecStart=${BIN}
Restart=always
RestartSec=10
${unitEnv}

[Install]
WantedBy=default.target
`;
  const unitPath = join(dir, "usage-daemon.service");
  writeFileSync(unitPath, unit, { mode: 0o600 });
  spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "inherit" });
  spawnSync("systemctl", ["--user", "enable", "--now", "usage-daemon"], { stdio: "inherit" });
  console.log(`\n✓ installed systemd --user service → ${unitPath}`);
  console.log(`  machine_id: ${machineId}   server: ${serverUrl}`);
  console.log("  survive logout: sudo loginctl enable-linger $USER");
  console.log("  logs: journalctl --user -u usage-daemon -f");
  console.log("  stop: systemctl --user disable --now usage-daemon");
}
