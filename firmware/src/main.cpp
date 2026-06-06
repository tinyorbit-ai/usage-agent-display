// main.cpp — ESP32-2432S028R ("Cheap Yellow Display") — LIVE panel (phase 11).
//
// Renders the locked "C2 · Daily Rate" design from real /usage/summary data:
//   timeframe tabs (DIRECT-TAP TODAY/30D/ALL) · big green hero · amber cost run-rate ·
//   named agent rows · tokens/day-14d bar graph · last-used + sync footer.
//
// Networking + JSON live here; the visual layout is unchanged from the static preview.
// Tabs are DIRECT-TAP (phase 11, ADR 0015): real XPT2046 coordinates on a dedicated
// HSPI bus → the host-tested routing core (ui_input.h / touch_config.h) decides which
// tab the tap selected. main.cpp only does the SPI read; every routing/gating decision
// is host-tested off-device. Crisp 1bpp Silkscreen pixel fonts (src/fonts/pixel*.c).
#include <Arduino.h>
#include <SPI.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <lvgl.h>
#include <TFT_eSPI.h>
#include <XPT2046_Touchscreen.h>

#include "config.h"  // gitignored: WIFI_SSID/PASSWORD, API_BASE_URL, API_BEARER_TOKEN, POLL_INTERVAL_MS
#include "touch_config.h"  // COMMITTED: kTouchCal, kTimeTabHitBoxes, kAllHitBoxes, kTouchTiming (ADR 0015)
#include "usage_state.h"   // host-tested: bounded parsePanel + (timeframe × agent) selection (ADR 0014)

LV_FONT_DECLARE(pixel8);   // tabs, graph labels, footer (small meta)
LV_FONT_DECLARE(pixel16);  // agent rows, sublabels
LV_FONT_DECLARE(pixel24);  // cost
LV_FONT_DECLARE(pixel40);  // hero

static TFT_eSPI tft = TFT_eSPI();
static const uint16_t kScreenW = 320;
static const uint16_t kScreenH = 240;
static lv_disp_draw_buf_t draw_buf;
static lv_color_t buf[kScreenW * 10];

// XPT2046 touch on a DEDICATED HSPI bus (ADR 0015) — separate from the display SPI.
#define TOUCH_CLK 25
#define TOUCH_MOSI 32
#define TOUCH_MISO 39
#define TOUCH_CS 33
#define TOUCH_IRQ 36  // PENIRQ — idles high, pulled low while touched
static SPIClass touchSPI(HSPI);
static XPT2046_Touchscreen touch(TOUCH_CS, TOUCH_IRQ);
static ui::TouchGate g_touchGate;

// --- palette ---
static const uint32_t kBg = 0x0A0E14, kCard = 0x11161F, kBorder = 0x222B3A;
static const uint32_t kHero = 0x7EE787, kCost = 0xFFD479, kDim = 0x8B98A8, kFaint = 0x5B6675;
static const uint32_t kClaude = 0xA78BFA, kCodex = 0x56D4DD, kGemini = 0xF0883E;
static const uint32_t kSegOn = 0x06210D, kWhite = 0xE6EDF3;

// The WHOLE live summary parse now lives in the host-tested core (usage_state.h) — the
// firmware is a pure renderer over PanelData, selected by (timeframe × agent).
static usage::PanelData g_panel;
static char g_sync[16] = "connecting";          // footer right (sync status text)
static bool g_haveData = false;
static int g_tf = 1;                            // start 30d
static int g_agent = usage::AGENT_ALL;          // start ALL (combined)

// Live label/handles updated on poll + tab/agent change.
static lv_obj_t* g_hero = nullptr;
static lv_obj_t* g_cost = nullptr;
static lv_obj_t* g_rate = nullptr;
static lv_obj_t* g_agentVal[3] = {nullptr, nullptr, nullptr};
static lv_obj_t* g_agentName[3] = {nullptr, nullptr, nullptr};
static lv_obj_t* g_monthLbl = nullptr;          // graph right label (month / agent peak / empty note)
static lv_obj_t* g_footL = nullptr;
static lv_obj_t* g_footR = nullptr;
static lv_obj_t* g_tabHi[3] = {nullptr, nullptr, nullptr};
static lv_obj_t* g_tabLabel[3] = {nullptr, nullptr, nullptr};
static lv_obj_t* g_chipHi[4] = {nullptr, nullptr, nullptr, nullptr};
static lv_obj_t* g_chipLabel[4] = {nullptr, nullptr, nullptr, nullptr};
static lv_obj_t* g_chart = nullptr;
static lv_chart_series_t* g_series = nullptr;
static const lv_coord_t kAgentY[3] = {98, 120, 142};

