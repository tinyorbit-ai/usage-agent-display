/**
 * Daemon configuration, resolved from the environment. The bearer token is read
 * from env and NEVER logged or committed (ADR 0003). `machine_id` provenance is
 * deliberate: an explicit id wins; otherwise a stable hostname-derived id is used;
 * a value two machines could collide on (bare `localhost`, empty) is refused so the
 * cross-machine aggregation can never silently merge two boxes into one.
 */
import { hostname } from "node:os";

export interface DaemonConfig {
  machineId: string;
  serverUrl: string;
  token: string;
  /** ccusage report types to collect each tick. */
  reports: readonly ("daily" | "session" | "monthly")[];
  /** poll interval in ms. */
  intervalMs: number;
  /** the provider label collected ccusage rows are tagged with. */
  provider: string;
}

/** Values too generic to safely identify a single machine. */
const FORBIDDEN_IDS = new Set(["", "localhost", "localhost.localdomain", "127.0.0.1"]);

export class ConfigError extends Error {}

/** Derive a stable id from the hostname: strip the mDNS `.local` suffix, lowercase. */
export function hostnameMachineId(host: string): string {
  return host.trim().replace(/\.local$/i, "").toLowerCase();
}

/**
 * Resolve the machine id: explicit `USAGE_MACHINE_ID` wins; otherwise derive from
 * the hostname. Throws if neither yields a value safe to distinguish machines by.
 */
export function resolveMachineId(
  explicit: string | undefined,
  host: string = hostname(),
): string {
  const candidate = explicit?.trim() ? explicit.trim() : hostnameMachineId(host);
  if (FORBIDDEN_IDS.has(candidate.toLowerCase())) {
    throw new ConfigError(
      `refusing machine_id "${candidate}" — set USAGE_MACHINE_ID to a unique value per machine`,
    );
  }
  return candidate;
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name];
  if (!v || v.length === 0) throw new ConfigError(`missing required env var ${name}`);
  return v;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): DaemonConfig {
  const intervalSeconds = Number(env.USAGE_INTERVAL_SECONDS ?? 30);
  if (!Number.isFinite(intervalSeconds) || intervalSeconds < 1) {
    throw new ConfigError("USAGE_INTERVAL_SECONDS must be a number >= 1");
  }
  return {
    machineId: resolveMachineId(env.USAGE_MACHINE_ID),
    serverUrl: requireEnv(env, "USAGE_SERVER_URL").replace(/\/$/, ""),
    token: requireEnv(env, "USAGE_BEARER_TOKEN"),
    reports: ["daily", "session", "monthly"],
    intervalMs: Math.round(intervalSeconds * 1000),
    provider: env.USAGE_PROVIDER?.trim() || "claude-code",
  };
}
