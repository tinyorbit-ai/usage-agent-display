/**
 * Logging that can never leak the bearer token. Every log line goes through
 * `redact`, which strips Authorization headers and anything that looks like a
 * `Bearer <token>`. The phase-1 gate asserts the token never appears in output.
 */

const BEARER_RE = /\bBearer\s+[A-Za-z0-9._\-+/=]+/gi;
const AUTH_HEADER_RE = /("?authorization"?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,}]+)/gi;

/** Redact bearer tokens and Authorization header values from an arbitrary string. */
export function redact(message: string): string {
  // Bearer-first: strip the full `Bearer <token>` before the header rule rewrites
  // the "Bearer" keyword out from under it and orphans the token.
  return message
    .replace(BEARER_RE, "Bearer <redacted>")
    .replace(AUTH_HEADER_RE, "$1<redacted>");
}

/** Redact a structured value (deep), returning a log-safe copy. */
export function redactValue(value: unknown): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = /^authorization$/i.test(k) ? "<redacted>" : redactValue(v);
    }
    return out;
  }
  return value;
}

type Sink = (line: string) => void;

/** Default sink writes to stderr; tests inject a capturing sink. */
export function makeLogger(sink: Sink = (line) => process.stderr.write(line + "\n")) {
  return {
    info(message: string, context?: Record<string, unknown>): void {
      const ctx = context ? " " + JSON.stringify(redactValue(context)) : "";
      sink(redact(`[info] ${message}`) + ctx);
    },
    warn(message: string, context?: Record<string, unknown>): void {
      const ctx = context ? " " + JSON.stringify(redactValue(context)) : "";
      sink(redact(`[warn] ${message}`) + ctx);
    },
  };
}

export type Logger = ReturnType<typeof makeLogger>;