// Brand colors: per agent row (claude/codex/gemini) and the at-a-distance recolor cue.
static const uint32_t kAgentRowColor[3] = {kClaude, kCodex, kGemini};
static const char* kChipName[4] = {"ALL", "CLAUDE", "CODEX", "GEMINI"};  // for the graph note
// Hero + graph color for the selected agent (ALL stays the green hero color).
static uint32_t heroColorFor(int agent) {
  switch (agent) {
    case usage::AGENT_CLAUDE: return kClaude;
    case usage::AGENT_CODEX: return kCodex;
    case usage::AGENT_GEMINI: return kGemini;
    default: return kHero;
  }
}
// Chip brand color (chip index 0..3; ALL is white).
static uint32_t chipColorFor(int chip) {
  switch (chip) {
    case 1: return kClaude;
    case 2: return kCodex;
    case 3: return kGemini;
    default: return kWhite;
  }
}

static void flush_cb(lv_disp_drv_t* drv, const lv_area_t* area, lv_color_t* pixels) {
  uint32_t w = area->x2 - area->x1 + 1, h = area->y2 - area->y1 + 1;
  tft.startWrite();
  tft.setAddrWindow(area->x1, area->y1, w, h);
  tft.pushColors(reinterpret_cast<uint16_t*>(pixels), w * h, true);
  tft.endWrite();
  lv_disp_flush_ready(drv);
}

static lv_obj_t* mkLabel(lv_obj_t* parent, lv_coord_t x, lv_coord_t y, const lv_font_t* font,
                         uint32_t color, const char* text) {
  lv_obj_t* l = lv_label_create(parent);
  lv_obj_set_style_text_font(l, font, LV_PART_MAIN);
  lv_obj_set_style_text_color(l, lv_color_hex(color), LV_PART_MAIN);
  lv_obj_set_pos(l, x, y);
  lv_label_set_text(l, text);
  return l;
}
static void alignRight(lv_obj_t* l, lv_coord_t rightX, lv_coord_t y) {
  lv_obj_update_layout(l);
  lv_obj_set_pos(l, rightX - lv_obj_get_width(l), y);
}
static void centerIn(lv_obj_t* l, lv_coord_t boxX, lv_coord_t boxW, lv_coord_t y) {
  lv_obj_update_layout(l);
  lv_obj_set_pos(l, boxX + (boxW - lv_obj_get_width(l)) / 2, y);
}
static lv_obj_t* mkRect(lv_obj_t* parent, lv_coord_t x, lv_coord_t y, lv_coord_t w, lv_coord_t h,
                        uint32_t bg, lv_coord_t radius, uint32_t border) {
  lv_obj_t* r = lv_obj_create(parent);
  lv_obj_set_pos(r, x, y);
  lv_obj_set_size(r, w, h);
  lv_obj_set_style_bg_color(r, lv_color_hex(bg), LV_PART_MAIN);
  lv_obj_set_style_bg_opa(r, LV_OPA_COVER, LV_PART_MAIN);
  lv_obj_set_style_radius(r, radius, LV_PART_MAIN);
  lv_obj_set_style_border_width(r, border ? 1 : 0, LV_PART_MAIN);
  if (border) lv_obj_set_style_border_color(r, lv_color_hex(border), LV_PART_MAIN);
  lv_obj_set_style_pad_all(r, 0, LV_PART_MAIN);
  lv_obj_clear_flag(r, LV_OBJ_FLAG_SCROLLABLE);
  return r;
}
static void mkDot(lv_obj_t* parent, lv_coord_t x, lv_coord_t y, uint32_t color) {
  lv_obj_t* d = lv_obj_create(parent);
  lv_obj_set_pos(d, x, y);
  lv_obj_set_size(d, 9, 9);
  lv_obj_set_style_radius(d, LV_RADIUS_CIRCLE, LV_PART_MAIN);
  lv_obj_set_style_bg_color(d, lv_color_hex(color), LV_PART_MAIN);
  lv_obj_set_style_bg_opa(d, LV_OPA_COVER, LV_PART_MAIN);
  lv_obj_set_style_border_width(d, 0, LV_PART_MAIN);
  lv_obj_clear_flag(d, LV_OBJ_FLAG_SCROLLABLE);
}

