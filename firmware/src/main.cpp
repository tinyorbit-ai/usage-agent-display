// main.cpp — ESP32-2432S028R ("Cheap Yellow Display") — LIVE panel (phase 7).
//
// Renders the locked "C2 · Daily Rate" design from real /usage/summary data:
//   timeframe tabs (tap to cycle TODAY/30D/ALL) · big green hero · amber cost run-rate ·
//   named agent rows · tokens/day-14d bar graph · last-used + sync footer.
//
// Networking + JSON live here; the visual layout is unchanged from the static preview.
// Tabs cycle on ANY touch via the XPT2046 PENIRQ line (GPIO36, active-low) — no touch
// calibration needed. Crisp 1bpp Silkscreen pixel fonts (src/fonts/pixel*.c).
#include <Arduino.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <lvgl.h>
#include <TFT_eSPI.h>

#include "config.h"  // gitignored: WIFI_SSID/PASSWORD, API_BASE_URL, API_BEARER_TOKEN, POLL_INTERVAL_MS

LV_FONT_DECLARE(pixel8);   // tabs, graph labels, footer (small meta)
LV_FONT_DECLARE(pixel16);  // agent rows, sublabels
LV_FONT_DECLARE(pixel24);  // cost
LV_FONT_DECLARE(pixel40);  // hero

static TFT_eSPI tft = TFT_eSPI();
static const uint16_t kScreenW = 320;
static const uint16_t kScreenH = 240;
static lv_disp_draw_buf_t draw_buf;
static lv_color_t buf[kScreenW * 10];

#define TOUCH_IRQ 36  // XPT2046 PENIRQ — idles high, pulled low while touched

// --- palette ---
static const uint32_t kBg = 0x0A0E14, kCard = 0x11161F, kBorder = 0x222B3A;
static const uint32_t kHero = 0x7EE787, kCost = 0xFFD479, kDim = 0x8B98A8, kFaint = 0x5B6675;
static const uint32_t kClaude = 0xA78BFA, kCodex = 0x56D4DD, kGemini = 0xF0883E;
static const uint32_t kSegOn = 0x06210D, kWhite = 0xE6EDF3;

// One timeframe's live numbers.
struct TfData {
  long long tokens = 0;
  double cost = 0;
  int days = 0;
  long long claude = 0, codex = 0, gemini = 0;
};
static TfData g_data[3];                       // [today, d30, all]
static long g_daily[14];                       // tokens/day (millions not needed; raw, autoscaled)
static int g_dailyN = 0;
static char g_month[24] = "";                  // graph right label (month-to-date)
static char g_lastUsed[28] = "";               // footer left
static char g_sync[16] = "connecting";         // footer right
static bool g_haveData = false;
static int g_tf = 1;                            // start 30d

// Live label/handles updated on poll + tab change.
static lv_obj_t* g_hero = nullptr;
static lv_obj_t* g_cost = nullptr;
static lv_obj_t* g_rate = nullptr;
static lv_obj_t* g_agentVal[3] = {nullptr, nullptr, nullptr};
static lv_obj_t* g_monthLbl = nullptr;
static lv_obj_t* g_footL = nullptr;
static lv_obj_t* g_footR = nullptr;
static lv_obj_t* g_tabHi[3] = {nullptr, nullptr, nullptr};
static lv_obj_t* g_tabLabel[3] = {nullptr, nullptr, nullptr};
static lv_obj_t* g_chart = nullptr;
static lv_chart_series_t* g_series = nullptr;
static const lv_coord_t kAgentY[3] = {98, 120, 142};

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

