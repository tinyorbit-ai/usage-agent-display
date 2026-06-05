// machine_id provenance: explicit wins; hostname-derived fallback strips `.local`;
// collision-prone values are refused so two machines can't silently merge.
import { describe, expect, test } from "bun:test";
import { ConfigError, hostnameMachineId, loadConfig, parseCommand, resolveMachineId } from "../src/config.ts";

describe("resolveMachineId", () => {
  test("explicit id wins over hostname", () => {
    expect(resolveMachineId("mbp-14", "studio.local")).toBe("mbp-14");
  });

  test("falls back to a hostname-derived id, stripping .local and lowercasing", () => {
    expect(resolveMachineId(undefined, "Studio.local")).toBe("studio");
    expect(hostnameMachineId("Matts-MacBook-Pro.local")).toBe("matts-macbook-pro");
  });

  test("refuses bare localhost (a value two machines could collide on)", () => {
    expect(() => resolveMachineId(undefined, "localhost")).toThrow(ConfigError);
    expect(() => resolveMachineId("", "localhost")).toThrow(ConfigError);
    expect(() => resolveMachineId(undefined, "")).toThrow(ConfigError);
  });

  test("whitespace-only explicit id is treated as absent and falls back", () => {
    expect(resolveMachineId("   ", "studio")).toBe("studio");
  });
});

describe("loadConfig", () => {
  const base = {
    USAGE_MACHINE_ID: "mbp-14",
    USAGE_SERVER_URL: "http://server:8080/",
    USAGE_BEARER_TOKEN: "secret",
  } as NodeJS.ProcessEnv;

  test("loads a full config and trims the trailing slash from the URL", () => {
    const cfg = loadConfig({ ...base });
    expect(cfg.machineId).toBe("mbp-14");
    expect(cfg.serverUrl).toBe("http://server:8080");
    expect(cfg.provider).toBe("claude-code");
    expect(cfg.intervalMs).toBe(30_000);
  });

  test("missing server url throws ConfigError", () => {
    expect(() => loadConfig({ USAGE_MACHINE_ID: "m", USAGE_BEARER_TOKEN: "s" })).toThrow(ConfigError);
  });

  test("missing token throws ConfigError", () => {
    expect(() => loadConfig({ USAGE_MACHINE_ID: "m", USAGE_SERVER_URL: "http://s" })).toThrow(ConfigError);
  });

  test("a sub-second interval is rejected", () => {
    expect(() => loadConfig({ ...base, USAGE_INTERVAL_SECONDS: "0" })).toThrow(ConfigError);
  });

  test("USAGE_CCUSAGE_CMD defaults to pinned ccusage and overrides via env", () => {
    expect(loadConfig({ ...base }).ccusageCommand).toEqual(["bunx", "ccusage"]);
    expect(loadConfig({ ...base, USAGE_CCUSAGE_CMD: "bun run stub.ts" }).ccusageCommand).toEqual(["bun", "run", "stub.ts"]);
  });
});

describe("parseCommand", () => {
  test("whitespace-splits a plain string", () => {
    expect(parseCommand("bunx ccusage", ["x"])).toEqual(["bunx", "ccusage"]);
  });

  test("a JSON array preserves args/paths containing spaces", () => {
    expect(parseCommand('["bun","run","/a b/x.ts"]', ["x"])).toEqual(["bun", "run", "/a b/x.ts"]);
  });

  test("empty/undefined falls back", () => {
    expect(parseCommand(undefined, ["bunx", "ccusage"])).toEqual(["bunx", "ccusage"]);
    expect(parseCommand("   ", ["bunx", "ccusage"])).toEqual(["bunx", "ccusage"]);
  });

  test("malformed JSON array throws", () => {
    expect(() => parseCommand("[not json", ["x"])).toThrow(ConfigError);
    expect(() => parseCommand("[]", ["x"])).toThrow(ConfigError);
    expect(() => parseCommand('[1,2]', ["x"])).toThrow(ConfigError);
  });
});
