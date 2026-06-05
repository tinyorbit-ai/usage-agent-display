// Security gate: the bearer token is NEVER logged. We drive real requests (valid,
// invalid, and unauthorized) through the app and assert the secret never appears in
// any captured log line, and that Authorization headers are redacted.
import { describe, expect, test } from "bun:test";
import { redact, redactValue } from "../src/log.ts";
import { authedPost, getSummary, makeHarness, payload, row, summaryRequest, TOKEN } from "./helpers.ts";

describe("the bearer token never reaches the logs", () => {
  test("no log line contains the token across valid/invalid/unauth requests", async () => {
    const h = makeHarness();

    await h.app.fetch(authedPost(payload("mbp-14", [row({ tokens: 100 })]))); // valid → info
    await h.app.fetch(authedPost(payload("mbp-14", [row({ tokens: -1 })]))); // invalid → warn
    await h.app.fetch(authedPost(payload("mbp-14", [row()]), "bad")); // unauthorized
    await h.app.fetch(summaryRequest());

    expect(await getSummary(h)).toBeDefined();
    const joined = h.logs.join("\n");
    expect(joined).not.toContain(TOKEN);
    expect(joined).not.toContain("bad"); // the wrong token isn't logged either
  });

  test("redact strips Bearer tokens and Authorization headers", () => {
    expect(redact("got Authorization: Bearer abc.def-123")).not.toContain("abc.def-123");
    expect(redact(`{"authorization":"Bearer secret"}`)).not.toContain("secret");
  });

  test("redactValue scrubs an Authorization key in a structured object", () => {
    const scrubbed = redactValue({ authorization: "Bearer hunter2", other: "ok" }) as Record<string, unknown>;
    expect(scrubbed.authorization).toBe("<redacted>");
    expect(scrubbed.other).toBe("ok");
  });
});
