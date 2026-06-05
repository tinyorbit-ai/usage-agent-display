/**
 * The "live" rollups (phase 4): a rolling 1-hour token-burn sparkline and the
 * currently-active machine. Both come from DELTAS between consecutive samples of each
 * machine's monotonic running total — burn, not cumulative. ADR 0010.
 *
 * active_machine is the machine with the most recent POSITIVE delta inside the window
 * (the one actually burning tokens), explicitly NOT the most-recently-synced daemon,
 * which posts on a timer even when idle (Codex review catch, baked into the plan).
 */
import type { Sparkline } from "@usage/shared";
import type { Db, TotalSample } from "./db.ts";

export interface LiveConfig {
  windowSeconds: number;
  bucketSeconds: number;
}

export const DEFAULT_LIVE_CONFIG: LiveConfig = { windowSeconds: 3600, bucketSeconds: 60 };

export interface LiveRollup {
  sparkline_1h: Sparkline;
  active_machine: string | null;
}

export function buildLive(db: Db, nowMs: number, config: LiveConfig = DEFAULT_LIVE_CONFIG): LiveRollup {
  const bucketMs = config.bucketSeconds * 1000;
  const numBuckets = Math.max(1, Math.round(config.windowSeconds / config.bucketSeconds));
  const windowStart = nowMs - config.windowSeconds * 1000;
  const buckets = new Array<number>(numBuckets).fill(0);

  const samples = db.samplesForWindow(windowStart);

  let activeMachine: string | null = null;
  let activeAt = -Infinity;
  let prev: TotalSample | null = null;

  for (const cur of samples) {
    // samplesForWindow is sorted by machine then time; reset deltas at a machine change.
    if (prev === null || prev.machine_id !== cur.machine_id) {
      prev = cur;
      continue;
    }

    const delta = cur.total_tokens - prev.total_tokens;
    prev = cur;
    if (delta <= 0) continue; // idle, correction, or rollover — no positive burn

    // The burn happened over (prev, cur]; attribute it to cur's bucket, if in window.
    if (cur.received_at < windowStart || cur.received_at > nowMs) continue;
    const idx = Math.min(numBuckets - 1, Math.floor((cur.received_at - windowStart) / bucketMs));
    buckets[idx] = (buckets[idx] ?? 0) + delta;

    if (cur.received_at > activeAt) {
      activeAt = cur.received_at;
      activeMachine = cur.machine_id;
    }
  }

  return {
    sparkline_1h: { bucket_seconds: config.bucketSeconds, buckets },
    active_machine: activeMachine,
  };
}
