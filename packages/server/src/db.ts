/**
 * The ONLY module in the server that contains SQL. Every write goes through a
 * prepared statement defined here with positional `?` parameters — there is no
 * string-built SQL anywhere, and `scripts/check-no-raw-sql.ts` fails the build if
 * that ever changes. See wiki/decisions/0004-ingest-dedup-model.md.
 */
import { Database, type Statement } from "bun:sqlite";
import {
  CANONICAL_REPORT_TYPE,
  type ReportType,
  type SnapshotRow,
  type TokenCategory,
} from "@usage/shared";

/** A row as it lives in the DB: a {@link SnapshotRow} plus its provenance/clock columns. */
export interface StoredSnapshot extends SnapshotRow {
  machine_id: string;
  /** daemon-clock ISO string (untrusted; skew-detection only). */
  collected_at: string;
  /** server-clock epoch ms stamped on arrival; governs conflict resolution. */
  received_at: number;
}

export interface MachineFreshness {
  machine_id: string;
  /** newest received_at (epoch ms) seen for this machine. */
  last_received_at: number;
}

/** A (tokens, cost) rollup grouped by some key column. */
export interface GroupRollup {
  key: string;
  tokens: number;
  cost_usd: number;
}

/** Daily tokens/cost rolled up per machine (freshness is joined in separately). */
export interface MachineDaily {
  machine_id: string;
  tokens: number;
  cost_usd: number;
}

/** The active session (most recently received), with its totals. */
export interface SessionRollup {
  machine_id: string;
  tokens: number;
  cost_usd: number;
}

/** A (model, token_category) token total — the unit our price table prices. */
export interface ModelCategoryTokens {
  model: string;
  token_category: TokenCategory;
  tokens: number;
}

/** A point-in-time sample of a machine's running cumulative daily token total. */
export interface TotalSample {
  /** append-only sequence id — breaks received_at ties deterministically. */
  id: number;
  machine_id: string;
  received_at: number;
  total_tokens: number;
}

/**
 * Owns the SQLite handle and the prepared statements. Construct with `":memory:"`
 * in tests, a file path in production.
 */
export class Db {
  readonly handle: Database;

  // Prepared once at construction. Assigned in the constructor (not as field
  // initializers) because those would run before `this.handle` is set.
  private readonly upsertStmt: Statement;
  private readonly heroTokensStmt: Statement<{ total: number | null }, [ReportType]>;
  private readonly heroCostStmt: Statement<{ total: number | null }, [ReportType]>;
  private readonly freshnessStmt: Statement<MachineFreshness, []>;
  private readonly byProviderStmt: Statement<GroupRollup, []>;
  private readonly byMachineDailyStmt: Statement<MachineDaily, []>;
  private readonly monthStmt: Statement<{ tokens: number; cost_usd: number }, [string]>;
  private readonly sessionStmt: Statement<SessionRollup, []>;
  private readonly tokensByModelCatStmt: Statement<ModelCategoryTokens, [number, string]>;
  private readonly machineDailyTotalStmt: Statement<{ total: number | null }, [string]>;
  private readonly recordSampleStmt: Statement;
  private readonly pruneSamplesStmt: Statement;
  private readonly samplesInWindowStmt: Statement<TotalSample, [number]>;
  private readonly boundarySamplesStmt: Statement<TotalSample, [number]>;
  private readonly pruneSnapshotsStmt: Statement<unknown, [number]>;
  private readonly byProviderSinceStmt: Statement<GroupRollup, [string]>;
  private readonly daysSinceStmt: Statement<{ days: number }, [string]>;
  private readonly dailySeriesStmt: Statement<{ date: string; tokens: number }, [number]>;
  private readonly dailySeriesByProviderStmt: Statement<
    { provider: string; date: string; tokens: number },
    [string]
  >;
  private readonly lastUsedStmt: Statement<{ provider: string; activity: number }, []>;

