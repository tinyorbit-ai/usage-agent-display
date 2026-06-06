// Off-device unit test of the firmware AGENT-FILTER data core (phase 12, ADR 0014): the
// bounded full-panel parse (now in the host core — closing the P7/P10 unbounded-parse
// gap) and the (timeframe × agent) selection logic. Asserts the honesty rules the gate
// requires: a named agent never falls back to the combined total/series, agent ids are
// the PRODUCTION provider strings, the ALL path is byte-identical to the pre-feature
// values, and every untrusted array is clamped (no OOB on the ESP32).
//
// Compiled natively by firmware/test/run-native.ts (clang++, vendored ArduinoJson).
#include "../../src/usage_state.h"

#include <cstdio>
#include <cstring>
#include <string>

using namespace usage;

static int g_failures = 0;
static void check(const char* name, bool cond) {
  if (cond) std::printf("  ok   %s\n", name);
  else { std::printf("  FAIL %s\n", name); g_failures++; }
}
// Cost is a parsed floating value; compare with tolerance (ArduinoJson may store float).
static bool nearly(double a, double b) { double d = a - b; return (d < 0 ? -d : d) < 1e-4; }

// A representative body in the SHAPE production emits: three timeframes each with a
// per-provider split (using the real ids claude-code/codex/gemini), a `daily` series of
// only 3 buckets (proves dailyN is NOT a hardcoded 14), and a daily_by_provider whose
// rows sum to `daily` bucket-by-bucket with gemini SPARSE (0 on the last bucket). `today`
// has only claude-code, so codex/gemini are ABSENT there (the honest-zero case).
static const char* kBody =
    "{\"v\":2,"
    "\"timeframes\":{"
    "\"today\":{\"tokens\":60,\"cost_usd\":0.6,\"days\":1,"
    "\"by_provider\":[{\"provider\":\"claude-code\",\"tokens\":60,\"cost_usd\":0.6}]},"
    "\"d30\":{\"tokens\":440,\"cost_usd\":4.4,\"days\":3,"
    "\"by_provider\":[{\"provider\":\"claude-code\",\"tokens\":260,\"cost_usd\":2.6},"
    "{\"provider\":\"codex\",\"tokens\":150,\"cost_usd\":1.5},"
    "{\"provider\":\"gemini\",\"tokens\":30,\"cost_usd\":0.3}]},"
    "\"all\":{\"tokens\":440,\"cost_usd\":4.4,\"days\":3,"
    "\"by_provider\":[{\"provider\":\"claude-code\",\"tokens\":260,\"cost_usd\":2.6},"
    "{\"provider\":\"codex\",\"tokens\":150,\"cost_usd\":1.5},"
    "{\"provider\":\"gemini\",\"tokens\":30,\"cost_usd\":0.3}]}},"
    "\"daily\":[{\"date\":\"2026-06-01\",\"tokens\":100},"
    "{\"date\":\"2026-06-02\",\"tokens\":250},"
    "{\"date\":\"2026-06-03\",\"tokens\":90}],"
    "\"daily_by_provider\":{"
    "\"claude-code\":[60,150,50],"
    "\"codex\":[30,80,40],"
    "\"gemini\":[10,20,0]},"
    "\"month\":{\"tokens\":440,\"cost_usd\":4.4},"
    "\"last_used\":{\"provider\":\"claude-code\",\"age_seconds\":42},"
    "\"last_sync\":{\"machine\":\"mbp\",\"age_seconds\":3},"
    "\"active_machine\":\"mbp\"}";

