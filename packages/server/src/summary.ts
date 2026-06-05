/**
 * Builds the compact {@link UsageSummary} the firmware renders. v1 = hero only.
 * The hero token total and cost come from the canonical (daily) deduped rows;
 * `last_sync` reports the freshest machine's age honestly so the panel never claims
 * fresher-than-true. See wiki/architecture.md.
 */
import type { UsageSummary } from "@usage/shared";
import type { Db } from "./db.ts";

export function buildSummary(db: Db, nowMs: number): UsageSummary {
  const newest = db.newestMachine();
  const lastSync =
    newest === null
      ? null
      : {
          machine: newest.machine_id,
          age_seconds: Math.max(0, Math.round((nowMs - newest.last_received_at) / 1000)),
        };

  return {
    v: 1,
    generated_at: new Date(nowMs).toISOString(),
    last_sync: lastSync,
    totals: {
      tokens: db.heroTokens(),
      cost_usd: db.heroCost(),
    },
  };
}