  constructor(path = ":memory:") {
    this.handle = new Database(path);
    this.handle.exec("PRAGMA journal_mode = WAL;");
    this.handle.exec("PRAGMA foreign_keys = ON;");
    this.migrate();

    // Upsert one row for its dedup key. The most-recently-*received* value wins
    // (server `received_at` governs, never the daemon clock), so re-posts are
    // idempotent and a corrected cumulative total simply overwrites. ADR 0004.
    this.upsertStmt = this.handle.query(`
      INSERT INTO snapshots
        (machine_id, provider, model, token_category, report_type, bucket,
         tokens, cost_usd, collected_at, received_at, activity_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (machine_id, provider, model, token_category, report_type, bucket)
      DO UPDATE SET
        tokens       = excluded.tokens,
        cost_usd     = excluded.cost_usd,
        collected_at = excluded.collected_at,
        received_at  = excluded.received_at,
        activity_at  = excluded.activity_at
        -- received_at GOVERNS: a write whose server received_at is older than what's
        -- stored cannot clobber it (clock rollback / a stray out-of-order writer).
        -- On the normal monotonic path excluded.received_at is always >= stored.
        WHERE excluded.received_at >= snapshots.received_at;
    `);

    // Sum of `tokens` across the deduped canonical (daily) rows — the hero number.
    this.heroTokensStmt = this.handle.query(
      `SELECT CAST(COALESCE(SUM(tokens), 0) AS INTEGER) AS total
         FROM snapshots WHERE report_type = ?;`,
    );

    // Sum of cost across canonical rows, de-duplicated per (machine, provider, model,
    // bucket) — cost is replicated across a model/bucket's category rows, so we take
    // it once per group before summing or it would count four times.
    this.heroCostStmt = this.handle.query(
      `SELECT COALESCE(SUM(cost), 0) AS total FROM (
         SELECT MAX(cost_usd) AS cost
           FROM snapshots WHERE report_type = ?
          GROUP BY machine_id, provider, model, bucket
       );`,
    );

    // Newest received_at per machine, for honest last-sync age.
    this.freshnessStmt = this.handle.query(
      `SELECT machine_id, MAX(received_at) AS last_received_at
         FROM snapshots GROUP BY machine_id
        ORDER BY last_received_at DESC;`,
    );

    // --- v2 hierarchy rollups. Each collapses categories (SUM tokens) and de-dups
    // cost per (machine, provider, model, bucket) via the inner GROUP BY before the
    // outer aggregate — the same "replicate-then-dedup-cost" rule as the hero. ---

    // Daily tokens/cost per provider (Claude Code vs Codex vs …).
    this.byProviderStmt = this.handle.query(
      `SELECT provider AS key,
              CAST(SUM(tokens) AS INTEGER) AS tokens,
              SUM(cost) AS cost_usd
         FROM (
           SELECT provider, SUM(tokens) AS tokens, MAX(cost_usd) AS cost
             FROM snapshots WHERE report_type = 'daily'
            GROUP BY machine_id, provider, model, bucket
         )
        GROUP BY provider
        ORDER BY tokens DESC;`,
    );

    // Daily tokens/cost per machine (freshness is joined in JS from freshnessStmt).
    this.byMachineDailyStmt = this.handle.query(
      `SELECT machine_id,
              CAST(SUM(tokens) AS INTEGER) AS tokens,
              SUM(cost) AS cost_usd
         FROM (
           SELECT machine_id, SUM(tokens) AS tokens, MAX(cost_usd) AS cost
             FROM snapshots WHERE report_type = 'daily'
            GROUP BY machine_id, provider, model, bucket
         )
        GROUP BY machine_id;`,
    );

    // Month-to-date: daily rows whose YYYY-MM prefix matches the reckoning month
    // (computed in the declared timezone, passed in). substr avoids LIKE wildcards.
    // LIMITATION (documented, not a bug): ccusage pre-buckets daily usage by the
    // PRODUCER machine's local calendar date and exposes no intra-day timestamps, so
    // we cannot re-bucket to the server timezone. The declared TZ governs *which month
    // is "current"* (one consistent boundary for all machines); the bucket dates remain
    // producer-local. Near a month boundary a far-TZ machine's date may differ by a day.
    // See wiki/improvements.md.
    this.monthStmt = this.handle.query(
      `SELECT CAST(COALESCE(SUM(tokens), 0) AS INTEGER) AS tokens,
              COALESCE(SUM(cost), 0) AS cost_usd
         FROM (
           SELECT SUM(tokens) AS tokens, MAX(cost_usd) AS cost
             FROM snapshots
            WHERE report_type = 'daily' AND substr(bucket, 1, 7) = ?
            GROUP BY machine_id, provider, model, bucket
         );`,
    );

    // The active session: the (machine, session) with the newest ACTIVITY time
    // (ccusage lastActivity), falling back to received_at as a tiebreaker. activity_at
    // — not received_at — is authoritative: one ingest carrying many sessions stamps
    // them all with the same received_at, so received_at alone can't pick the active
    // one (Codex review catch). NULL activity sorts last under DESC.
    this.sessionStmt = this.handle.query(
      `SELECT machine_id,
              CAST(SUM(tokens) AS INTEGER) AS tokens,
              SUM(cost) AS cost_usd
         FROM (
           SELECT machine_id, bucket,
                  SUM(tokens) AS tokens, MAX(cost_usd) AS cost,
                  MAX(activity_at) AS activity, MAX(received_at) AS last
             FROM snapshots WHERE report_type = 'session'
            GROUP BY machine_id, provider, model, bucket
         )
        GROUP BY machine_id, bucket
        ORDER BY MAX(activity) DESC, MAX(last) DESC
        LIMIT 1;`,
    );

    // Daily tokens summed per (model, token_category) for pricing. The first two params
    // scope by date-bucket prefix: (0, '') is all-time (substr(...,1,0)='' is always
    // true), (7, 'YYYY-MM') is a month, (10, 'YYYY-MM-DD') is one day.
    this.tokensByModelCatStmt = this.handle.query(
      `SELECT model, token_category, CAST(SUM(tokens) AS INTEGER) AS tokens
         FROM snapshots
        WHERE report_type = 'daily' AND substr(bucket, 1, ?) = ?
        GROUP BY model, token_category;`,
    );

    // --- phase 4: token-burn time-series. A machine's all-time DAILY total is
    // monotonic (cumulative), so the delta between two samples is the burn between
    // them. We sample on each ingest and bucket the deltas into the 1h window. ---

    this.machineDailyTotalStmt = this.handle.query(
      `SELECT CAST(COALESCE(SUM(tokens), 0) AS INTEGER) AS total
         FROM snapshots WHERE report_type = 'daily' AND machine_id = ?;`,
    );

    this.recordSampleStmt = this.handle.query(
      `INSERT INTO total_samples (machine_id, received_at, total_tokens) VALUES (?, ?, ?);`,
    );

    this.pruneSamplesStmt = this.handle.query(
      `DELETE FROM total_samples WHERE received_at < ?;`,
    );

    this.samplesInWindowStmt = this.handle.query(
      `SELECT id, machine_id, received_at, total_tokens
         FROM total_samples WHERE received_at >= ?
        ORDER BY machine_id, received_at, id;`,
    );

    // The single latest-recorded sample strictly before the window per machine (by
    // append order = MAX(id)), so the first in-window delta has a correct baseline.
    this.boundarySamplesStmt = this.handle.query(
      `SELECT id, machine_id, received_at, total_tokens FROM total_samples
        WHERE id IN (
          SELECT MAX(id) FROM total_samples WHERE received_at < ? GROUP BY machine_id
        );`,
    );

    // Retention (phase 5, ADR 0011): drop rows not re-posted within the window. The
    // daemon refreshes received_at every tick, so only buckets that have aged out of
    // ccusage's ~30-day local window (and so are never re-sent) are pruned.
    this.pruneSnapshotsStmt = this.handle.query(
      `DELETE FROM snapshots WHERE received_at < ?;`,
    );

    // --- phase 7: timeframe tabs (today / 30d / all) + daily graph + last-used. ---

    // Per-provider daily tokens/cost whose bucket date is >= the given lower bound
    // (lexicographic = chronological for YYYY-MM-DD). `""` includes everything. Same
    // replicate-then-dedup-cost rule as byProvider. Producer-local date TZ caveat applies.
    this.byProviderSinceStmt = this.handle.query(
      `SELECT provider AS key,
              CAST(SUM(tokens) AS INTEGER) AS tokens,
              SUM(cost) AS cost_usd
         FROM (
           SELECT provider, SUM(tokens) AS tokens, MAX(cost_usd) AS cost
             FROM snapshots WHERE report_type = 'daily' AND bucket >= ?
            GROUP BY machine_id, provider, model, bucket
         )
        GROUP BY provider
        ORDER BY tokens DESC;`,
    );

    // Count of distinct daily bucket dates with usage at/after the bound — the
    // denominator for a $/day run-rate.
    this.daysSinceStmt = this.handle.query(
      `SELECT COUNT(DISTINCT bucket) AS days
         FROM snapshots WHERE report_type = 'daily' AND bucket >= ?;`,
    );

    // The most recent N daily buckets with their total tokens (newest first; the
    // caller reverses to oldest→newest for the left-to-right bar graph).
    this.dailySeriesStmt = this.handle.query(
      `SELECT bucket AS date, CAST(SUM(tokens) AS INTEGER) AS tokens
         FROM snapshots WHERE report_type = 'daily'
        GROUP BY bucket
        ORDER BY bucket DESC
        LIMIT ?;`,
    );

    // Per-provider daily tokens, for the same bucket window as dailySeries. Built from
    // the SAME base as dailySeriesStmt — canonical `report_type='daily'`, flat `SUM(tokens)`
    // (tokens are not cost-replicated, so no inner cost-dedup, exactly like dailySeries) —
    // with `provider` added to the GROUP BY in ONE pass (single GROUP BY, never one query
    // per provider). Because both are a flat SUM over the same rows, the split sums back to
    // the combined series bucket-by-bucket BY CONSTRUCTION, not by coincidence. The caller
    // passes `since` = the oldest date of the combined `daily` axis so this returns exactly
    // the rows on that axis (lexicographic compare = chronological for YYYY-MM-DD); `""`
    // would return all-time. Newest-first, reindexed onto the axis in JS (see summary.ts).
    this.dailySeriesByProviderStmt = this.handle.query(
      `SELECT provider, bucket AS date, CAST(SUM(tokens) AS INTEGER) AS tokens
         FROM snapshots WHERE report_type = 'daily' AND bucket >= ?
        GROUP BY provider, bucket;`,
    );

    // The provider with the newest session activity time (date-granular from ccusage).
    this.lastUsedStmt = this.handle.query(
      `SELECT provider, MAX(activity_at) AS activity
         FROM snapshots WHERE report_type = 'session' AND activity_at IS NOT NULL
        GROUP BY provider
        ORDER BY activity DESC
        LIMIT 1;`,
    );
  }

