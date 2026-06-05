/**
 * Retention config + prune (phase 5, ADR 0011), extracted so it's unit-testable rather
 * than buried in the entrypoint. `resolveRetentionDays` fails fast on a typo'd value
 * (an invalid number must NOT silently disable pruning forever); only an explicit `0`
 * disables it. `pruneExpired` removes rows not re-posted within the window.
 */
import type { Db } from "./db.ts";

export class RetentionConfigError extends Error {}

/** days → null (disabled) given the env. Default 400; explicit 0 disables; invalid throws. */
export function resolveRetentionDays(env: NodeJS.ProcessEnv): number | null {
  const raw = env.USAGE_RETENTION_DAYS;
  if (raw === undefined || raw.trim() === "") return 400; // default
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new RetentionConfigError(`USAGE_RETENTION_DAYS must be a non-negative number, got "${raw}"`);
  }
  return n === 0 ? null : n; // only an explicit 0 disables retention
}

/** Prune snapshots older than the window, given `nowMs`. Returns rows removed. */
export function pruneExpired(db: Db, retentionDays: number | null, nowMs: number): number {
  if (retentionDays === null) return 0;
  return db.pruneSnapshotsBefore(nowMs - retentionDays * 86_400_000);
}