// Abbreviate a token count to 3 sig figs with K/M/B.
static void humanize(long long v, char* out, size_t n) {
  if (v < 0) v = 0;
  double x; const char* suf;
  if (v >= 1000000000LL) { x = v / 1e9; suf = "B"; }
  else if (v >= 1000000LL) { x = v / 1e6; suf = "M"; }
  else if (v >= 1000LL) { x = v / 1e3; suf = "K"; }
  else { snprintf(out, n, "%lld", v); return; }
  if (x >= 100) snprintf(out, n, "%.0f%s", x, suf);
  else if (x >= 10) snprintf(out, n, "%.1f%s", x, suf);
  else snprintf(out, n, "%.2f%s", x, suf);
}
// Coarse age: 49s / 12m / 3h / 2d.
static void fmtAge(long sec, char* out, size_t n) {
  if (sec < 60) snprintf(out, n, "%lds", sec);
  else if (sec < 3600) snprintf(out, n, "%ldm", sec / 60);
  else if (sec < 86400) snprintf(out, n, "%ldh", sec / 3600);
  else snprintf(out, n, "%ldd", sec / 86400);
}

static void updateGraph();  // defined below; renderActive drives it on every change

// Render the panel for the current (timeframe × agent) selection from g_panel. ALL is
// the combined view; a named agent re-scopes hero + cost + graph to that provider, the
// breakdown rows dim all but the selected, and an idle agent gets a designed empty state.
static void renderActive() {
  // Time tabs: selected = filled green pill + dark label.
  for (int i = 0; i < 3; i++) {
    if (i == g_tf) lv_obj_clear_flag(g_tabHi[i], LV_OBJ_FLAG_HIDDEN);
    else lv_obj_add_flag(g_tabHi[i], LV_OBJ_FLAG_HIDDEN);
    lv_obj_set_style_text_color(g_tabLabel[i], lv_color_hex(i == g_tf ? kSegOn : kFaint), LV_PART_MAIN);
  }
  // Agent chips: selected = filled BRAND pill + dark label (non-color signal); others
  // keep their brand-colored label (always identifiable).
  for (int c = 0; c < 4; c++) {
    if (c == g_agent) {
      lv_obj_set_style_bg_color(g_chipHi[c], lv_color_hex(chipColorFor(c)), LV_PART_MAIN);
      lv_obj_clear_flag(g_chipHi[c], LV_OBJ_FLAG_HIDDEN);
      lv_obj_set_style_text_color(g_chipLabel[c], lv_color_hex(kBg), LV_PART_MAIN);
    } else {
      lv_obj_add_flag(g_chipHi[c], LV_OBJ_FLAG_HIDDEN);
      lv_obj_set_style_text_color(g_chipLabel[c], lv_color_hex(chipColorFor(c)), LV_PART_MAIN);
    }
  }

  const bool filtered = (g_agent != usage::AGENT_ALL);
  const uint32_t heroCol = heroColorFor(g_agent);
  char b[28];

  // Hero — selected (timeframe, agent), recolored to the agent's brand (the glance cue).
  const long long heroTok = usage::selectHero(g_panel, g_tf, g_agent);
  if (!g_haveData) lv_label_set_text(g_hero, "--");
  else { humanize(heroTok, b, sizeof(b)); lv_label_set_text(g_hero, b); }
  lv_obj_set_style_text_color(g_hero, lv_color_hex(heroCol), LV_PART_MAIN);

  // Cost + $/day run-rate for the selection (honest per-agent cost, never combined).
  const double cost = usage::selectCost(g_panel, g_tf, g_agent);
  const int days = usage::selectDays(g_panel, g_tf);
  snprintf(b, sizeof(b), "$%lld", (long long)llround(cost));
  lv_label_set_text(g_cost, b);
  alignRight(g_cost, 312, 36);
  if (g_tf == 0) snprintf(b, sizeof(b), "today");
  else if (days > 0) snprintf(b, sizeof(b), "$%lld/day", (long long)llround(cost / days));
  else snprintf(b, sizeof(b), " ");
  lv_label_set_text(g_rate, b);
  alignRight(g_rate, 312, 74);

  // Breakdown rows: always the three providers for this timeframe; under a filter the
  // selected row stays bright and the others dim (selection ≠ the always-colored dots).
  for (int i = 0; i < 3; i++) {
    humanize(g_panel.tf[g_tf].provTokens[i], b, sizeof(b));
    lv_label_set_text(g_agentVal[i], b);
    alignRight(g_agentVal[i], 312, kAgentY[i]);
    const bool isSel = filtered && (g_agent - 1 == i);
    const bool dim = filtered && !isSel;
    lv_obj_set_style_text_color(g_agentVal[i], lv_color_hex(dim ? kFaint : kWhite), LV_PART_MAIN);
    lv_obj_set_style_text_color(g_agentName[i], lv_color_hex(dim ? kFaint : kAgentRowColor[i]), LV_PART_MAIN);
  }

  // Graph (recolored, deterministic redraw) + its right label.
  updateGraph();
  long long series[usage::kMaxDailyPoints];
  const int sn = usage::selectSeries(g_panel, g_agent, series, usage::kMaxDailyPoints);
  const long long peak = usage::seriesPeak(series, sn);
  const bool emptyFilter = filtered && g_haveData && heroTok == 0 && peak == 0;
  if (emptyFilter) {
    snprintf(b, sizeof(b), "NO %s 14d", kChipName[g_agent]);  // designed empty-filter state
  } else if (filtered) {
    char pk[12]; humanize(peak, pk, sizeof(pk));
    snprintf(b, sizeof(b), "%s PK %s", kChipName[g_agent], pk);
  } else {
    char mt[12]; humanize(g_panel.monthTokens, mt, sizeof(mt));
    snprintf(b, sizeof(b), "MONTH %s", mt);
  }
  lv_label_set_text(g_monthLbl, b);
  alignRight(g_monthLbl, 312, 166);

  // Footer: last-used / active machine, and the sync status (selection survives both).
  if (g_haveData && g_panel.hasLastUsed) {
    char age[12]; fmtAge(g_panel.lastUsedAge, age, sizeof(age));
    snprintf(b, sizeof(b), "LAST USED %s %s", g_panel.lastUsedProvider, age);
  } else if (g_haveData && g_panel.hasActive) {
    snprintf(b, sizeof(b), "ACTIVE %s", g_panel.activeMachine);
  } else {
    b[0] = '\0';
  }
  lv_label_set_text(g_footL, b);
  lv_label_set_text(g_footR, g_sync);
  alignRight(g_footR, 312, 220);
}