  private migrate(): void {
    // Granular from day one (model + token_category columns) per ADR 0004:
    // phase-3 pricing needs the granularity and ccusage only retains ~30 days,
    // so a later widening would lose history. The PRIMARY KEY *is* the dedup key.
    this.handle.exec(`
      CREATE TABLE IF NOT EXISTS snapshots (
        machine_id     TEXT    NOT NULL,
        provider       TEXT    NOT NULL,
        model          TEXT    NOT NULL,
        token_category TEXT    NOT NULL,
        report_type    TEXT    NOT NULL,
        bucket         TEXT    NOT NULL,
        tokens         INTEGER NOT NULL,
        cost_usd       REAL    NOT NULL,
        collected_at   TEXT    NOT NULL,
        received_at    INTEGER NOT NULL,
        activity_at    INTEGER,
        PRIMARY KEY (machine_id, provider, model, token_category, report_type, bucket)
      ) WITHOUT ROWID;
    `);

    // Append-only samples of each machine's running cumulative daily total, for the
    // phase-4 burn sparkline + active-machine. Pruned to a small retention window.
    // A true autoincrement id means same-millisecond ingests are NOT collapsed (Codex
    // catch) and ties order deterministically by insertion.
    this.handle.exec(`
      CREATE TABLE IF NOT EXISTS total_samples (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        machine_id   TEXT    NOT NULL,
        received_at  INTEGER NOT NULL,
        total_tokens INTEGER NOT NULL
      );
    `);
    this.handle.exec(`CREATE INDEX IF NOT EXISTS idx_samples_received ON total_samples (received_at);`);
    this.handle.exec(`CREATE INDEX IF NOT EXISTS idx_samples_machine ON total_samples (machine_id, received_at, id);`);
  }

