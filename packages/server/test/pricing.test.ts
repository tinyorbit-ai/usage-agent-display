// Phase 3 gate (automated): model-aware pricing, and the honest unknown-model path —
// tokens for a model absent from the table are surfaced as unpriced_tokens, NOT $0.
import { describe, expect, test } from "bun:test";
import { priceTokens } from "../src/pricing.ts";

describe("priceTokens", () => {
  test("prices a known model per category to the expected dollars", () => {
    // opus: input $15/Mtok, output $75/Mtok, cache_write $18.75, cache_read $1.50.
    const r = priceTokens([
      { model: "claude-opus-4-7", token_category: "input", tokens: 1_000_000 },
      { model: "claude-opus-4-7", token_category: "output", tokens: 1_000_000 },
      { model: "claude-opus-4-7", token_category: "cache_read", tokens: 2_000_000 },
    ]);
    // 15 + 75 + (2 * 1.5) = 93
    expect(r.priced_usd).toBeCloseTo(93, 6);
    expect(r.unpriced_tokens).toBe(0);
  });

  test("matches by substring so version suffixes still price", () => {
    const r = priceTokens([{ model: "claude-sonnet-4-6", token_category: "output", tokens: 1_000_000 }]);
    expect(r.priced_usd).toBeCloseTo(15, 6);
  });

  test("an UNKNOWN model is NOT priced at $0 — its tokens surface as unpriced", () => {
    const r = priceTokens([
      { model: "some-future-model-x", token_category: "output", tokens: 500 },
      { model: "claude-opus-4-7", token_category: "output", tokens: 1_000_000 },
    ]);
    expect(r.priced_usd).toBeCloseTo(75, 6); // only the opus tokens priced
    expect(r.unpriced_tokens).toBe(500); // the unknown model's tokens are surfaced
  });

  test("substring-but-not-canonical models stay UNPRICED (no loose matching)", () => {
    // Codex catch: these contain opus/sonnet/gpt but are not real priced models.
    for (const model of ["opus-compatible-test", "local-sonnet-proxy", "some-future-gpt-model", "gpt-oss-120b", "local-gpt-proxy"]) {
      const r = priceTokens([{ model, token_category: "output", tokens: 100 }]);
      expect(r.priced_usd).toBe(0);
      expect(r.unpriced_tokens).toBe(100);
    }
  });

  test("real ccusage-style names still price", () => {
    for (const [model, expected] of [
      ["claude-opus-4-7", 75],
      ["claude-sonnet-4-6", 15],
      ["claude-haiku-4-5", 4],
      ["gpt-5-codex", 10],
    ] as const) {
      const r = priceTokens([{ model, token_category: "output", tokens: 1_000_000 }]);
      expect(r.priced_usd).toBeCloseTo(expected, 6);
      expect(r.unpriced_tokens).toBe(0);
    }
  });

  test("cache categories are priced distinctly from input/output", () => {
    const cr = priceTokens([{ model: "claude-opus-4-7", token_category: "cache_read", tokens: 1_000_000 }]);
    const out = priceTokens([{ model: "claude-opus-4-7", token_category: "output", tokens: 1_000_000 }]);
    expect(cr.priced_usd).toBeCloseTo(1.5, 6);
    expect(out.priced_usd).toBeCloseTo(75, 6);
    expect(cr.priced_usd).not.toBeCloseTo(out.priced_usd, 2);
  });
});
