# Bundled font attribution

**Silkscreen** — © Jason Kottke. Licensed under the SIL Open Font License 1.1
(https://openfontlicense.org). Source: https://fonts.google.com/specimen/Silkscreen.

The display fonts in `firmware/src/fonts/pixel{8,16,24,40}.c` are generated from
`Silkscreen-Regular.ttf` (and `-Bold.ttf`) with `lv_font_conv` at 1bpp:

```sh
npx lv_font_conv --font vendor/fonts/Silkscreen-Regular.ttf --size <N> --bpp 1 \
  --format lvgl --lv-font-name pixel<N> --range 0x20-0x7E -o src/fonts/pixel<N>.c \
  --no-compress --force-fast-kern-format
```

Sizes: pixel8/16/24 from Regular, pixel40 from Regular (Bold's "4" counter fills in at
40px). The OFL permits this embedding and redistribution; this NOTICE preserves the
required attribution.
