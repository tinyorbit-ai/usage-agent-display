/**
 * Model-aware, per-token-category pricing (phase 3, ADR 0009). Prices the granular
 * rows stored since phase 1 with our OWN versioned table rather than trusting
 * ccusage's cost. Crucially, tokens for a model ABSENT from the table are NOT priced
 * at $0 — they are surfaced as `unpriced_tokens` so the panel can show the estimate as
 * partial instead of silently wrong.
 *
 * Rates are USD per MILLION tokens, per category. Matching is ANCHORED to a known
 * vendor prefix plus a family token, NOT a loose substring — otherwise unknown/local
 * models (`local-gpt-proxy`, `opus-compatible-test`, `gpt-oss-120b`) would be
 * confidently mis-priced instead of surfacing as unpriced (Codex phase-3 catch).
 */
import type { TokenCategory } from "@usage/shared";

/** Bump when any rate changes, so a displayed estimate is traceable to a table. */
export const PRICING_VERSION = "2026-06-01";

type Rate = Record<TokenCategory, number>;

// Estimates — a desk-panel instrument, not a billing source of truth (see ADR 0002).
const RATES = {
  opus: { input: 15, output: 75, cache_write: 18.75, cache_read: 1.5 },
  sonnet: { input: 3, output: 15, cache_write: 3.75, cache_read: 0.3 },
  haiku: { input: 0.8, output: 4, cache_write: 1, cache_read: 0.08 },
  openai: { input: 1.25, output: 10, cache_write: 1.25, cache_read: 0.125 },
} satisfies Record<string, Rate>;

/**
 * Resolve a model name to a rate, or null (→ unpriced). Anchored: a Claude model must
 * START with "claude" and name a known family; an OpenAI/Codex model must start with a
 * recognized prefix (`gpt-5`, `gpt-4`, `o1`, `o3`, `codex`). Anything else is unpriced.
 */
function rateFor(model: string): Rate | null {
  const m = model.toLowerCase();
  if (m.startsWith("claude")) {
    if (m.includes("opus")) return RATES.opus;
    if (m.includes("sonnet")) return RATES.sonnet;
    if (m.includes("haiku")) return RATES.haiku;
    return null; // a Claude model whose family we don't recognize → unpriced
  }
  if (/^(gpt-5|gpt-4|o1|o3|codex)/.test(m)) return RATES.openai;
  return null;
}

/** One (model, category) token total to be priced. */
export interface ModelCategoryTokens {
  model: string;
  token_category: TokenCategory;
  tokens: number;
}

export interface PricedResult {
  priced_usd: number;
  unpriced_tokens: number;
}

/** Price a set of (model, category, tokens). Unknown models accrue unpriced_tokens. */
export function priceTokens(rows: ModelCategoryTokens[]): PricedResult {
  let priced = 0;
  let unpriced = 0;
  for (const r of rows) {
    const rate = rateFor(r.model);
    if (rate === null) {
      unpriced += r.tokens;
      continue;
    }
    priced += (r.tokens * rate[r.token_category]) / 1_000_000;
  }
  return { priced_usd: priced, unpriced_tokens: unpriced };
}
