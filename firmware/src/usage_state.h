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
#include <string.h>

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

// --- phase 12: the agent filter (timeframe × agent), parsed + selected in the host core ---
//
// The whole live /usage/summary parse now lives here (it used to be an UNBOUNDED
// JsonDocument in main.cpp — the P7/P10 host-core regression). parsePanel() runs under
// the kMaxBodyBytes cap and clamps every untrusted array, so the parse logic and the DoS
// guard are host-tested rather than bypassed. main.cpp becomes a pure renderer over
// PanelData via the select* functions. ADR 0014.

// The agent axis. AGENT_ALL is the combined view; the three chip agents map to the
// PRODUCTION provider ids the payload uses — `claude-code` (NOT `claude`), `codex`,
// `gemini` (codex review P12: a wrong id silently shows permanent zeros).
enum Agent { AGENT_ALL = 0, AGENT_CLAUDE = 1, AGENT_CODEX = 2, AGENT_GEMINI = 3 };
static const int kNumAgents = 3;  // chip agents (excludes ALL)

// provider id for chip agent index 0..2 (claude/codex/gemini).
inline const char* agentProviderId(int agentChipIdx) {
  switch (agentChipIdx) {
    case 0: return "claude-code";
    case 1: return "codex";
    case 2: return "gemini";
  }
  return "";
}

// Cap on graph buckets parsed/stored. `daily` is the latest buckets-with-data (≤14 — not
// a fixed 14-calendar-day axis), so this is a generous ceiling, not the axis length.
static const int kMaxDailyPoints = 16;

// One timeframe's numbers + its per-chip-agent split (tokens AND cost — cost is already
// per-provider in the payload, so a filtered cost is honest, never the combined total).
struct TfParsed {
  long long tokens = 0;
  double cost = 0;
  int days = 0;
  long long provTokens[kNumAgents] = {0, 0, 0};  // [claude-code, codex, gemini]
  double provCost[kNumAgents] = {0, 0, 0};
};

// The full parsed panel model. Per-provider daily arrays are index-aligned to `daily`'s
// actual buckets (dailyN long), zero-filled where a provider has no row.
struct PanelData {
  bool valid = false;
  TfParsed tf[3];  // today, d30, all
  int dailyN = 0;
  // 64-bit: a single day's token count can exceed the 32-bit `long` on the ESP32 (and
  // must never be narrowed to LVGL's 16-bit lv_coord_t raw — the renderer normalizes).
  long long daily[kMaxDailyPoints] = {0};                       // combined series
  long long dailyByProv[kNumAgents][kMaxDailyPoints] = {{0}};   // per chip agent, aligned + zero-filled
  long long monthTokens = 0;
  bool hasLastUsed = false;
  char lastUsedProvider[24] = "";
  long lastUsedAge = 0;
  bool hasActive = false;
  char activeMachine[24] = "";
  bool hasLastSync = false;
  long lastSyncAge = 0;
};

// Bounded copy into a fixed buffer (always NUL-terminates).
inline void copyBounded(char* dst, size_t cap, const char* src) {
  if (cap == 0) return;
  size_t i = 0;
  for (; src != nullptr && src[i] != '\0' && i + 1 < cap; i++) dst[i] = src[i];
  dst[i] = '\0';
}

