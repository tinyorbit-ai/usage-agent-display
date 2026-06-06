/**
 * Static check — the host-testable-core TRIPWIRE (ADR 0007 / 0015; wiki/learnings.md
 * 2026-06-06 "an architectural discipline needs a tripwire, or it erodes"). The touch
 * routing logic (routeTap / rawToScreen / touchGate) MUST live in the host-compilable
 * core (firmware/src/ui_input.h), the native suite MUST compile a test that includes
 * it, and main.cpp must NEVER redefine it. Without this guard the "pure host tests" are
 * unwritable and the gate is hollow — which is exactly how the core regressed in P7.
 *
 * Fails the build if any of these hold:
 *   1. ui_input.h is missing, or pulls in an Arduino/LVGL/SPI/WiFi include (not host-compilable);
 *   2. ui_input.h does not actually DEFINE routeTap;
 *   3. the native routing test does not #include ui_input.h;
 *   4. main.cpp DEFINES (not just calls) any routing function — it must only call ui::*.
 *
 * Run: bun run scripts/check-firmware-core.ts
 */
const root = new URL("../", import.meta.url).pathname;

const CORE = "firmware/src/ui_input.h";
const TEST = "firmware/test/native/test_ui_input.cpp";
const MAIN = "firmware/src/main.cpp";

const ROUTING_FNS = ["routeTap", "rawToScreen", "touchGate", "routeScreen"];
// A non-host include the routing core must never pull in (it would break host compilation).
const FORBIDDEN_INCLUDES = /#\s*include\s*[<"](Arduino|lvgl|TFT_eSPI|WiFi|SPI\.h|HTTPClient|XPT2046)/i;

const failures: string[] = [];

async function read(rel: string): Promise<string | null> {
  try {
    return await Bun.file(root + rel).text();
  } catch {
    return null;
  }
}

const core = await read(CORE);
if (core === null) {
  failures.push(`${CORE} is missing — the host-compilable routing core must exist`);
} else {
  if (FORBIDDEN_INCLUDES.test(core)) {
    failures.push(`${CORE} includes an Arduino/LVGL/SPI/WiFi header — the core must be host-compilable`);
  }
  // It must DEFINE routeTap (a body), not merely mention it.
  if (!/\brouteTap\s*\([^;]*\)\s*\{/.test(core)) {
    failures.push(`${CORE} does not define routeTap — the routing decision must live in the host core`);
  }
}

const test = await read(TEST);
if (test === null) {
  failures.push(`${TEST} is missing — the native suite must test the routing core`);
} else if (!/#\s*include\s*"[^"]*ui_input\.h"/.test(test)) {
  failures.push(`${TEST} does not #include ui_input.h — the test must exercise the real core, not a copy`);
}

const main = await read(MAIN);
if (main === null) {
  failures.push(`${MAIN} is missing`);
} else {
  for (const fn of ROUTING_FNS) {
    // A definition looks like `<type> fn(<args>) {`. A call is `ui::fn(` or `fn(` with
    // no trailing brace before a `;`. Flag a definition: the function name immediately
    // followed by `(`…`)` then `{`, and NOT prefixed by `ui::` (a namespaced call).
    const defRe = new RegExp(`(^|[^:\\w])${fn}\\s*\\([^;{}]*\\)\\s*\\{`, "m");
    if (defRe.test(main)) {
      failures.push(`${MAIN} appears to DEFINE ${fn} — routing must stay in ${CORE}; main.cpp may only call ui::${fn}`);
    }
  }
}

if (failures.length > 0) {
  console.error("✗ firmware host-core tripwire failed:");
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}

console.log("✓ firmware host-core intact — routing lives in ui_input.h, tested natively, not redefined in main.cpp");
