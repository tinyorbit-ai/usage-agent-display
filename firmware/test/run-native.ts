/**
 * Compiles and runs the off-device firmware unit test (firmware/test/native) with
 * clang++, using the vendored ArduinoJson single-header. This is the AUTOMATED half
 * of the firmware gate — it exercises the real fetch/parse/state code on the host so
 * a regression fails CI without a board attached. (The on-device A→B live update is
 * the separate manual build-log entry.)
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const here = new URL(".", import.meta.url).pathname;
const repo = join(here, "..", "..");
const source = join(here, "native", "test_usage_state.cpp");
const vendor = join(repo, "firmware", "vendor");

const tmp = mkdtempSync(join(tmpdir(), "usage-fw-"));
const binary = join(tmp, "test_usage_state");

try {
  const compile = Bun.spawnSync(
    ["clang++", "-std=c++17", "-O1", "-Wall", "-Wextra", `-I${vendor}`, source, "-o", binary],
    { stdout: "pipe", stderr: "pipe" },
  );
  if (compile.exitCode !== 0) {
    process.stderr.write("firmware native test failed to COMPILE:\n");
    process.stderr.write(compile.stderr.toString());
    process.exit(1);
  }

  const run = Bun.spawnSync([binary], { stdout: "pipe", stderr: "pipe" });
  process.stdout.write(run.stdout.toString());
  if (run.exitCode !== 0) {
    process.stderr.write(run.stderr.toString());
    process.stderr.write("\nfirmware native test FAILED\n");
    process.exit(1);
  }
  process.stdout.write("firmware native test passed\n");
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