// Parse a full /usage/summary body into PanelData. Returns false on oversize/parse-fail
// or a missing `timeframes` block (so the caller keeps last-good and degrades). Every
// untrusted array is clamped to its buffer AND to the combined `daily` length, so no
// claim in the body can drive an out-of-bounds write regardless of its size.
inline bool parsePanel(const char* body, size_t len, PanelData& out) {
  out = PanelData{};
  if (body == nullptr || len == 0) return false;
  if (len > kMaxBodyBytes) return false;  // DoS / truncation guard (now actually enforced)

  JsonDocument doc;
  if (deserializeJson(doc, body, len)) return false;

  JsonObjectConst tfs = doc["timeframes"];
  if (tfs.isNull()) return false;
  const char* tfKeys[3] = {"today", "d30", "all"};
  for (int i = 0; i < 3; i++) {
    JsonObjectConst t = tfs[tfKeys[i]];
    out.tf[i].tokens = t["tokens"] | 0LL;
    out.tf[i].cost = t["cost_usd"] | 0.0;
    out.tf[i].days = t["days"] | 0;
    JsonArrayConst bp = t["by_provider"];
    for (JsonObjectConst p : bp) {
      const char* id = p["provider"] | "";
      for (int a = 0; a < kNumAgents; a++) {
        if (strcmp(id, agentProviderId(a)) == 0) {
          out.tf[i].provTokens[a] = p["tokens"] | 0LL;
          out.tf[i].provCost[a] = p["cost_usd"] | 0.0;
        }
      }
    }
  }

  // Combined daily series — clamped to the buffer.
  int n = 0;
  for (JsonObjectConst pt : doc["daily"].as<JsonArrayConst>()) {
    if (n >= kMaxDailyPoints) break;
    out.daily[n++] = pt["tokens"] | 0LL;
  }
  out.dailyN = n;

  // Per-provider daily — clamped to the COMBINED axis length (and the buffer), every index
  // bound-checked, an under-length / missing array zero-padded (never a short/OOB read).
  JsonObjectConst dbp = doc["daily_by_provider"];
  if (!dbp.isNull()) {
    for (int a = 0; a < kNumAgents; a++) {
      JsonArrayConst arr = dbp[agentProviderId(a)].as<JsonArrayConst>();
      if (arr.isNull()) continue;  // missing key → row stays all-zeros
      int i = 0;
      for (JsonVariantConst v : arr) {
        if (i >= out.dailyN || i >= kMaxDailyPoints) break;  // clamp to combined axis + buffer
        out.dailyByProv[a][i++] = v.as<long long>();
      }
    }
  }

  out.monthTokens = doc["month"]["tokens"] | 0LL;

  JsonVariantConst lu = doc["last_used"];
  if (!lu.isNull()) {
    out.hasLastUsed = true;
    copyBounded(out.lastUsedProvider, sizeof(out.lastUsedProvider), lu["provider"] | "");
    out.lastUsedAge = lu["age_seconds"] | 0L;
  }
  if (!doc["active_machine"].isNull()) {
    out.hasActive = true;
    copyBounded(out.activeMachine, sizeof(out.activeMachine), doc["active_machine"] | "");
  }
  JsonVariantConst ls = doc["last_sync"];
  if (!ls.isNull()) {
    out.hasLastSync = true;
    out.lastSyncAge = ls["age_seconds"] | 0L;
  }

  out.valid = true;
  return true;
}

// Hero tokens for (timeframe, agent). ALL → the timeframe total; a named agent → its own
// per-provider value (0 when absent from that timeframe — NEVER the combined total).
inline long long selectHero(const PanelData& d, int tf, int agent) {
  if (tf < 0 || tf > 2) return 0;
  if (agent == AGENT_ALL) return d.tf[tf].tokens;
  const int a = agent - 1;
  if (a < 0 || a >= kNumAgents) return 0;
  return d.tf[tf].provTokens[a];
}

// Cost for (timeframe, agent) — same honesty rule as the hero.
inline double selectCost(const PanelData& d, int tf, int agent) {
  if (tf < 0 || tf > 2) return 0.0;
  if (agent == AGENT_ALL) return d.tf[tf].cost;
  const int a = agent - 1;
  if (a < 0 || a >= kNumAgents) return 0.0;
  return d.tf[tf].provCost[a];
}

inline int selectDays(const PanelData& d, int tf) {
  return (tf >= 0 && tf < 3) ? d.tf[tf].days : 0;
}

// Fill `out` with the series for `agent` (length = dailyN, capped at cap); returns the
// length. ALL → the combined `daily`; a named agent → its per-provider row (all-zeros
// when absent — NEVER a fallback to the combined series, which would overstate it).
inline int selectSeries(const PanelData& d, int agent, long long* out, int cap) {
  int n = d.dailyN;
  if (n > cap) n = cap;
  if (agent == AGENT_ALL) {
    for (int i = 0; i < n; i++) out[i] = d.daily[i];
    return n;
  }
  const int a = agent - 1;
  if (a < 0 || a >= kNumAgents) {
    for (int i = 0; i < n; i++) out[i] = 0;
    return n;
  }
  for (int i = 0; i < n; i++) out[i] = d.dailyByProv[a][i];
  return n;
}

// Peak value across a series (for the per-agent peak-day label + chart normalization).
inline long long seriesPeak(const long long* s, int n) {
  long long m = 0;
  for (int i = 0; i < n; i++)
    if (s[i] > m) m = s[i];
  return m;
}

}  // namespace usage