static void buildScreen() {
  lv_obj_t* scr = lv_scr_act();
  lv_obj_set_style_bg_color(scr, lv_color_hex(kBg), LV_PART_MAIN);

  const lv_coord_t segW = 40;
  const char* labels[3] = {"TODAY", "30D", "ALL"};
  mkRect(scr, 10, 6, segW * 3, 22, kCard, 6, kBorder);
  for (int i = 0; i < 3; i++) {
    lv_coord_t x = 10 + segW * i;
    g_tabHi[i] = mkRect(scr, x + 1, 9, segW - 2, 16, kHero, 4, 0);
    lv_obj_add_flag(g_tabHi[i], LV_OBJ_FLAG_HIDDEN);
    g_tabLabel[i] = mkLabel(scr, 0, 0, &pixel8, kFaint, labels[i]);
    centerIn(g_tabLabel[i], x, segW, 13);
  }
  // Agent control (phase 12): 4 chips ALL / CC / CX / GE in the right band of the top
  // bar. Drawn pills mirror the time-tab style; hit-boxes are in touch_config.h
  // (kAgentHitBoxes) and are kept geometrically in sync with these draw positions.
  const lv_coord_t chipW = 40;
  const lv_coord_t chipX0 = 150;  // matches kAgentHitBoxes[0].x0
  const char* chipLabels[4] = {"ALL", "CC", "CX", "GE"};
  mkRect(scr, chipX0 - 2, 6, chipW * 4, 22, kCard, 6, kBorder);
  for (int c = 0; c < 4; c++) {
    lv_coord_t x = chipX0 + chipW * c;
    g_chipHi[c] = mkRect(scr, x, 9, chipW - 2, 16, chipColorFor(c), 4, 0);
    lv_obj_add_flag(g_chipHi[c], LV_OBJ_FLAG_HIDDEN);
    g_chipLabel[c] = mkLabel(scr, 0, 0, &pixel8, chipColorFor(c), chipLabels[c]);
    centerIn(g_chipLabel[c], x, chipW - 2, 13);
  }

  g_hero = mkLabel(scr, 10, 30, &pixel40, kHero, "--");
  mkLabel(scr, 12, 74, &pixel16, kDim, "tokens");
  g_cost = mkLabel(scr, 0, 36, &pixel24, kCost, "");
  g_rate = mkLabel(scr, 0, 74, &pixel16, kFaint, "");

  const char* names[3] = {"CLAUDE", "CODEX", "GEMINI"};
  const uint32_t cols[3] = {kClaude, kCodex, kGemini};
  for (int i = 0; i < 3; i++) {
    mkDot(scr, 12, kAgentY[i] + 4, cols[i]);
    g_agentName[i] = mkLabel(scr, 28, kAgentY[i], &pixel16, cols[i], names[i]);
    g_agentVal[i] = mkLabel(scr, 0, kAgentY[i], &pixel16, kWhite, "");
  }

  mkLabel(scr, 10, 166, &pixel8, kFaint, "TOKENS / DAY  -  14d");
  g_monthLbl = mkLabel(scr, 0, 166, &pixel8, kFaint, "");

  g_chart = lv_chart_create(scr);
  lv_obj_set_pos(g_chart, 10, 180);
  lv_obj_set_size(g_chart, 300, 32);
  lv_chart_set_type(g_chart, LV_CHART_TYPE_BAR);
  lv_chart_set_point_count(g_chart, 14);
  lv_obj_set_style_bg_opa(g_chart, LV_OPA_TRANSP, LV_PART_MAIN);
  lv_obj_set_style_border_width(g_chart, 0, LV_PART_MAIN);
  lv_obj_set_style_pad_all(g_chart, 0, LV_PART_MAIN);
  lv_obj_set_style_pad_column(g_chart, 3, LV_PART_MAIN);
  lv_obj_set_style_radius(g_chart, 0, LV_PART_ITEMS);
  lv_chart_set_div_line_count(g_chart, 0, 0);
  g_series = lv_chart_add_series(g_chart, lv_color_hex(kHero), LV_CHART_AXIS_PRIMARY_Y);

  g_footL = mkLabel(scr, 10, 220, &pixel8, kDim, "");
  g_footR = mkLabel(scr, 0, 220, &pixel8, kFaint, "connecting");
  alignRight(g_footR, 312, 220);
}

