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

  std::printf("\n%s (%d failure%s)\n", g_failures == 0 ? "PASS" : "FAIL", g_failures, g_failures == 1 ? "" : "s");
  if (g_failures > 0) { std::printf("last state kind=%s\n", kindName(s.kind)); }
  return g_failures == 0 ? 0 : 1;
}
