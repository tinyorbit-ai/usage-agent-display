/**
 * Builds the v2 {@link UsageSummary} the firmware renders: hero, per-provider and
 * per-machine breakdowns (with honest staleness), the active session, and
 * month-to-date. Time reckoning ("this month") uses ONE declared timezone so machines
 * in different zones roll up consistently. See wiki/architecture.md / ADR 0008.
 */
import type {
  Budget,
  CostInstrument,
  MachineBreakdown,
  ProviderBreakdown,
  TimeframeStat,
  Timeframes,
  UsageSummary,
} from "@usage/shared";
import type { Db } from "./db.ts";
import { PRICING_VERSION, priceTokens } from "./pricing.ts";
import { fractionOfDay, fractionOfMonth, project, reckoningDay } from "./projection.ts";
import { buildLive } from "./live.ts";

export interface SummaryConfig {
  /** a machine with nothing newer than this many seconds is flagged stale. */
  staleAfterSeconds: number;
  /** IANA timezone the server reckons "this month" / "today" in. */
  timezone: string;
  /** optional monthly budget in USD; null disables the budget line. */
  budgetUsd?: number | null;
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

  const lu = db.lastUsed();
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
    cost: buildCostInstrument(db, nowMs, config, month),
    ...buildLive(db, nowMs),
    timeframes: buildTimeframes(db, nowMs, config.timezone),
    daily: db.dailySeries(14),
    last_used:
      lu === null
        ? null
        : { provider: lu.provider, age_seconds: Math.max(0, Math.round((nowMs - lu.activity) / 1000)) },
  };
}

/** Roll up one timeframe (per-provider split + totals + active-day count) from `since`. */
function buildTimeframe(db: Db, since: string): TimeframeStat {
  const byProvider: ProviderBreakdown[] = db.byProviderSince(since).map((r) => ({
    provider: r.key,
    tokens: r.tokens,
    cost_usd: r.cost_usd,
  }));
  return {
    tokens: byProvider.reduce((a, p) => a + p.tokens, 0),
    cost_usd: byProvider.reduce((a, p) => a + p.cost_usd, 0),
    days: db.daysSince(since),
    by_provider: byProvider,
  };
}

/** The three timeframe tabs: today (reckoning day), last 30 days, all-time. */
function buildTimeframes(db: Db, nowMs: number, timezone: string): Timeframes {
  const today = reckoningDay(nowMs, timezone);
  const cutoff30 = reckoningDay(nowMs - 29 * 86_400_000, timezone);
  return {
    today: buildTimeframe(db, today),
    d30: buildTimeframe(db, cutoff30),
    all: buildTimeframe(db, ""),
  };
}

/** Price the stored token rows with our table, project, and apply the budget. */
function buildCostInstrument(
  db: Db,
  nowMs: number,
  config: SummaryConfig,
  month: string,
): CostInstrument {
  // NOTE: today/month/budget select daily rows by date-bucket prefix in the declared
  // timezone, but the buckets themselves are producer-local dates (ccusage has no
  // intra-day timestamps). So projection and budget inherit the same boundary
  // limitation as month-to-date — documented at db.monthStmt and in wiki/improvements.
  const allTime = priceTokens(db.tokensByModelCategory(""));
  const today = reckoningDay(nowMs, config.timezone);
  const todaySpend = priceTokens(db.tokensByModelCategory(today)).priced_usd;
  const monthSpend = priceTokens(db.tokensByModelCategory(month)).priced_usd;

  const budgetLimit = config.budgetUsd ?? null;
  const budget: Budget | null =
    budgetLimit === null || budgetLimit <= 0
      ? null
      : {
          limit_usd: budgetLimit,
          used_pct: (monthSpend / budgetLimit) * 100,
          over_budget: monthSpend > budgetLimit,
        };

  return {
    pricing_version: PRICING_VERSION,
    priced_usd: allTime.priced_usd,
    unpriced_tokens: allTime.unpriced_tokens,
    partial: allTime.unpriced_tokens > 0,
    projection: {
      eod_usd: project(todaySpend, fractionOfDay(nowMs, config.timezone)),
      month_usd: project(monthSpend, fractionOfMonth(nowMs, config.timezone)),
    },
    budget,
  };
}

function ageSeconds(nowMs: number, receivedAtMs: number): number {
  return Math.max(0, Math.round((nowMs - receivedAtMs) / 1000));
}
