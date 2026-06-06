// vibe-realm deploy config (phase 8). Discovered by the deployment system when this
// repo is listed in its repos.json with appsDir "packages". PM2 runs the server with
// Bun directly; env is injected from Doppler (only the vars declared below).
//
// publicInternet → a Cloudflare Tunnel hostname `usage.<baseDomain>` (e.g.
// https://usage.mountaindev.uk), reachable from any machine. Auth is the shared bearer
// token (USAGE_BEARER_TOKEN) on every request — the public URL is safe because the read
// path is bearer-protected too (ADR 0003). `/health` is the only unauthenticated route.
module.exports = {
  apps: [
    {
      name: "usage",
      script: "src/index.ts",
      interpreter: "bun",
      packageManager: "bun",
      envVars: [
        // PORT is shifted to an internal port by the deploy system when HTTPS is on;
        // the server binds whatever PORT it's given. The default lets the hub link it.
        { name: "PORT", default: "8080" },
        // The shared secret — set USAGE_AGENT_BEARER_TOKEN in Doppler. The SAME value
        // goes on every daemon (laptops) and the firmware config.h.
        { name: "USAGE_BEARER_TOKEN", from: "USAGE_AGENT_BEARER_TOKEN" },
        // SQLite file (cwd-relative to the app dir; persists across reloads).
        { name: "USAGE_DB_PATH", default: "usage.db" },
        // Timezone the server reckons "today"/"this month"/timeframes in.
        { name: "USAGE_RECKONING_TZ", default: "Europe/London" },
        { name: "USAGE_STALE_AFTER_SECONDS", default: "120" },
        { name: "USAGE_RETENTION_DAYS", default: "400" },
        // Optional monthly budget; unset disables the budget line.
        { name: "USAGE_BUDGET_USD", from: "USAGE_AGENT_BUDGET_USD", required: false },
      ],
      publicInternet: { enabled: true }, // → https://usage.<baseDomain>
      manifest: {
        description: "AI-coding usage aggregator — daemons POST ccusage totals, the CYD panel polls /usage/summary",
        category: "api",
        tags: ["usage", "ccusage", "esp32", "bun", "sqlite"],
        icon: "📊",
        healthEndpoint: "/health",
      },
    },
  ],
};
