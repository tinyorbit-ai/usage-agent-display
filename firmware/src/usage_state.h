// usage_state.h — the firmware's fetch/parse/state core, with ZERO Arduino, LVGL, or
// WiFi dependencies so it compiles and is unit-tested on the host (see
// firmware/test/native). main.cpp owns I/O (WiFi, HTTP, the LVGL label); this owns
// the decision: given a fetch outcome, what should the screen show?
//
// Contract: the panel NEVER shows a blank or garbage number. It is one of three
// states — Connecting (no data yet), Live (fresh value), Placeholder (a fetch/parse
// failure, showing the last-good value as stale). Last-good is retained across
// failures, so a network blip degrades gracefully instead of crashing or clearing.
#pragma once

#include <ArduinoJson.h>
#include <stdint.h>

namespace usage {

// The largest /usage/summary body we will attempt to parse. v1 is tiny; anything
// larger is treated as a fault (truncation guard / DoS guard), not parsed.
static const size_t kMaxBodyBytes = 8 * 1024;

enum class DisplayKind {
  Connecting,   // boot / never had a value
  Live,         // last poll succeeded; tokens is fresh
  Placeholder,  // last poll failed; tokens (if any) is last-good and stale
};

// The designed panel states (phase 2). Derived from the fetch outcome PLUS the data
// content (how many machines are stale). Each maps to a distinct rendering with a
// second, non-color signal (icon/label), so states are distinguishable in a
// desaturated photo. See ADR 0008.
enum class PanelKind {
  Connecting,    // no data yet
  Empty,         // live fetch, but zero machines have reported
  Live,          // every reporting machine is fresh
  Partial,       // some machines fresh, some stale
  AllStale,      // live fetch, but every machine is stale
  Disconnected,  // the fetch itself failed — showing last-good, dimmed
};

// How a single poll attempt turned out, handed in by main.cpp's HTTP code.
enum class FetchKind {
  Ok,            // got an HTTP response (status + body present)
  HttpError,     // non-2xx status (e.g. 401, 500)
  NetworkError,  // timeout, disconnect, DNS — no usable response
};

struct FetchResult {
  FetchKind kind;
  int httpStatus;        // meaningful when kind == Ok or HttpError
  const char* body;      // may be null
  size_t bodyLen;
};

// The whole display state. `hasValue` distinguishes "never had data" from
// "have a last-good value". `tokens` is only meaningful when hasValue. The machine
// counts drive the phase-2 panel classification.
struct DisplayState {
  DisplayKind kind = DisplayKind::Connecting;
  long long tokens = 0;
  double cost_usd = 0.0;
  bool hasValue = false;
  int machineCount = 0;  // machines present in the last good summary
  int staleCount = 0;    // of those, how many were flagged stale
  bool overBudget = false;  // phase 3: budget configured and exceeded
};

// Max sparkline buckets we render/store (1h / 60s = 60).
static const int kMaxSparkBuckets = 64;

// Parsed view of one v2 summary body.
struct ParsedSummary {
  long long tokens = 0;
  double cost_usd = 0.0;
  int machineCount = 0;
  int staleCount = 0;
  bool overBudget = false;  // phase 3: cost.budget.over_budget (false when no budget)
  int sparkCount = 0;       // phase 4: number of sparkline buckets parsed
  long sparkBuckets[kMaxSparkBuckets] = {0};  // burn per bucket — zeros are real gaps
};

// Parse a v2 summary body. Returns true and fills `out` on success; false on
// oversize, parse failure, or a missing/non-integer totals.tokens. by_machine is
// optional (a v1 body still parses for tokens), and each entry's stale flag is read
// so the panel can classify partial/all-stale.
inline bool parseSummary(const char* body, size_t len, ParsedSummary& out) {
  if (body == nullptr || len == 0) return false;
  if (len > kMaxBodyBytes) return false;  // oversize → fault, don't even parse

  JsonDocument doc;
  DeserializationError err = deserializeJson(doc, body, len);
  if (err) return false;  // truncated / malformed JSON

  JsonVariant totals = doc["totals"];
  if (totals.isNull()) return false;
  JsonVariant tokens = totals["tokens"];
  if (!tokens.is<long long>()) return false;  // reject string/float/missing
  long long value = tokens.as<long long>();
  if (value < 0) return false;

  out.tokens = value;
  out.cost_usd = totals["cost_usd"].is<double>() ? totals["cost_usd"].as<double>() : 0.0;

  out.machineCount = 0;
  out.staleCount = 0;
  JsonArray machines = doc["by_machine"].as<JsonArray>();
  if (!machines.isNull()) {
    for (JsonObject m : machines) {
      out.machineCount++;
      if (m["stale"].is<bool>() && m["stale"].as<bool>()) out.staleCount++;
    }
  }

  // phase 3: a configured-and-exceeded budget. Absent budget → false.
  JsonVariant budget = doc["cost"]["budget"];
  out.overBudget = !budget.isNull() && budget["over_budget"].is<bool>() && budget["over_budget"].as<bool>();

  // phase 4: sparkline buckets, preserved exactly — a 0 is a real gap, not dropped.
  out.sparkCount = 0;
  JsonArray spark = doc["sparkline_1h"]["buckets"].as<JsonArray>();
  if (!spark.isNull()) {
    for (JsonVariant v : spark) {
      if (out.sparkCount >= kMaxSparkBuckets) break;
      out.sparkBuckets[out.sparkCount++] = v.as<long>();
    }
  }
  return true;
}

// Back-compat shim: v1 callers that only want totals.tokens.
inline bool parseTokens(const char* body, size_t len, long long& out) {
  ParsedSummary p;
  if (!parseSummary(body, len, p)) return false;
  out = p.tokens;
  return true;
}

// Fold a fetch result into the next display state. Pure: same inputs → same output.
// On any failure the previous value is retained and the state degrades to
// Placeholder (or stays Connecting if we never had a value) — never a crash, never
// a blank, never garbage.
inline DisplayState applyFetchResult(const DisplayState& prev, const FetchResult& r) {
  DisplayState next = prev;  // carry last-good values forward by default

  const bool usableResponse = (r.kind == FetchKind::Ok && r.httpStatus >= 200 && r.httpStatus < 300);
  if (!usableResponse) {
    next.kind = prev.hasValue ? DisplayKind::Placeholder : DisplayKind::Connecting;
    return next;
  }

  ParsedSummary p;
  if (!parseSummary(r.body, r.bodyLen, p)) {
    next.kind = prev.hasValue ? DisplayKind::Placeholder : DisplayKind::Connecting;
    return next;
  }

  next.kind = DisplayKind::Live;
  next.tokens = p.tokens;
  next.cost_usd = p.cost_usd;
  next.machineCount = p.machineCount;
  next.staleCount = p.staleCount;
  next.overBudget = p.overBudget;
  next.hasValue = true;
  return next;
}

// --- phase 4: bounded hero interpolation (the "ticking" number) ---
//
// The displayed hero eases UP toward the last confirmed total between polls but is
// NEVER shown above it (no phantom burn). A higher confirmed total raises the target
// (ease up); a LOWER confirmed total — a correction or day-rollover — is an explicit
// reset (snap down), not a backward tick. Pure + host-tested (ADR 0010).
struct Ticker {
  long long displayed = 0;
  long long target = 0;
  bool initialized = false;
};

// Apply a freshly confirmed total from a poll.
inline void tickerConfirm(Ticker& t, long long confirmedTotal) {
  if (confirmedTotal < 0) return; // ignore garbage; core already rejects these upstream
  if (!t.initialized) {
    t.displayed = confirmedTotal;
    t.target = confirmedTotal;
    t.initialized = true;
    return;
  }
  if (confirmedTotal >= t.target) {
    t.target = confirmedTotal; // ease up toward the new, higher confirmed total
  } else {
    // Downward correction / day rollover → explicit reset, never a backward ease.
    t.displayed = confirmedTotal;
    t.target = confirmedTotal;
  }
}

// Advance the displayed value a step toward target. `fraction` in [0,1] is how far to
// close the remaining gap this frame. Result is clamped to target — never above it.
inline void tickerStep(Ticker& t, double fraction) {
  if (!t.initialized || t.displayed >= t.target) {
    t.displayed = t.target;
    return;
  }
  if (fraction < 0) fraction = 0;
  if (fraction > 1) fraction = 1;
  long long gap = t.target - t.displayed;
  long long advance = static_cast<long long>(static_cast<double>(gap) * fraction);
  // Integer truncation would stall a small gap (1..8 at 0.12) forever below target —
  // always close at least one token when there is a gap and any forward progress.
  if (advance < 1 && fraction > 0) advance = 1;
  long long advanced = t.displayed + advance;
  t.displayed = advanced < t.target ? advanced : t.target; // never overshoot confirmed
}

// Classify the designed panel state from the display state. Pure. Drives which tile
// layout + non-color signal the renderer shows (ADR 0008).
inline PanelKind classifyPanel(const DisplayState& s) {
  if (s.kind == DisplayKind::Connecting) return PanelKind::Connecting;
  if (s.kind == DisplayKind::Placeholder) return PanelKind::Disconnected;
  // Live:
  if (s.machineCount == 0) return PanelKind::Empty;
  if (s.staleCount == 0) return PanelKind::Live;
  if (s.staleCount >= s.machineCount) return PanelKind::AllStale;
  return PanelKind::Partial;
}

}  // namespace usage
