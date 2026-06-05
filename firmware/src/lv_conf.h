// lv_conf.h — minimal LVGL 8.x configuration for the CYD. Only the options this
// project relies on are set; everything else falls back to LVGL's internal defaults
// (lv_conf_internal.h applies a default for every option we don't define here).
// Enabled via build flag -DLV_CONF_INCLUDE_SIMPLE in platformio.ini.
#pragma once

#include <stdint.h>

// 16-bit color, byte-swapped for SPI displays driven by TFT_eSPI.
#define LV_COLOR_DEPTH 16
#define LV_COLOR_16_SWAP 1

// Static memory pool for LVGL objects (KB). 48K is comfortable for phase-1 UI.
#define LV_MEM_CUSTOM 0
#define LV_MEM_SIZE (48U * 1024U)

// Tick + refresh.
#define LV_TICK_CUSTOM 1
#define LV_TICK_CUSTOM_INCLUDE "Arduino.h"
#define LV_TICK_CUSTOM_SYS_TIME_EXPR (millis())
#define LV_DISP_DEF_REFR_PERIOD 30

// Fonts: the small default plus the large hero font used by main.cpp.
#define LV_FONT_MONTSERRAT_14 1
#define LV_FONT_MONTSERRAT_28 1
#define LV_FONT_DEFAULT &lv_font_montserrat_14
