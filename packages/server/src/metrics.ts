/**
 * Hand-rolled Prometheus text exposition (no client dependency, per team
 * preference -- dependency-free). Counters are process-lifetime and reset on
 * restart; that's intentional, not a bug: this is one process behind pm2, not a
 * cluster, so a restart legitimately means "the counters start over."
 * `/metrics` sits behind the same bearer auth as `/ingest` and `/usage/summary`
 * (ADR 0003) -- it is never exempted, because the app is publicly reachable.
 */
import { statSync } from "node:fs";
import type { Db } from "./db.ts";

/** Escape a label value per the exposition format (backslash, quote, newline). */
function escapeLabel(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

export interface MetricsRenderDeps {
  db: Db;
  /** Path passed to `new Db(...)`; `:memory:` (tests) has no file, so size is 0. */
  dbPath: string;
  version: string;
}

/**
 * In-process counters/gauges the app updates as it handles requests, rendered to
 * text on each `/metrics` scrape. DB row counts and file size are queried live at
 * scrape time (cheap, and scrapes are ~15s apart) rather than tracked incrementally.
 */
export class Metrics {
  // path -> status -> count. Nested map, so no joined-key parsing is needed.
  private readonly requestsTotal = new Map<string, Map<number, number>>();
  private ingestTotal = 0;
  private ingestErrorsTotal = 0;
  private lastIngestAtMs: number | null = null;

  /** Record one completed HTTP response. Called once per request, after routing. */
  recordRequest(path: string, status: number): void {
    let byStatus = this.requestsTotal.get(path);
    if (!byStatus) {
      byStatus = new Map();
      this.requestsTotal.set(path, byStatus);
    }
    byStatus.set(status, (byStatus.get(status) ?? 0) + 1);
  }

  /** Record one successfully-accepted /ingest call. */
  recordIngestSuccess(nowMs: number): void {
    this.ingestTotal++;
    this.lastIngestAtMs = nowMs;
  }

  /** Record one rejected /ingest call (bad body, bad JSON, failed validation). */
  recordIngestError(): void {
    this.ingestErrorsTotal++;
  }

  /** File size in bytes, or 0 if the path has no backing file (e.g. `:memory:`). */
  private dbBytes(dbPath: string): number {
    try {
      return statSync(dbPath).size;
    } catch {
      return 0;
    }
  }

  render(deps: MetricsRenderDeps): string {
    const lines: string[] = [];

    lines.push("# HELP usage_build_info Static build metadata.");
    lines.push("# TYPE usage_build_info gauge");
    lines.push(`usage_build_info{version="${escapeLabel(deps.version)}"} 1`);

    lines.push("# HELP usage_http_requests_total Total HTTP responses by path and status code.");
    lines.push("# TYPE usage_http_requests_total counter");
    for (const [path, byStatus] of this.requestsTotal) {
      for (const [status, count] of byStatus) {
        lines.push(`usage_http_requests_total{path="${escapeLabel(path)}",status="${status}"} ${count}`);
      }
    }

    lines.push("# HELP usage_ingest_total Total /ingest requests accepted (2xx).");
    lines.push("# TYPE usage_ingest_total counter");
    lines.push(`usage_ingest_total ${this.ingestTotal}`);

    lines.push("# HELP usage_ingest_errors_total Total /ingest requests rejected (bad body, bad JSON, or failed validation).");
    lines.push("# TYPE usage_ingest_errors_total counter");
    lines.push(`usage_ingest_errors_total ${this.ingestErrorsTotal}`);

    lines.push("# HELP usage_last_ingest_timestamp_seconds Unix time of the last accepted /ingest, in seconds.");
    lines.push("# TYPE usage_last_ingest_timestamp_seconds gauge");
    lines.push(
      `usage_last_ingest_timestamp_seconds ${this.lastIngestAtMs !== null ? (this.lastIngestAtMs / 1000).toFixed(3) : 0}`,
    );

    lines.push("# HELP usage_db_rows Row count per SQLite table.");
    lines.push("# TYPE usage_db_rows gauge");
    lines.push(`usage_db_rows{table="snapshots"} ${deps.db.countSnapshots()}`);
    lines.push(`usage_db_rows{table="total_samples"} ${deps.db.countTotalSamples()}`);

    lines.push("# HELP usage_db_bytes Size in bytes of the SQLite database file.");
    lines.push("# TYPE usage_db_bytes gauge");
    lines.push(`usage_db_bytes ${this.dbBytes(deps.dbPath)}`);

    lines.push("# HELP usage_machines Distinct machines that have ever posted a snapshot.");
    lines.push("# TYPE usage_machines gauge");
    lines.push(`usage_machines ${deps.db.allMachines().length}`);

    return lines.join("\n") + "\n";
  }
}