// Redraw the bar graph for the SELECTED agent's series. Recolors to the agent's brand,
// autoscales to the series' OWN max, and writes every bar BY INDEX (clear-before-fill) so
// a redraw is a pure function of the selected series — no ring-buffer stale bars across
// filter toggles (the deterministic-redraw requirement).
static const lv_coord_t kGraphScale = 1000;  // bars normalized to 0..kGraphScale

static void updateGraph() {
  if (!g_series) return;
  long long series[usage::kMaxDailyPoints];
  const int n = usage::selectSeries(g_panel, g_agent, series, usage::kMaxDailyPoints);
  // Autoscale to the SELECTED series' own max, then normalize bar heights into a small
  // lv_coord_t range — token counts are 64-bit (billions) and would wrap if cast straight
  // to LVGL's 16-bit coords (codex P12). Range is fixed; only the normalized values vary.
  long long maxV = usage::seriesPeak(series, n);
  if (maxV < 1) maxV = 1;
  g_series->color = lv_color_hex(heroColorFor(g_agent));
  // LVGL's bar chart divides by (point_cnt - 1), so point_cnt MUST stay >= 2 — a count of
  // 1 (e.g. at boot before any data) is an IntegerDivideByZero crash (lv_chart.c:1228).
  const int points = n >= 2 ? n : 2;
  lv_chart_set_point_count(g_chart, points);
  lv_chart_set_range(g_chart, LV_CHART_AXIS_PRIMARY_Y, 0, kGraphScale);
  // Write EVERY declared point by index (clear-before-fill) — a redraw is a pure function
  // of the selected series, never the prior ring-buffer state. Points beyond the series
  // (incl. the whole axis when empty) are written 0 so no stale bar survives.
  for (int i = 0; i < points; i++) {
    const lv_coord_t h = (i < n) ? (lv_coord_t)((series[i] * kGraphScale) / maxV) : 0;
    lv_chart_set_value_by_id(g_chart, g_series, i, h);
  }
  lv_chart_refresh(g_chart);
}

