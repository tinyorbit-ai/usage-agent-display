/**
 * POSTs a snapshot payload to the central API with the shared bearer token. Network
 * failures are returned, never thrown past the loop — a post that fails is retried
 * next tick, the loop never crashes. The token is sent in the Authorization header
 * and never logged.
 */
import { BEARER_PREFIX, type IngestPayload } from "@usage/shared";

export type PostOutcome =
  | { ok: true; accepted: number }
  | { ok: false; status: number | null; error: string };

export interface Poster {
  post(payload: IngestPayload): Promise<PostOutcome>;
}

export interface PostDeps {
  serverUrl: string;
  token: string;
  fetchFn?: typeof fetch;
}

export function makePoster(deps: PostDeps): Poster {
  const fetchFn = deps.fetchFn ?? fetch;
  const url = `${deps.serverUrl}/ingest`;

  return {
    async post(payload: IngestPayload): Promise<PostOutcome> {
      try {
        const res = await fetchFn(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `${BEARER_PREFIX}${deps.token}`,
          },
          body: JSON.stringify(payload),
        });
        if (!res.ok) {
          return { ok: false, status: res.status, error: `server returned ${res.status}` };
        }
        const body = (await res.json().catch(() => ({}))) as { accepted?: number };
        return { ok: true, accepted: body.accepted ?? payload.rows.length };
      } catch (e) {
        return { ok: false, status: null, error: e instanceof Error ? e.message : String(e) };
      }
    },
  };
}
