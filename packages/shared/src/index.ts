/**
 * @usage/shared — the wire contract between daemon, server, and firmware.
 *
 * This is the stable interface the whole system agrees on. The firmware depends
 * on the shape of {@link UsageSummary}; the daemon produces {@link IngestPayload}.
 * Versioned: `UsageSummary.v` starts at 1 (phase 1, hero token total only) and
 * grows additively in later phases (by_provider, by_machine, projection, …) so
 * older firmware keeps working. See wiki/architecture.md.
 */

/** Token categories ccusage breaks usage into. Closed set — these are physical. */
export const TOKEN_CATEGORIES = ["input", "output", "cache_read", "cache_write"] as const;
export type TokenCategory = (typeof TOKEN_CATEGORIES)[number];

/**
 * ccusage report grouping. The hero total is computed from `daily` ONLY — session
 * and monthly are stored for their own views but never summed into the hero, or
 * the same tokens count 2–3×. See wiki/decisions/0004-ingest-dedup-model.md.
 */
export const REPORT_TYPES = ["daily", "session", "monthly"] as const;
export type ReportType = (typeof REPORT_TYPES)[number];

/** The one canonical report type that feeds the hero total. */
export const CANONICAL_REPORT_TYPE: ReportType = "daily";

/**
 * One normalized usage measurement. The dedup key is
 * (machine_id, provider, model, token_category, report_type, bucket) — see
 * {@link snapshotDedupKey}. `provider` and `model` are OPEN strings (adding
 * Cursor/Gemini is a new collector emitting this same shape, not a schema change).
 *
 * `cost_usd` is the cost of the whole (model, bucket) and is replicated identically
 * across that model/bucket's category rows; the server de-duplicates it per
 * model/bucket when summing so it is never counted four times.
 */
export interface SnapshotRow {
  provider: string;
  model: string;
  token_category: TokenCategory;
  report_type: ReportType;
  /** date `YYYY-MM-DD` for daily/monthly, session id for session. */
  bucket: string;
  /** non-negative integer count for this category. */
  tokens: number;
  /** non-negative cost for the whole (model, bucket); replicated across categories. */
  cost_usd: number;
  /**
   * Session activity time as epoch ms (from ccusage `lastActivity`), for SESSION rows
   * only — it identifies which session is *currently active* across machines, since a
   * single ingest stamps every row with the same `received_at` and can't break the tie.
   * Omitted for daily/monthly rows.
   */
  activity_at?: number;
}

/** What a daemon POSTs to `/ingest`. `collected_at` is the daemon clock (untrusted). */
export interface IngestPayload {
  machine_id: string;
  /** ISO-8601 daemon-clock timestamp. Used only for skew detection, never for ordering. */
  collected_at: string;
  rows: SnapshotRow[];
}

/** Per-machine freshness, reported honestly so the panel never claims fresher-than-true. */
export interface LastSync {
  machine: string;
  age_seconds: number;
}

/** The hero block. `tokens` is THE number; `cost_usd` rides along (instrument in phase 3). */
export interface Totals {
  tokens: number;
  cost_usd: number;
}

/** A provider's slice of the combined total (Claude Code vs Codex vs …). */
export interface ProviderBreakdown {
  provider: string;
  tokens: number;
  cost_usd: number;
}

/**
 * A machine's slice, plus its own freshness. `stale` is true when nothing newer than
 * the server's configured freshness threshold has arrived — the panel shows it dimmed
 * with an explicit age so it never claims fresher-than-true.
 */
export interface MachineBreakdown {
  machine: string;
  tokens: number;
  cost_usd: number;
  age_seconds: number;
  stale: boolean;
}

/** The currently-active session's burn (most recently updated session), or null. */
export interface SessionBurn {
  machine: string;
  tokens: number;
  cost_usd: number;
}

/** Month-to-date, reckoned in the server's declared timezone. */
export interface MonthToDate {
  /** the reckoning month, `YYYY-MM` in the declared timezone. */
  month: string;
  tokens: number;
  cost_usd: number;
}

/** Linear-extrapolation projection of spend (phase 3). */
export interface Projection {
  /** projected spend by end of *today*, at today's pace. */
  eod_usd: number;
  /** projected spend by end of *this month*, at the month's pace. */
  month_usd: number;
}

/** Optional budget line with burndown (phase 3). */
export interface Budget {
  limit_usd: number;
  /** month-to-date priced spend as a percentage of the limit. */
  used_pct: number;
  over_budget: boolean;
}

/**
 * Cost as an instrument (phase 3): spend priced from our own per-model, per-category
 * table over the granular stored rows — NOT trusting ccusage's number — plus honest
 * handling of models we don't price and forward projection. Tokens stay the hero;
 * this is the second instrument. See ADR 0009.
 */
export interface CostInstrument {
  /** version of the price table used, so a stale estimate is identifiable. */
  pricing_version: string;
  /** all-time priced spend over models present in the table. */
  priced_usd: number;
  /** tokens belonging to models ABSENT from the table — surfaced, never priced at $0. */
  unpriced_tokens: number;
  /** true when unpriced_tokens > 0, so the panel can show the estimate as partial. */
  partial: boolean;
  projection: Projection;
  /** null when no budget is configured. */
  budget: Budget | null;
}

/**
 * The compact `GET /usage/summary` payload the firmware renders. v2 adds the
 * hierarchy breakdowns (provider, machine, session, month) on top of v1's hero.
 * Older (v1) firmware keeps working — it only reads `totals`. Fields are additive.
 * `last_sync` / `session` are null when there is nothing to report.
 */
export interface UsageSummary {
  v: 2;
  generated_at: string;
  last_sync: LastSync | null;
  totals: Totals;
  by_provider: ProviderBreakdown[];
  by_machine: MachineBreakdown[];
  session: SessionBurn | null;
  month: MonthToDate;
  /** phase 3 — cost instrument: priced spend, projection, budget. */
  cost: CostInstrument;
}

/** Bounds shared by validation on both ends. Generous but finite — DoS ceilings. */
export const LIMITS = {
  /** max length for open-string identifiers (machine_id, provider, model, bucket). */
  STRING_MAX: 256,
  /** a single category count can't plausibly exceed this (≈ 1 quadrillion). */
  TOKENS_MAX: 1e15,
  /** a single (model, bucket) cost can't plausibly exceed this. */
  COST_MAX: 1e9,
  /** reject snapshots whose collected_at is further than this into the future (ms). */
  FUTURE_SKEW_MS: 5 * 60 * 1000,
  /** max rows in one ingest payload (sanity ceiling; real machines send hundreds). */
  ROWS_MAX: 50_000,
  /** max /ingest request body size in bytes (sanity ceiling against a giant body). */
  BODY_BYTES_MAX: 16 * 1024 * 1024,
} as const;

/**
 * The canonical dedup key for a row, given its owning machine. Mirrors the server's
 * SQLite PRIMARY KEY (machine_id, provider, model, token_category, report_type,
 * bucket). Built with JSON.stringify of the fixed-order tuple so it is collision-safe
 * even when an open-string field (provider/model/bucket) contains a separator
 * character — a plain delimiter join would not be.
 */
export function snapshotDedupKey(machineId: string, row: SnapshotRow): string {
  return JSON.stringify([
    machineId,
    row.provider,
    row.model,
    row.token_category,
    row.report_type,
    row.bucket,
  ]);
}

/** The HTTP header the daemon and firmware send the shared bearer token in. */
export const AUTH_HEADER = "authorization";
export const BEARER_PREFIX = "Bearer ";
