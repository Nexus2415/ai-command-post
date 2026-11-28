import assert from "node:assert/strict";
import { test } from "node:test";
import { anthropicClient, chatCompletionsClient, geminiClient, ProviderError, setRetryDelays } from "../src/providers.ts";

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


const metered = [
  { name: "openai", make: (f: typeof fetch) => chatCompletionsClient("openai", "https://api.openai.com/v1", "synthetic-key", "synthetic-model", f), ok: { choices: [{ message: { content: "done" }, finish_reason: "stop" }], usage: { prompt_tokens: 8, completion_tokens: 3 } } },
  { name: "anthropic", make: (f: typeof fetch) => anthropicClient("synthetic-key", "synthetic-model", f), ok: { content: [{ type: "text", text: "done" }], stop_reason: "end_turn", usage: { input_tokens: 8, output_tokens: 3 } } },
  { name: "perplexity", make: (f: typeof fetch) => chatCompletionsClient("perplexity", "https://api.perplexity.ai", "synthetic-key", "synthetic-model", f), ok: { choices: [{ message: { content: "done" }, finish_reason: "stop" }], usage: { prompt_tokens: 8, completion_tokens: 3 } } },
];
const messages = [{ role: "user" as const, content: "synthetic task" }];
for (const provider of metered) {
  test(provider.name + " never repeats a request the provider may have processed; waits out busy answers", async () => {
    setRetryDelays([0, 0]);
    for (const status of [500, 502, 503, 504, 400, 307]) {
      let count = 0;
      const f: typeof fetch = async (_input, init) => {
        count++;
        assert.equal(init?.redirect, "error");
        return new Response(JSON.stringify(count === 1 ? { error: "synthetic" } : provider.ok), { status: count === 1 ? status : 200 });
      };
      await assert.rejects(provider.make(f).chat(messages, { maxOutputTokens: 10 }), ProviderError);
      assert.equal(count, 1, "no hidden retry for status " + status);
    }
    // Busy answers (429 rate limited, 529 overloaded) are refused unbilled: wait and ask again.
    for (const status of [429, 529]) {
      let count = 0;
      const busyOnce: typeof fetch = async (_input, init) => {
        count++;
        assert.equal(init?.redirect, "error");
        return new Response(JSON.stringify(count === 1 ? { error: "busy" } : provider.ok), { status: count === 1 ? status : 200 });
      };
      const out = await provider.make(busyOnce).chat(messages, { maxOutputTokens: 10 });
      assert.equal(out.text, "done");
      assert.equal(count, 2, "one retry after busy status " + status);
      let tries = 0;
      const alwaysBusy: typeof fetch = async () => { tries++; return new Response("{}", { status }); };
      await assert.rejects(provider.make(alwaysBusy).chat(messages, { maxOutputTokens: 10 }), ProviderError);
      assert.equal(tries, 3, "busy retries stop after the set delays");
    }
    let count = 0;
    const lost: typeof fetch = async () => { count++; throw new Error("synthetic response lost"); };
    await assert.rejects(provider.make(lost).chat(messages, { maxOutputTokens: 10 }), /synthetic response lost/);
    assert.equal(count, 1);
    const malformed: typeof fetch = async () => { count++; return new Response("{broken", { status: 200 }); };
    await assert.rejects(provider.make(malformed).chat(messages, { maxOutputTokens: 10 }), ProviderError);
    assert.equal(count, 2, "malformed success is not retried");
    const success: typeof fetch = async (_input, init) => {
      count++;
      assert.equal(init?.redirect, "error");
      return Response.json(provider.ok);
    };
    const out = await provider.make(success).chat(messages, { maxOutputTokens: 10 });
    assert.equal(out.text, "done");
    assert.equal(out.inputTokens, 8);
    assert.equal(out.outputTokens, 3);
    assert.equal(count, 3);
  });
}