// Render the active timeframe from g_data (and footer/graph from the shared fields).
static void renderActive() {
  for (int i = 0; i < 3; i++) {
    if (i == g_tf) lv_obj_clear_flag(g_tabHi[i], LV_OBJ_FLAG_HIDDEN);
    else lv_obj_add_flag(g_tabHi[i], LV_OBJ_FLAG_HIDDEN);
    lv_obj_set_style_text_color(g_tabLabel[i], lv_color_hex(i == g_tf ? kSegOn : kFaint), LV_PART_MAIN);
  }
  const TfData& d = g_data[g_tf];
  char b[24];
  if (!g_haveData) { lv_label_set_text(g_hero, "--"); }
  else { humanize(d.tokens, b, sizeof(b)); lv_label_set_text(g_hero, b); }

  snprintf(b, sizeof(b), "$%lld", (long long)llround(d.cost));
  lv_label_set_text(g_cost, b);
  alignRight(g_cost, 312, 36);

  if (g_tf == 0) snprintf(b, sizeof(b), "today");
  else if (d.days > 0) snprintf(b, sizeof(b), "$%lld/day", (long long)llround(d.cost / d.days));
  else snprintf(b, sizeof(b), " ");
  lv_label_set_text(g_rate, b);
  alignRight(g_rate, 312, 74);

  const long long vals[3] = {d.claude, d.codex, d.gemini};
  for (int i = 0; i < 3; i++) {
    humanize(vals[i], b, sizeof(b));
    lv_label_set_text(g_agentVal[i], b);
    alignRight(g_agentVal[i], 312, kAgentY[i]);
  }

  lv_label_set_text(g_monthLbl, g_month);
  alignRight(g_monthLbl, 312, 166);
  lv_label_set_text(g_footL, g_lastUsed);
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
  lv_obj_t* tag = mkLabel(scr, 0, 12, &pixel8, kFaint, "ALL AGENTS");
  alignRight(tag, 312, 12);

  g_hero = mkLabel(scr, 10, 30, &pixel40, kHero, "--");
  mkLabel(scr, 12, 74, &pixel16, kDim, "tokens");
  g_cost = mkLabel(scr, 0, 36, &pixel24, kCost, "");
  g_rate = mkLabel(scr, 0, 74, &pixel16, kFaint, "");

  const char* names[3] = {"CLAUDE", "CODEX", "GEMINI"};
  const uint32_t cols[3] = {kClaude, kCodex, kGemini};
  for (int i = 0; i < 3; i++) {
    mkDot(scr, 12, kAgentY[i] + 4, cols[i]);
    mkLabel(scr, 28, kAgentY[i], &pixel16, cols[i], names[i]);
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

static void updateGraph() {
  if (!g_series || g_dailyN == 0) return;
  long maxV = 1;
  for (int i = 0; i < g_dailyN; i++) if (g_daily[i] > maxV) maxV = g_daily[i];
  lv_chart_set_point_count(g_chart, g_dailyN);
  lv_chart_set_range(g_chart, LV_CHART_AXIS_PRIMARY_Y, 0, (lv_coord_t)maxV);
  for (int i = 0; i < g_dailyN; i++)
    lv_chart_set_next_value(g_chart, g_series, (lv_coord_t)g_daily[i]);
  lv_chart_refresh(g_chart);
}

// Pull tokens for a named provider out of a by_provider array.
static long long providerTokens(JsonArrayConst arr, const char* name) {
  for (JsonObjectConst p : arr)
    if (strcmp(p["provider"] | "", name) == 0) return p["tokens"] | 0LL;
  return 0;
}
static void fillTf(JsonObjectConst tf, TfData& d) {
  d.tokens = tf["tokens"] | 0LL;
  d.cost = tf["cost_usd"] | 0.0;
  d.days = tf["days"] | 0;
  JsonArrayConst bp = tf["by_provider"];
  d.claude = providerTokens(bp, "claude-code");
  d.codex = providerTokens(bp, "codex");
  d.gemini = providerTokens(bp, "gemini");
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
  String body = http.getString();
  http.end();

  JsonDocument doc;
  if (deserializeJson(doc, body)) { snprintf(g_sync, sizeof(g_sync), "parse"); return false; }
  JsonObjectConst tfs = doc["timeframes"];
  fillTf(tfs["today"], g_data[0]);
  fillTf(tfs["d30"], g_data[1]);
  fillTf(tfs["all"], g_data[2]);

  JsonArrayConst daily = doc["daily"];
  g_dailyN = 0;
  for (JsonObjectConst pt : daily) { if (g_dailyN >= 14) break; g_daily[g_dailyN++] = pt["tokens"] | 0L; }

  char mtok[16];
  humanize((long long)(doc["month"]["tokens"] | 0LL), mtok, sizeof(mtok));
  snprintf(g_month, sizeof(g_month), "MONTH %s", mtok);

  if (!doc["last_used"].isNull()) {
    char age[12];
    fmtAge((long)(doc["last_used"]["age_seconds"] | 0L), age, sizeof(age));
    const char* p = doc["last_used"]["provider"] | "";
    snprintf(g_lastUsed, sizeof(g_lastUsed), "LAST USED %s %s", p, age);
  } else if (!doc["active_machine"].isNull()) {
    snprintf(g_lastUsed, sizeof(g_lastUsed), "ACTIVE %s", doc["active_machine"] | "");
  } else {
    g_lastUsed[0] = '\0';
  }

  if (!doc["last_sync"].isNull()) {
    char age[12];
    fmtAge((long)(doc["last_sync"]["age_seconds"] | 0L), age, sizeof(age));
    snprintf(g_sync, sizeof(g_sync), "SYNC %s", age);
  } else {
    snprintf(g_sync, sizeof(g_sync), "SYNC --");
  }

  g_haveData = true;
  updateGraph();
  return true;
}

void setup() {
  Serial.begin(115200);
  pinMode(TOUCH_IRQ, INPUT);
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
  uint32_t now = millis();
  if (lastPoll == 0 || now - lastPoll >= POLL_INTERVAL_MS) {
    lastPoll = now;
    poll();
    renderActive();
  }

  // Tap-to-cycle the timeframe (PENIRQ falling edge, debounced).
  static bool wasTouched = false;
  static uint32_t lastTap = 0;
  bool touched = (digitalRead(TOUCH_IRQ) == LOW);
  if (touched && !wasTouched && (now - lastTap) > 250) {
    lastTap = now;
    g_tf = (g_tf + 1) % 3;
    renderActive();
  }
  wasTouched = touched;

  delay(5);
}
