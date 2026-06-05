/**
 * Builds the v2 {@link UsageSummary} the firmware renders: hero, per-provider and
 * per-machine breakdowns (with honest staleness), the active session, and
 * month-to-date. Time reckoning ("this month") uses ONE declared timezone so machines
 * in different zones roll up consistently. See wiki/architecture.md / ADR 0008.
 */
import type {
  MachineBreakdown,
  ProviderBreakdown,
  UsageSummary,
} from "@usage/shared";
import type { Db } from "./db.ts";

export interface SummaryConfig {
  /** a machine with nothing newer than this many seconds is flagged stale. */
  staleAfterSeconds: number;
  /** IANA timezone the server reckons "this month" / "today" in. */
  timezone: string;
}

/** The reckoning month `YYYY-MM` for an instant, in the declared timezone. */
export function reckoningMonth(nowMs: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
  }).formatToParts(new Date(nowMs));
  const year = parts.find((p) => p.type === "year")?.value ?? "0000";
  const month = parts.find((p) => p.type === "month")?.value ?? "00";
  return `${year}-${month}`;
}

export function buildSummary(db: Db, nowMs: number, config: SummaryConfig): UsageSummary {
  const newest = db.newestMachine();
  const lastSync =
    newest === null
      ? null
      : {
          machine: newest.machine_id,
          age_seconds: ageSeconds(nowMs, newest.last_received_at),
        };

  const byProvider: ProviderBreakdown[] = db.byProvider().map((r) => ({
    provider: r.key,
    tokens: r.tokens,
    cost_usd: r.cost_usd,
  }));

  // Join the per-machine daily rollup with every machine's freshness so a machine
  // that has gone silent still appears — stale, with a climbing age — rather than
  // vanishing from the panel.
  const dailyByMachine = new Map(db.byMachineDaily().map((m) => [m.machine_id, m]));
  const byMachine: MachineBreakdown[] = db.allMachines().map((m) => {
    const daily = dailyByMachine.get(m.machine_id);
    const age = ageSeconds(nowMs, m.last_received_at);
    return {
      machine: m.machine_id,
      tokens: daily?.tokens ?? 0,
      cost_usd: daily?.cost_usd ?? 0,
      age_seconds: age,
      stale: age > config.staleAfterSeconds,
    };
  });

  const session = db.activeSession();
  const month = reckoningMonth(nowMs, config.timezone);
  const monthRollup = db.monthToDate(month);

  return {
    v: 2,
    generated_at: new Date(nowMs).toISOString(),
    last_sync: lastSync,
    totals: { tokens: db.heroTokens(), cost_usd: db.heroCost() },
    by_provider: byProvider,
    by_machine: byMachine,
    session:
      session === null
        ? null
        : { machine: session.machine_id, tokens: session.tokens, cost_usd: session.cost_usd },
    month: { month, tokens: monthRollup.tokens, cost_usd: monthRollup.cost_usd },
  };
}

function ageSeconds(nowMs: number, receivedAtMs: number): number {
  return Math.max(0, Math.round((nowMs - receivedAtMs) / 1000));
}
