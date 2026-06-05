/**
 * Shared-bearer auth (ADR 0003). One secret protects BOTH endpoints — `/ingest`
 * (write) and `/usage/summary` (read): the firmware sends the token on its poll, so
 * a stray client on the network can neither corrupt the store nor read usage.
 * Resolved at the lock gate: read path IS authenticated.
 */
import { AUTH_HEADER, BEARER_PREFIX } from "@usage/shared";

/** Length-independent constant-time string compare — no early-out timing leak. */
export function timingSafeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  // Compare against a fixed-length scratch so length itself doesn't branch early.
  const len = Math.max(ba.length, bb.length);
  let diff = ba.length ^ bb.length;
  for (let i = 0; i < len; i++) {
    diff |= (ba[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}

/** Extract the token from an `Authorization: Bearer <token>` header, or null. */
export function extractBearer(header: string | null): string | null {
  if (!header) return null;
  if (!header.startsWith(BEARER_PREFIX)) return null;
  const token = header.slice(BEARER_PREFIX.length).trim();
  return token.length > 0 ? token : null;
}

/** True iff the request carries the correct bearer token. */
export function isAuthorized(req: Request, expected: string): boolean {
  const presented = extractBearer(req.headers.get(AUTH_HEADER));
  if (presented === null) return false;
  return timingSafeEqual(presented, expected);
}
