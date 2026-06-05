/**
 * The collect→post tick, and the interval loop around it. One tick collects from
 * every collector, builds a single payload stamped with the daemon clock, and posts
 * it. Every failure path (collect throws, post fails, zero rows) is handled so the
 * loop survives and simply retries next interval.
 */
import type { IngestPayload, SnapshotRow } from "@usage/shared";
import type { Collector } from "./collector.ts";
import type { Poster, PostOutcome } from "./post.ts";

export interface TickDeps {
  machineId: string;
  collectors: readonly Collector[];
  poster: Poster;
  now?: () => number;
  log?: (msg: string, ctx?: Record<string, unknown>) => void;
}

export interface TickResult {
  collected: number;
  skipped: number;
  outcome: PostOutcome | "no-rows";
}

/** Run one collect→post tick. Never throws — collector errors are isolated. */
export async function tick(deps: TickDeps): Promise<TickResult> {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? (() => {});

  const rows: SnapshotRow[] = [];
  let skipped = 0;
  for (const collector of deps.collectors) {
    try {
      const result = await collector.collect();
      rows.push(...result.rows);
      skipped += result.skipped;
    } catch (e) {
      // A collector blowing up (e.g. ccusage missing) must not stop the others.
      skipped++;
      log("collector failed", { provider: collector.provider, error: String(e) });
    }
  }

  if (rows.length === 0) {
    log("nothing to post this tick", { skipped });
    return { collected: 0, skipped, outcome: "no-rows" };
  }

  const payload: IngestPayload = {
    machine_id: deps.machineId,
    collected_at: new Date(now()).toISOString(),
    rows,
  };

  const outcome = await deps.poster.post(payload);
  if (outcome.ok) {
    log("posted", { rows: rows.length, accepted: outcome.accepted, skipped });
  } else {
    log("post failed (will retry next tick)", { status: outcome.status, error: outcome.error });
  }
  return { collected: rows.length, skipped, outcome };
}

/**
 * Run `tick` forever on an interval. Returns a stop function. Each tick is awaited
 * before scheduling the next so ticks never overlap.
 */
export function runLoop(deps: TickDeps, intervalMs: number): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  // Self-chaining: each tick is awaited to completion before the next is scheduled,
  // so ticks never overlap even if one runs longer than the interval. The interval
  // is the gap *between* ticks.
  const run = async (): Promise<void> => {
    if (stopped) return;
    await tick(deps).catch(() => {});
    if (stopped) return;
    timer = setTimeout(() => void run(), intervalMs);
  };

  void run(); // fire the first tick immediately

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