  /** Insert/replace many rows atomically; partial application is impossible. */
  upsertMany(rows: StoredSnapshot[]): void {
    const tx = this.handle.transaction((batch: StoredSnapshot[]) => {
      for (const r of batch) {
        this.upsertStmt.run(
          r.machine_id,
          r.provider,
          r.model,
          r.token_category,
          r.report_type,
          r.bucket,
          r.tokens,
          r.cost_usd,
          r.collected_at,
          r.received_at,
          r.activity_at ?? null,
        );
      }
    });
    tx(rows);
  }

  heroTokens(reportType: ReportType = CANONICAL_REPORT_TYPE): number {
    return this.heroTokensStmt.get(reportType)?.total ?? 0;
  }

  heroCost(reportType: ReportType = CANONICAL_REPORT_TYPE): number {
    return this.heroCostStmt.get(reportType)?.total ?? 0;
  }

  /** Most-recently-synced machine, or null if nothing ingested yet. */
  newestMachine(): MachineFreshness | null {
    return this.freshnessStmt.get() ?? null;
  }

  /** Every machine that has ever posted, with its newest received_at. */
  allMachines(): MachineFreshness[] {
    return this.freshnessStmt.all();
  }

  /** Daily tokens/cost per provider, descending by tokens. */
  byProvider(): GroupRollup[] {
    return this.byProviderStmt.all();
  }

