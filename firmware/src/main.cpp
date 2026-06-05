// main.cpp — ESP32-2432S028R ("Cheap Yellow Display") firmware, phase 2.
//
// Renders the real dashboard per the fixed metric hierarchy (ADR 0008):
//   hero tokens > cost > per-provider > per-machine > session > month > last-sync.
// All fetch/parse/state DECISIONS live in usage_state.h (host-tested); main.cpp is
// I/O + LVGL rendering. The panel renders a designed state for each PanelKind, each
// with a second non-color signal (an icon/label prefix) so it reads in a desaturated
// photo: Connecting "…", Live "●", Partial "◑", AllStale "○ STALE", Disconnected
// "⚠ OFFLINE", Empty "no data".
#include <Arduino.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <lvgl.h>
#include <TFT_eSPI.h>

#include "config.h"        // gitignored secrets (see config.h.example)
#include "usage_state.h"   // pure fetch/parse/state core (host-tested)

static TFT_eSPI tft = TFT_eSPI();
static const uint16_t kScreenW = 320;  // landscape
static const uint16_t kScreenH = 240;
static lv_disp_draw_buf_t draw_buf;
static lv_color_t buf[kScreenW * 10];

// Tiles (created once, updated each poll).
static lv_obj_t* g_statusChip = nullptr;  // non-color state signal (top-left)
static lv_obj_t* g_hero = nullptr;        // hero token number
static lv_obj_t* g_cost = nullptr;        // cost line
static lv_obj_t* g_providers = nullptr;   // CC vs Codex
static lv_obj_t* g_machines = nullptr;    // per-machine + age/stale
static lv_obj_t* g_footer = nullptr;      // session · month · last-sync age

static void flush_cb(lv_disp_drv_t* drv, const lv_area_t* area, lv_color_t* pixels) {
  uint32_t w = area->x2 - area->x1 + 1;
  uint32_t h = area->y2 - area->y1 + 1;
  tft.startWrite();
  tft.setAddrWindow(area->x1, area->y1, w, h);
  tft.pushColors(reinterpret_cast<uint16_t*>(pixels), w * h, true);
  tft.endWrite();
  lv_disp_flush_ready(drv);
}

static lv_obj_t* mkLabel(lv_coord_t x, lv_coord_t y, const lv_font_t* font, lv_color_t color) {
  lv_obj_t* l = lv_label_create(lv_scr_act());
  lv_obj_set_style_text_font(l, font, LV_PART_MAIN);
  lv_obj_set_style_text_color(l, color, LV_PART_MAIN);
  lv_obj_set_pos(l, x, y);
  lv_label_set_text(l, "");
  return l;
}

static void display_init() {
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

  lv_obj_set_style_bg_color(lv_scr_act(), lv_color_black(), LV_PART_MAIN);
  g_statusChip = mkLabel(8, 6, &lv_font_montserrat_14, lv_color_hex(0x888888));
  g_hero = mkLabel(8, 28, &lv_font_montserrat_28, lv_color_white());
  g_cost = mkLabel(8, 74, &lv_font_montserrat_14, lv_color_hex(0xBBBBBB));
  g_providers = mkLabel(8, 100, &lv_font_montserrat_14, lv_color_hex(0xBBBBBB));
  g_machines = mkLabel(8, 130, &lv_font_montserrat_14, lv_color_hex(0xBBBBBB));
  g_footer = mkLabel(8, 210, &lv_font_montserrat_14, lv_color_hex(0x888888));
  lv_label_set_text(g_statusChip, "... connecting");
}

// Group digits with thin spaces so the hero number reads across the room.
static void formatTokens(long long tokens, char* out, size_t outLen) {
  char digits[24];
  snprintf(digits, sizeof(digits), "%lld", tokens);
  int len = static_cast<int>(strlen(digits));
  size_t o = 0;
  for (int i = 0; i < len && o + 2 < outLen; i++) {
    if (i > 0 && (len - i) % 3 == 0) out[o++] = ' ';
    out[o++] = digits[i];
  }
  out[o] = '\0';
}

// The non-color signal per panel state (icon/word prefix), and the hero text color.
static void renderStateChrome(usage::PanelKind kind) {
  struct { const char* chip; uint32_t hero; } v;
  switch (kind) {
    case usage::PanelKind::Connecting:   v = {"... connecting", 0x888888}; break;
    case usage::PanelKind::Empty:        v = {"no data yet",    0x888888}; break;
    case usage::PanelKind::Live:         v = {"# live",          0xFFFFFF}; break;
    case usage::PanelKind::Partial:      v = {"~ partial",       0xFFFFFF}; break;
    case usage::PanelKind::AllStale:     v = {"o STALE",         0x777755}; break;
    case usage::PanelKind::Disconnected: v = {"! OFFLINE",       0x555555}; break;
  }
  lv_label_set_text(g_statusChip, v.chip);
  lv_obj_set_style_text_color(g_hero, lv_color_hex(v.hero), LV_PART_MAIN);
}

