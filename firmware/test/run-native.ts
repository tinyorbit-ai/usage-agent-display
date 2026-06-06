/**
 * Compiles and runs the off-device firmware unit tests (firmware/test/native) with
 * clang++, using the vendored ArduinoJson single-header. This is the AUTOMATED half
 * of the firmware gate — it exercises the real fetch/parse/state code AND the touch
 * routing core on the host so a regression fails CI without a board attached. (The
 * on-device live confirmations are separate manual build-log entries.)
 *
 * Each suite is its own translation unit with its own main(); both must pass.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const here = new URL(".", import.meta.url).pathname;
const repo = join(here, "..", "..");
const vendor = join(repo, "firmware", "vendor");

const suites = [
  { name: "usage_state (fetch/parse/state)", source: join(here, "native", "test_usage_state.cpp") },
  { name: "ui_input (touch routing)", source: join(here, "native", "test_ui_input.cpp") },
  { name: "agent_filter (parse + selection)", source: join(here, "native", "test_agent_filter.cpp") },
];

const tmp = mkdtempSync(join(tmpdir(), "usage-fw-"));

try {
  for (const suite of suites) {
    const binary = join(tmp, suite.name.replace(/[^a-z0-9]+/gi, "_"));
    const compile = Bun.spawnSync(
      ["clang++", "-std=c++17", "-O1", "-Wall", "-Wextra", `-I${vendor}`, suite.source, "-o", binary],
      { stdout: "pipe", stderr: "pipe" },
    );
    if (compile.exitCode !== 0) {
      process.stderr.write(`firmware native test [${suite.name}] failed to COMPILE:\n`);
      process.stderr.write(compile.stderr.toString());
      process.exit(1);
    }

    const run = Bun.spawnSync([binary], { stdout: "pipe", stderr: "pipe" });
    process.stdout.write(run.stdout.toString());
    if (run.exitCode !== 0) {
      process.stderr.write(run.stderr.toString());
      process.stderr.write(`\nfirmware native test [${suite.name}] FAILED\n`);
      process.exit(1);
    }
  }
  process.stdout.write("firmware native tests passed\n");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