  /** Daily tokens/cost per machine (no freshness — join with {@link allMachines}). */
  byMachineDaily(): MachineDaily[] {
    return this.byMachineDailyStmt.all();
  }

  /** Month-to-date tokens/cost for the given `YYYY-MM` reckoning prefix. */
  monthToDate(monthPrefix: string): { tokens: number; cost_usd: number } {
    return this.monthStmt.get(monthPrefix) ?? { tokens: 0, cost_usd: 0 };
  }

  /** The currently-active session's rollup, or null if no session data. */
  activeSession(): SessionRollup | null {
    return this.sessionStmt.get() ?? null;
  }

  /**
   * Per-provider daily tokens/cost over a bucket-date range (phase 7). `since` is an
   * inclusive `YYYY-MM-DD` lower bound; `""` means all-time.
   */
  byProviderSince(since: string): GroupRollup[] {
    return this.byProviderSinceStmt.all(since);
  }

  /** Count of distinct daily bucket dates at/after `since` (`""` = all-time). */
  daysSince(since: string): number {
    return this.daysSinceStmt.get(since)?.days ?? 0;
  }

  /** The most recent `limit` daily buckets, returned oldest→newest. */
  dailySeries(limit: number): { date: string; tokens: number }[] {
    return this.dailySeriesStmt.all(limit).reverse();
  }

  /**
   * Per-provider daily tokens for every `(provider, bucket)` with `bucket >= since`
   * (`""` = all-time), as flat rows. The combined {@link dailySeries} defines the bucket
   * axis; pass its oldest date as `since` so this covers exactly that window, then reindex
   * each provider onto the axis (zero-filling absent buckets) in the summary builder.
   */
  dailySeriesByProvider(since: string): { provider: string; date: string; tokens: number }[] {
    return this.dailySeriesByProviderStmt.all(since);
  }

  /** The provider with the newest session activity time, or null. */
  lastUsed(): { provider: string; activity: number } | null {
    return this.lastUsedStmt.get() ?? null;
  }

  /**
   * Daily tokens per (model, token_category), optionally scoped to a date-bucket
   * prefix: `""` = all-time, `"YYYY-MM"` = a month, `"YYYY-MM-DD"` = one day.
   */
  tokensByModelCategory(bucketPrefix = ""): ModelCategoryTokens[] {
    return this.tokensByModelCatStmt.all(bucketPrefix.length, bucketPrefix);
  }

  /** A machine's all-time cumulative daily token total (monotonic). */
  machineDailyTotal(machineId: string): number {
    return this.machineDailyTotalStmt.get(machineId)?.total ?? 0;
  }

  /** Prune snapshot rows whose newest write predates `cutoffMs`. Returns rows removed. */
  pruneSnapshotsBefore(cutoffMs: number): number {
    return this.pruneSnapshotsStmt.run(cutoffMs).changes;
  }

  /**
   * Record a sample of a machine's running total at `receivedAt`, then prune samples
   * older than `retentionMs` before it. Called once per ingest.
   */
  recordSample(machineId: string, receivedAt: number, total: number, retentionMs = 2 * 3600_000): void {
    this.recordSampleStmt.run(machineId, receivedAt, total);
    this.pruneSamplesStmt.run(receivedAt - retentionMs);
  }

  /**
   * Samples needed to compute burn over `[windowStart, ∞)`: every in-window sample
   * plus, per machine, the latest sample strictly before the window (so the first
   * in-window delta is correct). Returned sorted by machine then time.
   */
  samplesForWindow(windowStart: number): TotalSample[] {
    const boundary = this.boundarySamplesStmt.all(windowStart);
    const inWindow = this.samplesInWindowStmt.all(windowStart);
    const all = [...boundary, ...inWindow];
    all.sort((a, b) =>
      a.machine_id < b.machine_id ? -1
      : a.machine_id > b.machine_id ? 1
      : a.received_at !== b.received_at ? a.received_at - b.received_at
      : a.id - b.id,
    );
    return all;
  }

  close(): void {
    this.handle.close();
  }
}

// Re-exported so callers never import the union types from two places.
export type { ReportType, TokenCategory };
