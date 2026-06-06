/**
 * Turns ccusage `--json` output into normalized {@link SnapshotRow}s. Defensive by
 * design: ccusage's JSON shape can drift, so malformed entries are skipped (and
 * counted) rather than crashing the collect loop. ADR 0002.
 *
 * Each ccusage model breakdown becomes FOUR rows — one per token category — and the
 * model/bucket cost is replicated across them (the server de-duplicates it per
 * model/bucket when summing). See @usage/shared and ADR 0004.
 *
 * ccusage went MULTI-AGENT (≥ v20): one `daily`/`session`/`monthly` row can mix
 * agents (e.g. a date with both claude and codex), every report type buckets on
 * `period`, and the per-row `provider` is therefore derived from each breakdown's
 * MODEL NAME — not from a single per-row agent label, which the mixed rows lack.
 * Legacy fields (`date`/`sessionId`/`month`, top-level `lastActivity`) stay supported
 * as fallbacks. See wiki note 2026-06-06-ccusage-multi-agent.
 */
import type { ReportType, SnapshotRow, TokenCategory } from "@usage/shared";

/** Legacy bucket key per report type (pre-v20). v20+ uses `period` for all of them. */
const BUCKET_FIELD: Record<ReportType, string> = {
  daily: "date",
  session: "sessionId",
  monthly: "month",
};

/** ccusage field → our token category. */
const CATEGORY_FIELD: Record<TokenCategory, string> = {
  input: "inputTokens",
  output: "outputTokens",
  cache_write: "cacheCreationTokens",
  cache_read: "cacheReadTokens",
};

/**
 * Map a ccusage model name to our provider label. Anchored at the start so a proxy
 * like `local-gpt-proxy` doesn't masquerade as codex (the phase-3 pricing lesson).
 * Unknown models fall back to the daemon's configured provider label.
 */
const MODEL_PROVIDER_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/^claude[-_]?/i, "claude-code"],
  [/^(opus|sonnet|haiku)\b/i, "claude-code"],
  [/^gpt[-_]?/i, "codex"],
  [/codex/i, "codex"],
  [/^gemini[-_]?/i, "gemini"],
];

export function providerForModel(model: string, fallback: string): string {
  for (const [re, provider] of MODEL_PROVIDER_RULES) {
    if (re.test(model)) return provider;
  }
  return fallback;
}

export interface NormalizeResult {
  rows: SnapshotRow[];
  /** number of entries skipped because they were malformed (for honest logging). */
  skipped: number;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function asObject(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/**
 * Build the four category rows for one (model, bucket) breakdown, or return null to
 * SKIP it. We skip — rather than emit zeros — whenever the breakdown looks corrupt or
 * drifted, because a zero row would UPSERT over a real daily total and silently zero
 * the hero. The rules:
 *   - an absent token field → 0 (a legitimately sparse category);
 *   - a token field that is PRESENT but non-numeric or negative → corrupt → skip;
 *   - no token field present-and-numeric at all (e.g. ccusage renamed its fields)
 *     → drift → skip (emit nothing, so the existing good row is left intact).
 */
function rowsForBreakdown(
  provider: string,
  reportType: ReportType,
  bucket: string,
  model: string,
  breakdown: Record<string, unknown>,
  activityAt: number | undefined,
): SnapshotRow[] | null {
  const cost = num(breakdown.cost) ?? num(breakdown.totalCost) ?? 0;
  if (cost < 0) return null;

  const counts: Record<TokenCategory, number> = { input: 0, output: 0, cache_read: 0, cache_write: 0 };
  let sawNumericField = false;
  for (const category of Object.keys(CATEGORY_FIELD) as TokenCategory[]) {
    const value = breakdown[CATEGORY_FIELD[category]];
    if (value === undefined) continue; // sparse category → 0
    const n = num(value);
    if (n === null || n < 0) return null; // present-but-corrupt → skip the whole breakdown
    counts[category] = Math.trunc(n);
    sawNumericField = true;
  }
  if (!sawNumericField) return null; // all fields absent → drift → skip, never overwrite

  return (Object.keys(CATEGORY_FIELD) as TokenCategory[]).map((category) => ({
    provider,
    model,
    token_category: category,
    report_type: reportType,
    bucket,
    tokens: counts[category],
    cost_usd: Math.max(0, cost),
    ...(activityAt !== undefined ? { activity_at: activityAt } : {}),
  }));
}

/**
 * Normalize one ccusage report (already JSON-parsed) into snapshot rows.
 * `report` is the top-level object; `arrayKey` is its list field
 * (`daily`/`sessions`/`monthly`). `provider` is the FALLBACK label — each row's real
 * provider is derived from its model name ({@link providerForModel}), so a single
 * multi-agent ccusage row fans out into claude-code/codex/gemini rows correctly.
 */
export function normalizeReport(
  report: unknown,
  reportType: ReportType,
  arrayKey: string,
  provider: string,
): NormalizeResult {
  const top = asObject(report);
  const list = top ? top[arrayKey] : undefined;
  if (!Array.isArray(list)) return { rows: [], skipped: 0 };

  const rows: SnapshotRow[] = [];
  let skipped = 0;
  const bucketField = BUCKET_FIELD[reportType];

  for (const entry of list) {
    const obj = asObject(entry);
    // v20+ buckets every report type on `period`; older versions used
    // date/sessionId/month. Prefer `period`, fall back to the legacy field.
    const periodVal = obj?.period;
    const bucket =
      typeof periodVal === "string" && periodVal.length > 0 ? periodVal : obj?.[bucketField];
    if (!obj || typeof bucket !== "string" || bucket.length === 0) {
      skipped++;
      continue;
    }

    // Sessions carry a `lastActivity` timestamp so the server can pick the genuinely
    // active session (not just the most-recently-posted one). v20+ nests it under
    // `metadata.lastActivity`; older versions had it top-level.
    let activityAt: number | undefined;
    if (reportType === "session") {
      const meta = asObject(obj.metadata);
      const iso =
        typeof obj.lastActivity === "string"
          ? obj.lastActivity
          : meta && typeof meta.lastActivity === "string"
            ? meta.lastActivity
            : undefined;
      if (iso) {
        const ms = Date.parse(iso);
        if (!Number.isNaN(ms) && ms >= 0) activityAt = ms;
      }
    }

    const breakdowns = obj.modelBreakdowns;
    if (Array.isArray(breakdowns) && breakdowns.length > 0) {
      for (const b of breakdowns) {
        const bd = asObject(b);
        const model = bd && typeof bd.modelName === "string" ? bd.modelName : null;
        if (!bd || !model) {
          skipped++;
          continue;
        }
        const rowProvider = providerForModel(model, provider);
        const built = rowsForBreakdown(rowProvider, reportType, bucket, model, bd, activityAt);
        if (built === null) skipped++;
        else rows.push(...built);
      }
    } else {
      // No per-model breakdown — synthesize one from the entry's top-level totals.
      const models = obj.modelsUsed;
      const model =
        Array.isArray(models) && typeof models[0] === "string" ? models[0] : "unknown";
      const rowProvider = providerForModel(model, provider);
      const built = rowsForBreakdown(rowProvider, reportType, bucket, model, obj, activityAt);
      if (built === null) skipped++;
      else rows.push(...built);
    }
  }

  return { rows, skipped };
}
