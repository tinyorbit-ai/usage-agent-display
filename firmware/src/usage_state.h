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
// "have a last-good value". `tokens` is only meaningful when hasValue.
struct DisplayState {
  DisplayKind kind = DisplayKind::Connecting;
  long long tokens = 0;
  bool hasValue = false;
};

// Try to read totals.tokens out of a v1 summary body. Returns true and sets `out`
// on success; false on oversize, parse failure, or a missing/!integer field.
inline bool parseTokens(const char* body, size_t len, long long& out) {
  if (body == nullptr || len == 0) return false;
  if (len > kMaxBodyBytes) return false;  // oversize → fault, don't even parse

  JsonDocument doc;
  DeserializationError err = deserializeJson(doc, body, len);
  if (err) return false;  // truncated / malformed JSON

  JsonVariant totals = doc["totals"];
  if (totals.isNull()) return false;
  JsonVariant tokens = totals["tokens"];
  // Require an integral number; reject string/float/missing so we never render garbage.
  if (!tokens.is<long long>()) return false;

  long long value = tokens.as<long long>();
  if (value < 0) return false;
  out = value;
  return true;
}

// Fold a fetch result into the next display state. Pure: same inputs → same output.
// On any failure the previous value is retained and the state degrades to
// Placeholder (or stays Connecting if we never had a value) — never a crash, never
// a blank, never garbage.
inline DisplayState applyFetchResult(const DisplayState& prev, const FetchResult& r) {
  DisplayState next = prev;  // carry last-good tokens/hasValue forward by default

  const bool usableResponse = (r.kind == FetchKind::Ok && r.httpStatus >= 200 && r.httpStatus < 300);
  if (!usableResponse) {
    next.kind = prev.hasValue ? DisplayKind::Placeholder : DisplayKind::Connecting;
    return next;
  }

  long long tokens = 0;
  if (!parseTokens(r.body, r.bodyLen, tokens)) {
    next.kind = prev.hasValue ? DisplayKind::Placeholder : DisplayKind::Connecting;
    return next;
  }

  next.kind = DisplayKind::Live;
  next.tokens = tokens;
  next.hasValue = true;
  return next;
}

}  // namespace usage
