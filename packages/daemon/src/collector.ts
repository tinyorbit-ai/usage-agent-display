/**
 * The collector seam (ADR 0002/0004). A `Collector` turns a machine's local state
 * into normalized snapshot rows tagged with a provider. ccusage is the first
 * implementation; a future direct-parse or a new provider (Cursor, Gemini) is a new
 * Collector emitting the same row shape — no schema or aggregation change.
 *
 * The ccusage binary is invoked via an ARGV ARRAY (`Bun.spawn([...])`), never a shell
 * string, so no config value is ever a command-injection surface.
 */
import type { ReportType, SnapshotRow } from "@usage/shared";
import { normalizeReport } from "./normalize.ts";

export interface CollectResult {
  rows: SnapshotRow[];
  skipped: number;
}

export interface Collector {
  readonly provider: string;
  collect(): Promise<CollectResult>;
}

/** ccusage subcommand → the array key in its JSON output. */
const REPORT_ARRAY_KEY: Record<ReportType, string> = {
  daily: "daily",
  session: "sessions",
  monthly: "monthly",
};

/** Runs a command (argv array) and returns stdout, or throws on non-zero exit. */
export type Exec = (argv: string[]) => Promise<string>;

/** Default exec: argv-array spawn, no shell. Resolves the pinned ccusage via bunx. */
export const spawnExec: Exec = async (argv) => {
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) {
    throw new Error(`\`${argv[0]}\` exited ${code}: ${stderr.slice(0, 500)}`);
  }
  return stdout;
};

export interface CcusageOptions {
  provider: string;
  reports: readonly ReportType[];
  /** override the binary invocation (tests inject a fake exec). */
  exec?: Exec;
  /** the argv prefix that runs ccusage; defaults to the pinned dep via bunx. */
  command?: string[];
}

/**
 * A {@link Collector} backed by ccusage. For each configured report type it runs
 * `ccusage <type> --json`, parses defensively, and normalizes. A failure or
 * malformed output for one report type is isolated — it does not abort the others.
 */
export function ccusageCollector(opts: CcusageOptions): Collector {
  const exec = opts.exec ?? spawnExec;
  const command = opts.command ?? ["bunx", "ccusage"];

  return {
    provider: opts.provider,
    async collect(): Promise<CollectResult> {
      const rows: SnapshotRow[] = [];
      let skipped = 0;

      for (const report of opts.reports) {
        let parsed: unknown;
        try {
          const stdout = await exec([...command, report, "--json"]);
          parsed = JSON.parse(stdout);
        } catch {
          // One report type failing (binary error, non-JSON) must not sink the rest.
          skipped++;
          continue;
        }
        const result = normalizeReport(parsed, report, REPORT_ARRAY_KEY[report], opts.provider);
        rows.push(...result.rows);
        skipped += result.skipped;
      }

      return { rows, skipped };
    },
  };
}
