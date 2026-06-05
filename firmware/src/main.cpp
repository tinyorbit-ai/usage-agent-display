// main.cpp — ESP32-2432S028R ("Cheap Yellow Display") firmware, phase 1.
//
// Deliberately minimal: join WiFi, poll GET /usage/summary with the bearer token,
// and render the combined token total in ONE LVGL label. No tiles, no styling yet
// (phase 2). All the fetch/parse/state decisions live in usage_state.h, which is
// unit-tested off-device (firmware/test/native) — main.cpp is just I/O + rendering.
//
// Board/toolchain: ADR 0005 (ESP32-2432S028R, PlatformIO, LVGL, TFT_eSPI).
#include <Arduino.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <lvgl.h>
#include <TFT_eSPI.h>

#include "config.h"        // gitignored secrets (see config.h.example)
#include "usage_state.h"   // pure fetch/parse/state core (host-tested)

// --- Display plumbing (TFT_eSPI + LVGL) ---
static TFT_eSPI tft = TFT_eSPI();
static const uint16_t kScreenW = 320;  // landscape
static const uint16_t kScreenH = 240;
static lv_disp_draw_buf_t draw_buf;
static lv_color_t buf[kScreenW * 10];
static lv_obj_t* g_label = nullptr;

static void flush_cb(lv_disp_drv_t* drv, const lv_area_t* area, lv_color_t* pixels) {
  uint32_t w = area->x2 - area->x1 + 1;
  uint32_t h = area->y2 - area->y1 + 1;
  tft.startWrite();
  tft.setAddrWindow(area->x1, area->y1, w, h);
  tft.pushColors(reinterpret_cast<uint16_t*>(pixels), w * h, true);
  tft.endWrite();
  lv_disp_flush_ready(drv);
}

static void display_init() {
  tft.begin();
  tft.setRotation(1);  // landscape
  lv_init();
  lv_disp_draw_buf_init(&draw_buf, buf, nullptr, kScreenW * 10);

  static lv_disp_drv_t disp_drv;
  lv_disp_drv_init(&disp_drv);
  disp_drv.hor_res = kScreenW;
  disp_drv.ver_res = kScreenH;
  disp_drv.flush_cb = flush_cb;
  disp_drv.draw_buf = &draw_buf;
  lv_disp_drv_register(&disp_drv);

  lv_obj_t* scr = lv_scr_act();
  lv_obj_set_style_bg_color(scr, lv_color_black(), LV_PART_MAIN);
  g_label = lv_label_create(scr);
  lv_obj_set_style_text_color(g_label, lv_color_white(), LV_PART_MAIN);
  lv_obj_set_style_text_font(g_label, &lv_font_montserrat_28, LV_PART_MAIN);
  lv_obj_align(g_label, LV_ALIGN_CENTER, 0, 0);
  lv_label_set_text(g_label, "connecting...");
}

// Group the hero token count with thin spaces so it's legible across the room.
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

static void render(const usage::DisplayState& s) {
  char text[48];
  switch (s.kind) {
    case usage::DisplayKind::Connecting:
      lv_label_set_text(g_label, "connecting...");
      lv_obj_set_style_text_color(g_label, lv_color_hex(0x888888), LV_PART_MAIN);
      return;
    case usage::DisplayKind::Live: {
      char num[40];
      formatTokens(s.tokens, num, sizeof(num));
      snprintf(text, sizeof(text), "%s", num);
      lv_label_set_text(g_label, text);
      lv_obj_set_style_text_color(g_label, lv_color_white(), LV_PART_MAIN);
      return;
    }
    case usage::DisplayKind::Placeholder: {
      // Show the last-good value dimmed so the panel never lies about freshness.
      char num[40];
      formatTokens(s.tokens, num, sizeof(num));
      snprintf(text, sizeof(text), "%s", num);
      lv_label_set_text(g_label, text);
      lv_obj_set_style_text_color(g_label, lv_color_hex(0x555555), LV_PART_MAIN);
      return;
    }
  }
}

// --- WiFi ---
static void wifi_connect() {
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
}

// --- Polling: HTTP GET /usage/summary with the bearer token, into a FetchResult ---
static usage::DisplayState g_state;

static void poll_once() {
  if (WiFi.status() != WL_CONNECTED) {
    g_state = usage::applyFetchResult(g_state, {usage::FetchKind::NetworkError, 0, nullptr, 0});
    render(g_state);
    return;
  }

  HTTPClient http;
  http.setTimeout(4000);
  http.begin(String(API_BASE_URL) + "/usage/summary");
  http.addHeader("Authorization", String("Bearer ") + API_BEARER_TOKEN);

  int status = http.GET();
  if (status <= 0) {
    // transport-level failure (timeout, disconnect, DNS)
    g_state = usage::applyFetchResult(g_state, {usage::FetchKind::NetworkError, 0, nullptr, 0});
  } else if (status < 200 || status >= 300) {
    g_state = usage::applyFetchResult(g_state, {usage::FetchKind::HttpError, status, nullptr, 0});
  } else {
    String body = http.getString();
    usage::FetchResult r{usage::FetchKind::Ok, status, body.c_str(),
                         static_cast<size_t>(body.length())};
    g_state = usage::applyFetchResult(g_state, r);
  }
  http.end();
  render(g_state);
}

void setup() {
  Serial.begin(115200);
  display_init();
  wifi_connect();
}

void loop() {
  static uint32_t last_poll = 0;
  lv_timer_handler();  // keep LVGL ticking

  uint32_t nowMs = millis();
  if (nowMs - last_poll >= POLL_INTERVAL_MS || last_poll == 0) {
    last_poll = nowMs;
    poll_once();
  }
  delay(5);
}