// Render the detailed tiles from the (already validated) summary body. Rendering
// only — no decisions. Bounded reads; missing fields render as blanks, never garbage.
static void renderTiles(const char* body, size_t len) {
  JsonDocument doc;
  if (deserializeJson(doc, body, len)) return;  // core already validated; be safe

  char heroText[40];
  formatTokens(doc["totals"]["tokens"].as<long long>(), heroText, sizeof(heroText));
  lv_label_set_text(g_hero, heroText);

  char costText[32];
  snprintf(costText, sizeof(costText), "$%.2f", doc["totals"]["cost_usd"].as<double>());
  lv_label_set_text(g_cost, costText);

  // Providers (CC vs Codex).
  char prov[64] = "";
  for (JsonObject p : doc["by_provider"].as<JsonArray>()) {
    char one[32];
    snprintf(one, sizeof(one), "%.6s %lld  ", p["provider"].as<const char*>(), p["tokens"].as<long long>());
    strncat(prov, one, sizeof(prov) - strlen(prov) - 1);
  }
  lv_label_set_text(g_providers, prov);

  // Machines, with an explicit age and a STALE marker (non-color signal).
  char mach[96] = "";
  for (JsonObject m : doc["by_machine"].as<JsonArray>()) {
    char one[48];
    snprintf(one, sizeof(one), "%.6s %lds%s\n", m["machine"].as<const char*>(),
             m["age_seconds"].as<long>(), m["stale"].as<bool>() ? " STALE" : "");
    strncat(mach, one, sizeof(mach) - strlen(mach) - 1);
  }
  lv_label_set_text(g_machines, mach);

  // Footer: session burn · month-to-date · last-sync age.
  char footer[96];
  long sessionTok = doc["session"].isNull() ? 0 : doc["session"]["tokens"].as<long>();
  long monthTok = doc["month"]["tokens"].as<long>();
  long syncAge = doc["last_sync"].isNull() ? -1 : doc["last_sync"]["age_seconds"].as<long>();
  snprintf(footer, sizeof(footer), "sess %ld  mtd %ld  sync %lds", sessionTok, monthTok, syncAge);
  lv_label_set_text(g_footer, footer);
}

static void wifi_connect() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
}

static usage::DisplayState g_state;
static char g_lastBody[usage::kMaxBodyBytes];
static size_t g_lastLen = 0;

static void poll_once() {
  if (WiFi.status() != WL_CONNECTED) {
    g_state = usage::applyFetchResult(g_state, {usage::FetchKind::NetworkError, 0, nullptr, 0});
    renderStateChrome(usage::classifyPanel(g_state));
    return;
  }

  HTTPClient http;
  http.setTimeout(4000);
  http.begin(String(API_BASE_URL) + "/usage/summary");
  http.addHeader("Authorization", String("Bearer ") + API_BEARER_TOKEN);

  int status = http.GET();
  if (status <= 0) {
    g_state = usage::applyFetchResult(g_state, {usage::FetchKind::NetworkError, 0, nullptr, 0});
  } else if (status < 200 || status >= 300) {
    g_state = usage::applyFetchResult(g_state, {usage::FetchKind::HttpError, status, nullptr, 0});
  } else {
    String body = http.getString();
    usage::FetchResult r{usage::FetchKind::Ok, status, body.c_str(), static_cast<size_t>(body.length())};
    usage::DisplayState next = usage::applyFetchResult(g_state, r);
    if (next.kind == usage::DisplayKind::Live && body.length() < sizeof(g_lastBody)) {
      // Keep the last good body so the tiles can re-render its detail fields.
      memcpy(g_lastBody, body.c_str(), body.length());
      g_lastLen = body.length();
    }
    g_state = next;
  }
  http.end();

  const usage::PanelKind kind = usage::classifyPanel(g_state);
  renderStateChrome(kind);
  if (g_state.hasValue && g_lastLen > 0) renderTiles(g_lastBody, g_lastLen);
}

void setup() {
  Serial.begin(115200);
  display_init();
  wifi_connect();
}

void loop() {
  static uint32_t last_poll = 0;
  lv_timer_handler();
  uint32_t nowMs = millis();
  if (nowMs - last_poll >= POLL_INTERVAL_MS || last_poll == 0) {
    last_poll = nowMs;
    poll_once();
  }
  delay(5);
}
