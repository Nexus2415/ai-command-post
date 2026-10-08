import { test } from "node:test";
import assert from "node:assert/strict";
import { makePerplexityHandoff, startPerplexityComputer, PERPLEXITY_CONNECTION } from "../src/perplexity-computer-connector.mjs";

test("packages a public/synthetic research task without executing it", () => {
  const result = makePerplexityHandoff({ issue: "ARN-63", text: "Research safe triggers", dataClassification: "synthetic-or-public" });
  assert.equal(result.ok, true);
  assert.equal(result.status, "awaiting-native-automation-setup");
  assert.equal(result.issueUrl, "https://linear.app/arnexyia/issue/arn-63");
  assert.equal(result.remoteExecutionReady, false);
  assert.equal(result.triggerTransport, "perplexity-native-linear-event-automation");
  assert.deepEqual(result.requiredVerification, ["owner-configured automation", "scoped Linear authorization", "real event-delivery test", "usage limits"]);
  assert.match(result.instruction, /Sign — Perplexity Computer/);
});

test("refuses client/unknown data and malformed issue ids", () => {
  for (const dataClassification of ["client", "unknown", undefined]) {
    assert.equal(makePerplexityHandoff({ issue: "ARN-63", text: "Research", dataClassification }).ok, false);
  }
  for (const issue of ["", "OTHER-11", "ARN-0", "ARN-63; rm -rf x"]) {
    assert.equal(makePerplexityHandoff({ issue, text: "Research", dataClassification: "synthetic-or-public" }).ok, false);
  }
  assert.equal(makePerplexityHandoff({ issue: "ARN-63", text: "x".repeat(4001), dataClassification: "synthetic-or-public" }).ok, false);
});

test("remote execution always fails closed, independent of supplied options", async () => {
  for (const options of [{}, { enabled: true, apiKey: "synthetic" }, { paidApproved: true }]) {
    const result = await startPerplexityComputer({ issue: "ARN-63" }, options);
    assert.deepEqual(result, {
      ok: false, status: "unsupported", retry: false, remoteExecutionReady: false,
      reason: "No supported, authenticated remote Perplexity Computer execution trigger has been verified.",
    });
  }
  assert.equal(PERPLEXITY_CONNECTION.paidApiAuthorized, false);
  assert.equal(PERPLEXITY_CONNECTION.remoteExecutionReady, false);
});
