/**
 * Pre-merge secrets scan (security gate, ADR 0003). Uses `gitleaks detect` with our
 * config when gitleaks is installed. When it is NOT installed, falls back to a
 * focused scan of git-TRACKED files for this project's secret shapes (committed
 * bearer token / WiFi creds / a tracked firmware config.h) so the gate still has
 * teeth. Exit non-zero on any finding.
 *
 * Run: bun run scripts/scan-secrets.ts
 */
const repoRoot = new URL("..", import.meta.url).pathname;

function hasGitleaks(): boolean {
  const which = Bun.spawnSync(["which", "gitleaks"], { stdout: "pipe", stderr: "pipe" });
  return which.exitCode === 0;
}

async function trackedFiles(): Promise<string[]> {
  const proc = Bun.spawnSync(["git", "ls-files"], { cwd: repoRoot, stdout: "pipe" });
  return proc.stdout.toString().split("\n").filter((l) => l.length > 0);
}

function runGitleaks(): number {
  const proc = Bun.spawnSync(
    ["gitleaks", "detect", "--config", ".gitleaks.toml", "--no-banner", "--redact"],
    { cwd: repoRoot, stdout: "inherit", stderr: "inherit" },
  );
  return proc.exitCode ?? 1;
}

// Fallback rules mirror .gitleaks.toml's custom rules.
const RULES: { id: string; re: RegExp; allow: RegExp }[] = [
  {
    id: "bearer-token",
    re: /(usage_bearer_token|api_bearer_token|bearer[_-]?token)\s*[:=]\s*["'][^"']{8,}["']/i,
    allow: /replace-with|your-|<[^>]+>/i,
  },
  {
    id: "wifi-credentials",
    re: /(wifi_ssid|wifi_password|wifi_psk)\s*[:=]\s*["'][^"']+["']/i,
    allow: /your-network|your-password|your-/i,
  },
];

const ALLOWED_PATHS = [/config\.h\.example$/, /\.env\.example$/, /\.gitleaks\.toml$/, /scripts\/scan-secrets\.ts$/];

async function fallbackScan(): Promise<number> {
  const files = await trackedFiles();
  const findings: string[] = [];

  // A tracked firmware config.h would mean real secrets got committed.
  if (files.includes("firmware/src/config.h")) {
    findings.push("firmware/src/config.h is tracked — it must be gitignored (only config.h.example is committed)");
  }

  for (const file of files) {
    if (ALLOWED_PATHS.some((re) => re.test(file))) continue;
    let text: string;
    try {
      text = await Bun.file(repoRoot + file).text();
    } catch {
      continue; // binary or unreadable
    }
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      for (const rule of RULES) {
        if (rule.re.test(line) && !rule.allow.test(line)) {
          findings.push(`${file}:${i + 1}: possible ${rule.id}`);
        }
      }
    }
  }

  if (findings.length > 0) {
    console.error("✗ secrets scan found issues:");
    for (const f of findings) console.error(`  ${f}`);
    return 1;
  }
  console.log("✓ secrets scan (fallback) clean — no committed bearer tokens or WiFi creds");
  console.log("  note: install gitleaks for the full default ruleset (brew install gitleaks)");
  return 0;
}

const code = hasGitleaks() ? runGitleaks() : await fallbackScan();
process.exit(code);
