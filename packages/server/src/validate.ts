/**
 * Strict, dependency-free validation of an /ingest body. The rule is REJECT, never
 * clamp: any out-of-range, malformed, or unknown field fails the whole payload with
 * 400 and nothing is written. Unknown fields are rejected too, so a typo'd or
 * malicious extra key can't slip through. ADR 0004 / phase-1 input-validation gate.
 */
import {
  LIMITS,
  REPORT_TYPES,
  TOKEN_CATEGORIES,
  type IngestPayload,
  type SnapshotRow,
} from "@usage/shared";

export type ValidationResult =
  | { ok: true; value: IngestPayload }
  | { ok: false; error: string };

/** Field-level outcome: a value or a message. Keeps the union types honest. */
type Field<T> = { v: T } | { e: string };
const ok = <T>(v: T): Field<T> => ({ v });
const err = (e: string): Field<never> => ({ e });

const ROW_KEYS = new Set([
  "provider",
  "model",
  "token_category",
  "report_type",
  "bucket",
  "tokens",
  "cost_usd",
  "activity_at",
]);
const PAYLOAD_KEYS = new Set(["machine_id", "collected_at", "rows"]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function boundedString(v: unknown, field: string): Field<string> {
  if (typeof v !== "string") return err(`${field} must be a string`);
  if (v.length === 0) return err(`${field} must not be empty`);
  if (v.length > LIMITS.STRING_MAX) return err(`${field} exceeds ${LIMITS.STRING_MAX} chars`);
  return ok(v);
}

function nonNegInt(v: unknown, field: string, max: number): Field<number> {
  if (typeof v !== "number" || !Number.isInteger(v)) return err(`${field} must be an integer`);
  if (v < 0) return err(`${field} must be non-negative`);
  if (v > max) return err(`${field} exceeds bound ${max}`);
  return ok(v);
}

function nonNegFinite(v: unknown, field: string, max: number): Field<number> {
  if (typeof v !== "number" || !Number.isFinite(v)) return err(`${field} must be a finite number`);
  if (v < 0) return err(`${field} must be non-negative`);
  if (v > max) return err(`${field} exceeds bound ${max}`);
  return ok(v);
}

function extraKey(obj: Record<string, unknown>, allowed: Set<string>, where: string): string | null {
  for (const k of Object.keys(obj)) {
    if (!allowed.has(k)) return `${where}: unknown field "${k}"`;
  }
  return null;
}

function inSet<T extends string>(v: unknown, set: readonly T[], field: string): Field<T> {
  if (typeof v !== "string" || !set.includes(v as T)) {
    return err(`${field} must be one of ${set.join(", ")}`);
  }
  return ok(v as T);
}

function validateRow(raw: unknown, idx: number): Field<SnapshotRow> {
  if (!isPlainObject(raw)) return err(`rows[${idx}] must be an object`);
  const extra = extraKey(raw, ROW_KEYS, `rows[${idx}]`);
  if (extra) return err(extra);

  const provider = boundedString(raw.provider, `rows[${idx}].provider`);
  if ("e" in provider) return provider;
  const model = boundedString(raw.model, `rows[${idx}].model`);
  if ("e" in model) return model;
  const bucket = boundedString(raw.bucket, `rows[${idx}].bucket`);
  if ("e" in bucket) return bucket;
  const category = inSet(raw.token_category, TOKEN_CATEGORIES, `rows[${idx}].token_category`);
  if ("e" in category) return category;
  const reportType = inSet(raw.report_type, REPORT_TYPES, `rows[${idx}].report_type`);
  if ("e" in reportType) return reportType;
  const tokens = nonNegInt(raw.tokens, `rows[${idx}].tokens`, LIMITS.TOKENS_MAX);
  if ("e" in tokens) return tokens;
  const cost = nonNegFinite(raw.cost_usd, `rows[${idx}].cost_usd`, LIMITS.COST_MAX);
  if ("e" in cost) return cost;

  // activity_at is optional; when present it must be a non-negative finite epoch ms.
  let activityAt: number | undefined;
  if (raw.activity_at !== undefined) {
    const a = nonNegFinite(raw.activity_at, `rows[${idx}].activity_at`, Number.MAX_SAFE_INTEGER);
    if ("e" in a) return a;
    activityAt = a.v;
  }

  return ok({
    provider: provider.v,
    model: model.v,
    token_category: category.v,
    report_type: reportType.v,
    bucket: bucket.v,
    tokens: tokens.v,
    cost_usd: cost.v,
    ...(activityAt !== undefined ? { activity_at: activityAt } : {}),
  });
}

/**
 * Validate a parsed JSON body. On success returns the typed payload; on any failure
 * returns a single human-readable error (the caller turns it into a 400). Also
 * rejects a `collected_at` implausibly far in the future, given `nowMs`.
 */
export function validateIngest(body: unknown, nowMs: number): ValidationResult {
  if (!isPlainObject(body)) return { ok: false, error: "body must be an object" };
  const extra = extraKey(body, PAYLOAD_KEYS, "body");
  if (extra) return { ok: false, error: extra };

  const machineId = boundedString(body.machine_id, "machine_id");
  if ("e" in machineId) return { ok: false, error: machineId.e };

  if (typeof body.collected_at !== "string") {
    return { ok: false, error: "collected_at must be a string" };
  }
  const collectedMs = Date.parse(body.collected_at);
  if (Number.isNaN(collectedMs)) return { ok: false, error: "collected_at must be ISO-8601" };
  if (collectedMs > nowMs + LIMITS.FUTURE_SKEW_MS) {
    return { ok: false, error: "collected_at is implausibly in the future" };
  }

  if (!Array.isArray(body.rows)) return { ok: false, error: "rows must be an array" };
  if (body.rows.length === 0) return { ok: false, error: "rows must not be empty" };
  if (body.rows.length > LIMITS.ROWS_MAX) {
    return { ok: false, error: `rows exceeds ${LIMITS.ROWS_MAX}` };
  }

  const rows: SnapshotRow[] = [];
  for (let i = 0; i < body.rows.length; i++) {
    const r = validateRow(body.rows[i], i);
    if ("e" in r) return { ok: false, error: r.e };
    rows.push(r.v);
  }

  return {
    ok: true,
    value: { machine_id: machineId.v, collected_at: body.collected_at, rows },
  };
}