// Read the response body into `out`, enforcing kMaxBodyBytes BEFORE the heap fills: a
// known-oversize Content-Length is rejected outright, and a chunked/unknown stream is
// aborted the moment it crosses the cap — so an oversized /usage/summary can't OOM the
// ESP32 before the bounded parse even runs (codex P12). Returns false on oversize/abort.
static bool readBoundedBody(HTTPClient& http, String& out) {
  const int contentLen = http.getSize();
  if (contentLen > static_cast<int>(usage::kMaxBodyBytes)) return false;  // declared oversize
  WiFiClient* stream = http.getStreamPtr();
  if (stream == nullptr) return false;
  out = "";
  out.reserve((contentLen > 0 ? contentLen : 2048) + 1);
  char buf[513];
  size_t total = 0;
  const uint32_t deadline = millis() + 8000;
  while (millis() < deadline) {
    const int avail = stream->available();
    if (avail > 0) {
      int toRead = avail < static_cast<int>(sizeof(buf) - 1) ? avail : static_cast<int>(sizeof(buf) - 1);
      const int n = stream->readBytes(buf, toRead);
      if (n <= 0) break;
      total += static_cast<size_t>(n);
      if (total > usage::kMaxBodyBytes) return false;  // streamed past the cap → abort, don't grow
      buf[n] = '\0';
      out += buf;
    } else if (!http.connected()) {
      break;  // server closed and nothing left buffered → complete
    } else if (contentLen >= 0 && total >= static_cast<size_t>(contentLen)) {
      break;  // got the full declared body
    } else {
      delay(5);  // awaiting more bytes
    }
  }
  return true;
}

// Fetch /usage/summary and refresh state. Returns true on a good parse. Speaks HTTPS
// when API_BASE_URL is an https:// URL (e.g. the public Cloudflare-Tunnel host), plain
// HTTP otherwise (e.g. a LAN address). For TLS: pins API_ROOT_CA if config.h defines it,
// else falls back to setInsecure() (encrypted but unauthenticated server — fine on a
// trusted LAN, but define API_ROOT_CA to protect the bearer token over the open internet).
static bool poll() {
  if (WiFi.status() != WL_CONNECTED) { snprintf(g_sync, sizeof(g_sync), "no wifi"); return false; }
  const bool tls = strncmp(API_BASE_URL, "https", 5) == 0;
  HTTPClient http;
  http.setTimeout(8000);
  const String url = String(API_BASE_URL) + "/usage/summary";
  if (tls) {
    static WiFiClientSecure secure;
    static bool inited = false;
    if (!inited) {
#ifdef API_ROOT_CA
      secure.setCACert(API_ROOT_CA);
#else
      secure.setInsecure();
#endif
      inited = true;
    }
    http.begin(secure, url);
  } else {
    http.begin(url);
  }
  http.addHeader("Authorization", String("Bearer ") + API_BEARER_TOKEN);
  int code = http.GET();
  if (code != 200) { snprintf(g_sync, sizeof(g_sync), "err %d", code); http.end(); return false; }
  String body;
  const bool read = readBoundedBody(http, body);
  http.end();
  if (!read) { snprintf(g_sync, sizeof(g_sync), "big"); return false; }

  // The whole parse runs in the bounded host-tested core (kMaxBodyBytes + clamped arrays).
  // Parse into a TEMP first so a bad/oversize body keeps the last-good panel (the filter
  // still works on last-good data) instead of clearing it.
  usage::PanelData parsed;
  if (!usage::parsePanel(body.c_str(), body.length(), parsed)) {
    snprintf(g_sync, sizeof(g_sync), "parse");
    return false;
  }
  g_panel = parsed;
  g_haveData = true;

  if (g_panel.hasLastSync) {
    char age[12];
    fmtAge(g_panel.lastSyncAge, age, sizeof(age));
    snprintf(g_sync, sizeof(g_sync), "SYNC %s", age);
  } else {
    snprintf(g_sync, sizeof(g_sync), "SYNC --");
  }
  return true;
}

