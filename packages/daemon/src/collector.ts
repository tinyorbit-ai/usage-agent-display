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

/** A registered provider: a name plus the argv that produces ccusage-shaped JSON. */
export interface ProviderSpec {
  provider: string;
  /** argv prefix; the collector appends `<report> --json`. Defaults to pinned ccusage. */
  command?: string[];
  reports?: readonly ReportType[];
}

const DEFAULT_REPORTS: readonly ReportType[] = ["daily", "session", "monthly"];

/**
 * The provider registry (phase 5): turn a list of {@link ProviderSpec}s into
 * Collectors. Adding a provider that emits ccusage-shaped JSON is a config entry here;
 * a provider with a different shape is a new {@link Collector} implementation behind the
 * same interface — either way the server's aggregation is untouched (provider-agnostic).
 */
export function buildCollectors(specs: ProviderSpec[], exec?: Exec): Collector[] {
  // Reject duplicate provider labels: two collectors with the same provider emit rows
  // that share the dedup key (machine, provider, model, category, report_type, bucket),
  // so they'd collide in `snapshots` — last write wins, silently undercounting. (Codex.)
  const seen = new Set<string>();
  for (const s of specs) {
    if (seen.has(s.provider)) {
      throw new Error(`duplicate provider in registry: "${s.provider}" — provider labels must be unique`);
    }
    seen.add(s.provider);
  }

  return specs.map((s) =>
    ccusageCollector({
      provider: s.provider,
      reports: s.reports ?? DEFAULT_REPORTS,
      ...(s.command ? { command: s.command } : {}),
      ...(exec ? { exec } : {}),
    }),
  );
}
