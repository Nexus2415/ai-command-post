import assert from "node:assert/strict";
import { test } from "node:test";
import { geminiClient, ProviderError, setRetryDelays } from "../src/providers.ts";

const ok = { candidates: [{ content: { parts: [{ text: "hi" }] } }] };

function fake(statuses: number[]) {
  let n = 0;
  const f = (async () => {
    const s = statuses[Math.min(n++, statuses.length - 1)]!;
    return new Response(JSON.stringify(s === 200 ? ok : { error: "busy" }), { status: s });
  }) as unknown as typeof fetch;
  return { f, calls: () => n };
}

test("busy free-tier answers are retried before failing", async () => {
  setRetryDelays([0, 0]);
  const flaky = fake([503, 429, 200]);
  assert.ok(await geminiClient("k", "m", flaky.f).chat([{ role: "user", content: "x" }], { maxOutputTokens: 10 }));
  assert.equal(flaky.calls(), 3);

  const down = fake([503]);
  await assert.rejects(geminiClient("k", "m", down.f).chat([{ role: "user", content: "x" }], { maxOutputTokens: 10 }), ProviderError);
  assert.equal(down.calls(), 3);

  const bad = fake([400]);
  await assert.rejects(geminiClient("k", "m", bad.f).chat([{ role: "user", content: "x" }], { maxOutputTokens: 10 }), ProviderError);
  assert.equal(bad.calls(), 1);
});