void setup() {
  Serial.begin(115200);
  pinMode(TOUCH_IRQ, INPUT);
  touchSPI.begin(TOUCH_CLK, TOUCH_MISO, TOUCH_MOSI, TOUCH_CS);
  touch.begin(touchSPI);
  touch.setRotation(0);  // read raw ADC axes; landscape mapping is ui::rawToScreen (ADR 0015)
  tft.begin();
  tft.setRotation(1);
  lv_init();
  lv_disp_draw_buf_init(&draw_buf, buf, nullptr, kScreenW * 10);

  static lv_disp_drv_t disp_drv;
  lv_disp_drv_init(&disp_drv);
  disp_drv.hor_res = kScreenW;
  disp_drv.ver_res = kScreenH;
  disp_drv.flush_cb = flush_cb;
  disp_drv.draw_buf = &draw_buf;
  lv_disp_drv_register(&disp_drv);

  buildScreen();
  renderActive();

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
}

void loop() {
  lv_timer_handler();

  static uint32_t lastPoll = 0;
  static bool wifiLogged = false;
  uint32_t now = millis();
  if (!wifiLogged && WiFi.status() == WL_CONNECTED) {
    wifiLogged = true;
    Serial.printf("[wifi] connected, ip=%s\n", WiFi.localIP().toString().c_str());
  }
  if (lastPoll == 0 || now - lastPoll >= POLL_INTERVAL_MS) {
    lastPoll = now;
    const bool ok = poll();
    renderActive();
    // Diagnostic (observability + verification): sync status + the live selection.
    Serial.printf("[poll] ok=%d %s  hero(tf=%d,agent=%d)=%lld  daily=%d\n", ok, g_sync, g_tf,
                  g_agent, (long long)usage::selectHero(g_panel, g_tf, g_agent), g_panel.dailyN);
  }

  // Direct-tap the timeframe tabs (phase 11, ADR 0015). Read real XPT2046 coordinates
  // ONLY while PENIRQ asserts; hand the sample to the host-tested routing/gating core,
  // which returns the selected tab (or nothing) with debounce + no re-arm-under-hold.
  const bool penirq = (digitalRead(TOUCH_IRQ) == LOW);
  int rawX = 0, rawY = 0, rawZ = 0;
  if (penirq) {
    const TS_Point p = touch.getPoint();
    rawX = p.x;
    rawY = p.y;
    rawZ = p.z;
    // Calibration aid: print raw + mapped coords so kTouchCal (touch_config.h) can be
    // tuned on-device — tap each corner, read these, set the four raw extremes.
    int mx = -1, my = -1;
    const bool inRange = ui::rawToScreen(ui::kTouchCal, rawX, rawY, mx, my);
    Serial.printf("touch raw=(%d,%d) -> screen=(%d,%d) z=%d valid=%d\n", rawX, rawY, mx, my, rawZ, inRange);
  }
  ui::Tap tap;
  if (ui::touchGate(g_touchGate, ui::kTouchCal, ui::kAllHitBoxes, ui::kAllHitBoxCount,
                    now, penirq, rawX, rawY, rawZ, ui::kTouchTiming, tap)) {
    if (tap.kind == ui::TapKind::TimeTab) {
      g_tf = tap.index;
      renderActive();
    } else if (tap.kind == ui::TapKind::AgentChip) {
      g_agent = tap.index;  // index matches usage::Agent (0=ALL..3=gemini)
      renderActive();
    }
  }

  delay(5);
}
