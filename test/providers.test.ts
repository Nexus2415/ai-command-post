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
  { name: "openai", make: (f: typeof fetch) => chatCompletionsClient("openai", "https://api.openai.com/v1", "synthetic-key", "synthetic-model", f), ok: { id: "synthetic-response", model: "synthetic-model", choices: [{ message: { content: "done" }, finish_reason: "stop" }], usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 } } },
  { name: "anthropic", make: (f: typeof fetch) => anthropicClient("synthetic-key", "synthetic-model", f), ok: { id: "synthetic-response", model: "synthetic-model", content: [{ type: "text", text: "done" }], stop_reason: "end_turn", usage: { input_tokens: 8, output_tokens: 3 } } },
  { name: "perplexity", make: (f: typeof fetch) => chatCompletionsClient("perplexity", "https://api.perplexity.ai", "synthetic-key", "synthetic-model", f), ok: { id: "synthetic-response", model: "synthetic-model", choices: [{ message: { content: "done" }, finish_reason: "stop" }], usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 } } },
];
const messages = [{ role: "user" as const, content: "synthetic task" }];
for (const provider of metered) {
  test(provider.name + " issues at most one request per admitted model call", async () => {
    setRetryDelays([0, 0]);
    for (const status of [429, 500, 502, 503, 504, 529, 400, 307]) {
      let count = 0;
      const f: typeof fetch = async (_input, init) => {
        count++;
        assert.equal(init?.redirect, "error");
        return new Response(JSON.stringify(count === 1 ? { error: "synthetic" } : provider.ok), { status: count === 1 ? status : 200 });
      };
      await assert.rejects(provider.make(f).chat(messages, { maxOutputTokens: 10 }), ProviderError);
      assert.equal(count, 1, "no hidden retry for status " + status);
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


test("metered responses require identity and real, bounded, consistent usage; malformed success never retried", async()=>{
  for(const p of metered){
    const original=structuredClone(p.ok);
    for(const change of [(x:any)=>delete x.usage,(x:any)=>delete x.id,(x:any)=>delete x.model,(x:any)=>{x.model="";},(x:any)=>{x.usage=p.name==="anthropic"?{input_tokens:-1,output_tokens:1}:{prompt_tokens:1,completion_tokens:-1,total_tokens:0};},(x:any)=>{x.usage=p.name==="anthropic"?{input_tokens:1,output_tokens:11}:{prompt_tokens:1,completion_tokens:11,total_tokens:12};},(x:any)=>{x.usage=p.name==="anthropic"?{input_tokens:"8",output_tokens:3}:{prompt_tokens:"8",completion_tokens:3,total_tokens:11};}]){
      const malformed=structuredClone(original);change(malformed);let count=0;
      await assert.rejects(p.make(async()=>{count++;return Response.json(malformed);}).chat(messages,{maxOutputTokens:10}),ProviderError);
      assert.equal(count,1);
    }
    const out=await p.make(async()=>Response.json({...original,model:"reported-model"})).chat(messages,{maxOutputTokens:10});
    assert.equal(out.reportedUsage?.reportedModel,"reported-model");
    assert.equal(out.reportedUsage?.requestedModel,"synthetic-model");
    assert.equal(out.reportedUsage?.responseId,"synthetic-response");
    if(p.name!=="anthropic"){
      await assert.rejects(p.make(async()=>Response.json({...original,usage:{prompt_tokens:8,completion_tokens:3,total_tokens:2}})).chat(messages,{maxOutputTokens:10}),ProviderError);
      await assert.rejects(p.make(async()=>Response.json({...original,usage:{prompt_tokens:8,completion_tokens:3,total_tokens:11,prompt_tokens_details:{cached_tokens:9}}})).chat(messages,{maxOutputTokens:10}),ProviderError);
    }
  }
});
test("Anthropic cache categories count toward total input, and OpenAI reasoning is already included in output",async()=>{
  const a=await metered[1]!.make(async()=>Response.json({...metered[1]!.ok,usage:{input_tokens:8,output_tokens:3,cache_creation_input_tokens:4,cache_read_input_tokens:5}})).chat(messages,{maxOutputTokens:10});
  assert.equal(a.inputTokens,17);assert.equal(a.reportedUsage?.cacheWriteTokens,4);assert.equal(a.reportedUsage?.cacheReadTokens,5);
  const o=await metered[0]!.make(async()=>Response.json({...metered[0]!.ok,usage:{prompt_tokens:8,completion_tokens:3,total_tokens:11,prompt_tokens_details:{cached_tokens:4},completion_tokens_details:{reasoning_tokens:2}}})).chat(messages,{maxOutputTokens:10});
  assert.equal(o.inputTokens,8);assert.equal(o.outputTokens,3);assert.equal(o.reportedUsage?.reasoningTokens,2);
});
