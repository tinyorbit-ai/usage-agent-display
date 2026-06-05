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
         tokens, cost_usd, collected_at, received_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (machine_id, provider, model, token_category, report_type, bucket)
      DO UPDATE SET
        tokens       = excluded.tokens,
        cost_usd     = excluded.cost_usd,
        collected_at = excluded.collected_at,
        received_at  = excluded.received_at
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

  close(): void {
    this.handle.close();
  }
}

// Re-exported so callers never import the union types from two places.
export type { ReportType, TokenCategory };