int main() {
  std::printf("firmware agent-filter — parse + selection:\n");

  PanelData d;
  check("representative body parses", parsePanel(kBody, std::strlen(kBody), d) && d.valid);

  // dailyN reflects the ACTUAL bucket count (3), not a hardcoded 14.
  check("dailyN == 3 (not a fixed 14)", d.dailyN == 3);
  check("combined daily is [100,250,90] exactly",
        d.daily[0] == 100 && d.daily[1] == 250 && d.daily[2] == 90);

  // --- ALL-path regression lock: selections equal the pre-feature values exactly ---
  check("selectHero(ALL, all) == timeframe total (440)", selectHero(d, 2, AGENT_ALL) == 440);
  check("selectHero(ALL, today) == today total (60)", selectHero(d, 0, AGENT_ALL) == 60);
  check("selectCost(ALL, d30) == timeframe cost (4.4)", nearly(selectCost(d, 1, AGENT_ALL), 4.4));
  {
    long long s[kMaxDailyPoints];
    const int n = selectSeries(d, AGENT_ALL, s, kMaxDailyPoints);
    check("selectSeries(ALL) == combined daily exactly",
          n == 3 && s[0] == 100 && s[1] == 250 && s[2] == 90);
  }

  // --- agent ids are the PRODUCTION provider strings (claude-code, not claude) ---
  check("CLAUDE chip uses id claude-code", std::strcmp(agentProviderId(0), "claude-code") == 0);
  check("CODEX chip uses id codex", std::strcmp(agentProviderId(1), "codex") == 0);
  check("GEMINI chip uses id gemini", std::strcmp(agentProviderId(2), "gemini") == 0);
  // …and each resolves to a non-zero value where that provider has usage.
  check("selectHero(CLAUDE, d30) resolves non-zero (260)", selectHero(d, 1, AGENT_CLAUDE) == 260);
  check("selectHero(CODEX, d30) resolves non-zero (150)", selectHero(d, 1, AGENT_CODEX) == 150);
  check("selectCost(GEMINI, d30) resolves non-zero (0.3)", nearly(selectCost(d, 1, AGENT_GEMINI), 0.3));

  // --- honest, never confidently wrong: a named agent ABSENT from a timeframe → 0,
  // NOT the combined total ---
  check("selectHero(CODEX, today) == 0 (absent, not combined 60)", selectHero(d, 0, AGENT_CODEX) == 0);
  check("selectHero(GEMINI, today) == 0 (absent)", selectHero(d, 0, AGENT_GEMINI) == 0);
  check("selectCost(CODEX, today) == 0 (absent)", selectCost(d, 0, AGENT_CODEX) == 0.0);

  // --- selectSeries(named): per-provider row exactly; sparse → real 0; never combined ---
  {
    long long s[kMaxDailyPoints];
    int n = selectSeries(d, AGENT_CLAUDE, s, kMaxDailyPoints);
    check("selectSeries(CLAUDE) == [60,150,50] exactly", n == 3 && s[0] == 60 && s[1] == 150 && s[2] == 50);
    n = selectSeries(d, AGENT_GEMINI, s, kMaxDailyPoints);
    check("selectSeries(GEMINI) is sparse [10,20,0] (real 0, not combined)",
          n == 3 && s[0] == 10 && s[1] == 20 && s[2] == 0);
  }

  // --- consistency made load-bearing: Σ over agents == combined daily, bucket-by-bucket ---
  {
    long long c[kMaxDailyPoints], cx[kMaxDailyPoints], gm[kMaxDailyPoints];
    const int n = selectSeries(d, AGENT_CLAUDE, c, kMaxDailyPoints);
    selectSeries(d, AGENT_CODEX, cx, kMaxDailyPoints);
    selectSeries(d, AGENT_GEMINI, gm, kMaxDailyPoints);
    bool consistent = true;
    for (int i = 0; i < n; i++)
      if (c[i] + cx[i] + gm[i] != d.daily[i]) consistent = false;
    check("Σ provider series == combined daily (every bucket)", consistent);
  }

  // --- peak (for the per-agent label) ---
  {
    long long s[kMaxDailyPoints];
    const int n = selectSeries(d, AGENT_CLAUDE, s, kMaxDailyPoints);
    check("seriesPeak(CLAUDE) == 150", seriesPeak(s, n) == 150);
  }

  // --- a body whose provider id is the WRONG token ("claude", not "claude-code") makes
  // the CLAUDE chip read 0 — proving the chip binds to the production id, not a guess ---
  {
    const char* wrong =
        "{\"timeframes\":{\"today\":{\"tokens\":9,\"cost_usd\":0,\"days\":1,\"by_provider\":[]},"
        "\"d30\":{\"tokens\":9,\"cost_usd\":0,\"days\":1,"
        "\"by_provider\":[{\"provider\":\"claude\",\"tokens\":9,\"cost_usd\":0.1}]},"
        "\"all\":{\"tokens\":9,\"cost_usd\":0,\"days\":1,\"by_provider\":[]}},"
        "\"daily\":[{\"date\":\"d\",\"tokens\":9}],\"month\":{\"tokens\":9}}";
    PanelData w;
    check("wrong-id body parses", parsePanel(wrong, std::strlen(wrong), w));
    check("CLAUDE chip reads 0 when payload used 'claude' not 'claude-code'",
          selectHero(w, 1, AGENT_CLAUDE) == 0);
  }

  std::printf("\nbounded parse of untrusted arrays:\n");

  // Over-length per-provider array → clamped to the combined axis (dailyN), no OOB.
  {
    const char* over =
        "{\"timeframes\":{\"today\":{\"tokens\":1,\"cost_usd\":0,\"days\":1,\"by_provider\":[]},"
        "\"d30\":{\"tokens\":1,\"cost_usd\":0,\"days\":1,\"by_provider\":[]},"
        "\"all\":{\"tokens\":1,\"cost_usd\":0,\"days\":1,\"by_provider\":[]}},"
        "\"daily\":[{\"date\":\"a\",\"tokens\":5},{\"date\":\"b\",\"tokens\":7}],"
        "\"daily_by_provider\":{\"claude-code\":[5,7,999,999,999,999,999,999,999,999,999,999,999,999,999,999,999,999,999]},"
        "\"month\":{\"tokens\":12}}";
    PanelData o;
    check("over-length array body parses", parsePanel(over, std::strlen(over), o));
    long long s[kMaxDailyPoints];
    const int n = selectSeries(o, AGENT_CLAUDE, s, kMaxDailyPoints);
    check("over-length per-provider array clamped to dailyN (2), no overflow",
          n == 2 && s[0] == 5 && s[1] == 7);
  }

  // Short per-provider array → zero-padded to the combined axis (not a short/garbage read).
  {
    const char* shortArr =
        "{\"timeframes\":{\"today\":{\"tokens\":1,\"cost_usd\":0,\"days\":1,\"by_provider\":[]},"
        "\"d30\":{\"tokens\":1,\"cost_usd\":0,\"days\":1,\"by_provider\":[]},"
        "\"all\":{\"tokens\":1,\"cost_usd\":0,\"days\":1,\"by_provider\":[]}},"
        "\"daily\":[{\"date\":\"a\",\"tokens\":5},{\"date\":\"b\",\"tokens\":7},{\"date\":\"c\",\"tokens\":9}],"
        "\"daily_by_provider\":{\"codex\":[5]},"
        "\"month\":{\"tokens\":21}}";
    PanelData sp;
    check("short-array body parses", parsePanel(shortArr, std::strlen(shortArr), sp));
    long long s[kMaxDailyPoints];
    const int n = selectSeries(sp, AGENT_CODEX, s, kMaxDailyPoints);
    check("short per-provider array zero-padded to dailyN (3)",
          n == 3 && s[0] == 5 && s[1] == 0 && s[2] == 0);
  }

  // Missing daily_by_provider entirely → every named agent yields a same-length zero
  // series, never a fallback to combined.
  {
    const char* noDbp =
        "{\"timeframes\":{\"today\":{\"tokens\":1,\"cost_usd\":0,\"days\":1,\"by_provider\":[]},"
        "\"d30\":{\"tokens\":1,\"cost_usd\":0,\"days\":1,\"by_provider\":[]},"
        "\"all\":{\"tokens\":1,\"cost_usd\":0,\"days\":1,\"by_provider\":[]}},"
        "\"daily\":[{\"date\":\"a\",\"tokens\":5},{\"date\":\"b\",\"tokens\":7}],"
        "\"month\":{\"tokens\":12}}";
    PanelData nd;
    check("body without daily_by_provider parses", parsePanel(noDbp, std::strlen(noDbp), nd));
    long long s[kMaxDailyPoints];
    const int n = selectSeries(nd, AGENT_GEMINI, s, kMaxDailyPoints);
    check("missing daily_by_provider → zeros of dailyN length (never combined)",
          n == 2 && s[0] == 0 && s[1] == 0);
  }

  // Oversize body → rejected (DoS guard now enforced on the live path).
  {
    std::string huge = "{\"timeframes\":{},\"pad\":\"";
    huge.append(kMaxBodyBytes + 64, 'x');
    huge.append("\"}");
    PanelData hd;
    check("oversize body rejected (kMaxBodyBytes enforced)", !parsePanel(huge.c_str(), huge.size(), hd));
  }

  // Missing timeframes → rejected (caller keeps last-good).
  {
    PanelData md;
    check("body without timeframes → parse fails (keep last-good)",
          !parsePanel("{\"daily\":[]}", std::strlen("{\"daily\":[]}"), md));
  }

  std::printf("\n%s (%d failure%s)\n", g_failures == 0 ? "PASS" : "FAIL", g_failures,
              g_failures == 1 ? "" : "s");
  return g_failures == 0 ? 0 : 1;
}
