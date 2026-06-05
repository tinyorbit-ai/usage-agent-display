// Off-device unit test of the firmware fetch/parse/state core against the full state
// matrix the phase-1 gate requires: HTTP 200 / 401 / 500 / timeout / disconnect /
// truncated / oversized / missing totals.tokens. Each must yield the correct state
// (Live / Placeholder / Connecting), retain last-good, and never crash.
//
// Compiled natively by firmware/test/run-native.ts (clang++, vendored ArduinoJson).
#include "../../src/usage_state.h"

#include <cstdio>
#include <cstring>
#include <string>

using namespace usage;

static int g_failures = 0;

static const char* kindName(DisplayKind k) {
  switch (k) {
    case DisplayKind::Connecting: return "Connecting";
    case DisplayKind::Live: return "Live";
    case DisplayKind::Placeholder: return "Placeholder";
  }
  return "?";
}

static void check(const char* name, bool cond) {
  if (cond) {
    std::printf("  ok   %s\n", name);
  } else {
    std::printf("  FAIL %s\n", name);
    g_failures++;
  }
}

static FetchResult ok200(const char* body) {
  return FetchResult{FetchKind::Ok, 200, body, std::strlen(body)};
}

int main() {
  const char* good = "{\"v\":1,\"generated_at\":\"2026-06-05T12:00:00Z\","
                     "\"last_sync\":{\"machine\":\"mbp-14\",\"age_seconds\":3},"
                     "\"totals\":{\"tokens\":14200000,\"cost_usd\":12.4}}";

  std::printf("firmware usage_state matrix:\n");

  // Boot: no data yet → Connecting.
  DisplayState s;
  check("boot state is Connecting with no value", s.kind == DisplayKind::Connecting && !s.hasValue);

  // 200 + valid body → Live with the parsed token total.
  s = applyFetchResult(s, ok200(good));
  check("HTTP 200 valid → Live", s.kind == DisplayKind::Live);
  check("HTTP 200 parses totals.tokens", s.tokens == 14200000 && s.hasValue);

  // Live update A→B: a second good poll moves the number (the poll loop refreshes).
  const char* goodB = "{\"totals\":{\"tokens\":14200500,\"cost_usd\":12.4}}";
  s = applyFetchResult(s, ok200(goodB));
  check("HTTP 200 second value → number updates A→B", s.kind == DisplayKind::Live && s.tokens == 14200500);

  // 401 after having a value → Placeholder, last-good retained.
  DisplayState after401 = applyFetchResult(s, FetchResult{FetchKind::HttpError, 401, nullptr, 0});
  check("HTTP 401 → Placeholder", after401.kind == DisplayKind::Placeholder);
  check("HTTP 401 retains last-good tokens", after401.tokens == 14200500 && after401.hasValue);

  // 500 → Placeholder, last-good retained.
  DisplayState after500 = applyFetchResult(s, FetchResult{FetchKind::HttpError, 500, nullptr, 0});
  check("HTTP 500 → Placeholder, last-good retained", after500.kind == DisplayKind::Placeholder && after500.tokens == 14200500);

  // Timeout / disconnect (no response) → Placeholder, last-good retained.
  DisplayState afterTimeout = applyFetchResult(s, FetchResult{FetchKind::NetworkError, 0, nullptr, 0});
  check("timeout → Placeholder, last-good retained", afterTimeout.kind == DisplayKind::Placeholder && afterTimeout.tokens == 14200500);

  // Truncated JSON → Placeholder (parse fails), last-good retained.
  const char* truncated = "{\"totals\":{\"tokens\":142";
  DisplayState afterTrunc = applyFetchResult(s, ok200(truncated));
  check("truncated body → Placeholder, last-good retained", afterTrunc.kind == DisplayKind::Placeholder && afterTrunc.tokens == 14200500);

  // Missing totals.tokens → Placeholder, last-good retained.
  const char* missing = "{\"v\":1,\"totals\":{\"cost_usd\":1.0}}";
  DisplayState afterMissing = applyFetchResult(s, ok200(missing));
  check("missing totals.tokens → Placeholder, last-good retained", afterMissing.kind == DisplayKind::Placeholder && afterMissing.tokens == 14200500);

  // Oversized body → treated as a fault, not parsed.
  std::string huge = "{\"totals\":{\"tokens\":1,\"pad\":\"";
  huge.append(kMaxBodyBytes + 64, 'x');
  huge.append("\"}}");
  DisplayState afterHuge = applyFetchResult(s, ok200(huge.c_str()));
  check("oversized body → Placeholder (not parsed)", afterHuge.kind == DisplayKind::Placeholder && afterHuge.tokens == 14200500);

  // Failure BEFORE ever having a value stays Connecting (no garbage zero shown as Live).
  DisplayState fresh;
  DisplayState freshTimeout = applyFetchResult(fresh, FetchResult{FetchKind::NetworkError, 0, nullptr, 0});
  check("failure with no prior value → stays Connecting", freshTimeout.kind == DisplayKind::Connecting && !freshTimeout.hasValue);

  DisplayState fresh401 = applyFetchResult(fresh, FetchResult{FetchKind::HttpError, 401, nullptr, 0});
  check("401 with no prior value → stays Connecting", fresh401.kind == DisplayKind::Connecting && !fresh401.hasValue);

  // Recovery: after a failure, a good poll returns to Live.
  DisplayState recovered = applyFetchResult(afterTimeout, ok200(good));
  check("recovers to Live after a failure", recovered.kind == DisplayKind::Live && recovered.tokens == 14200000);

  // Negative token value is rejected (garbage guard).
  DisplayState afterNeg = applyFetchResult(s, ok200("{\"totals\":{\"tokens\":-5}}"));
  check("negative tokens rejected → Placeholder", afterNeg.kind == DisplayKind::Placeholder && afterNeg.tokens == 14200500);

  // --- phase 2: v2 parse + panel classification ---
  std::printf("\nphase-2 panel classification:\n");

  const char* twoFresh = "{\"totals\":{\"tokens\":500,\"cost_usd\":1.0},\"by_machine\":["
                         "{\"machine\":\"a\",\"stale\":false},{\"machine\":\"b\",\"stale\":false}]}";
  DisplayState live2 = applyFetchResult(DisplayState{}, ok200(twoFresh));
  check("v2 parses machine count + cost", live2.machineCount == 2 && live2.cost_usd == 1.0);
  check("all machines fresh → Panel Live", classifyPanel(live2) == PanelKind::Live);

  const char* oneStale = "{\"totals\":{\"tokens\":500},\"by_machine\":["
                         "{\"machine\":\"a\",\"stale\":false},{\"machine\":\"b\",\"stale\":true}]}";
  DisplayState partial = applyFetchResult(DisplayState{}, ok200(oneStale));
  check("some stale, some fresh → Panel Partial", classifyPanel(partial) == PanelKind::Partial);

  const char* allStaleBody = "{\"totals\":{\"tokens\":500},\"by_machine\":["
                             "{\"machine\":\"a\",\"stale\":true},{\"machine\":\"b\",\"stale\":true}]}";
  DisplayState allStale = applyFetchResult(DisplayState{}, ok200(allStaleBody));
  check("every machine stale → Panel AllStale", classifyPanel(allStale) == PanelKind::AllStale);

  const char* noMachines = "{\"totals\":{\"tokens\":0},\"by_machine\":[]}";
  DisplayState empty = applyFetchResult(DisplayState{}, ok200(noMachines));
  check("live fetch, zero machines → Panel Empty", classifyPanel(empty) == PanelKind::Empty);

  check("boot → Panel Connecting", classifyPanel(DisplayState{}) == PanelKind::Connecting);

  // A fetch failure after we had v2 data → Disconnected (dimmed last-good), counts retained.
  DisplayState disc = applyFetchResult(live2, FetchResult{FetchKind::NetworkError, 0, nullptr, 0});
  check("fetch fails after live → Panel Disconnected", classifyPanel(disc) == PanelKind::Disconnected);
  check("Disconnected retains last-good tokens", disc.tokens == 500);

  // --- phase 3: cost instrument / over-budget flag ---
  std::printf("\nphase-3 cost instrument:\n");
  const char* over = "{\"totals\":{\"tokens\":9},\"by_machine\":[{\"machine\":\"a\",\"stale\":false}],"
                     "\"cost\":{\"priced_usd\":75.0,\"budget\":{\"limit_usd\":50,\"used_pct\":150,\"over_budget\":true}}}";
  DisplayState overState = applyFetchResult(DisplayState{}, ok200(over));
  check("over-budget flag parsed from cost.budget", overState.overBudget == true);

  const char* under = "{\"totals\":{\"tokens\":9},\"by_machine\":[{\"machine\":\"a\",\"stale\":false}],"
                      "\"cost\":{\"priced_usd\":10.0,\"budget\":{\"limit_usd\":50,\"used_pct\":20,\"over_budget\":false}}}";
  check("under-budget → flag false", applyFetchResult(DisplayState{}, ok200(under)).overBudget == false);

  const char* noBudget = "{\"totals\":{\"tokens\":9},\"by_machine\":[{\"machine\":\"a\",\"stale\":false}],"
                         "\"cost\":{\"priced_usd\":10.0,\"budget\":null}}";
  check("no budget configured → flag false", applyFetchResult(DisplayState{}, ok200(noBudget)).overBudget == false);

  // --- phase 4: bounded hero interpolation ---
  std::printf("\nphase-4 ticker interpolation:\n");

  Ticker t;
  tickerConfirm(t, 1000);
  check("first confirm initializes displayed=target", t.displayed == 1000 && t.target == 1000);

  // A higher confirmed total raises the target; stepping eases up, never above it.
  tickerConfirm(t, 1500);
  check("higher confirm raises target, not displayed yet", t.target == 1500 && t.displayed == 1000);
  tickerStep(t, 0.5);
  check("step eases displayed up toward target", t.displayed == 1250);
  tickerStep(t, 1.0);
  check("step reaches but never exceeds target", t.displayed == 1500);
  tickerStep(t, 1.0);
  check("further steps never push above the confirmed total", t.displayed == 1500);

  // A LOWER confirmed total is an explicit reset (snap), not a backward ease.
  tickerConfirm(t, 800);
  check("downward correction resets displayed immediately", t.displayed == 800 && t.target == 800);

  // Bound invariant: across an arbitrary sequence, displayed is NEVER above target.
  Ticker t2;
  long long confirms[] = {0, 50, 50, 200, 199, 5000, 4000};
  bool everAbove = false;
  for (long long c : confirms) {
    tickerConfirm(t2, c);
    tickerStep(t2, 0.3);
    if (t2.displayed > t2.target) everAbove = true;
  }
  check("displayed is never interpolated above the last confirmed total", !everAbove);

  // A small gap must still close — integer truncation must not stall below target.
  Ticker t3;
  tickerConfirm(t3, 100);
  tickerConfirm(t3, 105); // gap of 5; 5 * 0.12 truncates to 0
  for (int i = 0; i < 10; i++) tickerStep(t3, 0.12);
  check("a small gap eventually reaches target (no stall)", t3.displayed == 105);

  // Gap: empty sparkline buckets are preserved exactly through parsing (real gaps).
  const char* spark = "{\"totals\":{\"tokens\":1},\"by_machine\":[{\"machine\":\"a\",\"stale\":false}],"
                      "\"sparkline_1h\":{\"bucket_seconds\":60,\"buckets\":[5,0,0,7]}}";
  ParsedSummary ps;
  bool parsedSpark = parseSummary(spark, std::strlen(spark), ps);
  check("sparkline parses to the exact bucket array incl. zero gaps",
        parsedSpark && ps.sparkCount == 4 && ps.sparkBuckets[0] == 5 &&
        ps.sparkBuckets[1] == 0 && ps.sparkBuckets[2] == 0 && ps.sparkBuckets[3] == 7);
  DisplayState sparkState = applyFetchResult(DisplayState{}, ok200(spark));
  check("body with a sparkline still classifies Live", classifyPanel(sparkState) == PanelKind::Live);

  std::printf("\n%s (%d failure%s)\n", g_failures == 0 ? "PASS" : "FAIL", g_failures, g_failures == 1 ? "" : "s");
  if (g_failures > 0) { std::printf("last state kind=%s\n", kindName(s.kind)); }
  return g_failures == 0 ? 0 : 1;
}
