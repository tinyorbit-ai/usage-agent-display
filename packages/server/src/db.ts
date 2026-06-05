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

  close(): void {
    this.handle.close();
  }
}

// Re-exported so callers never import the union types from two places.
export type { ReportType, TokenCategory };
