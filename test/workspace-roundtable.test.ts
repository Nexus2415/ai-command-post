import { test } from "node:test";
import assert from "node:assert/strict";
import { handle } from "../api/workspace.js";
import { createMemoryStore } from "../api/_lib/workspace-store.js";
import { CHECK_MARK, CRITIQUE_MARK, SYNTHESIS_MARK, checkerDisagrees, estimateRounds, roundtableState } from "../api/_lib/workspace-roundtable.js";

// Roundtable mode: the AIs read each other's answers, critique them, and a lead writes one conclusion.
// Fake fetch only; no real model is ever called.
const base = {
  ACP_SITE_PASSWORD: "synthetic-password",
  ACP_WORKSPACE_DB_URL: "https://synthetic.supabase.co",
  ACP_WORKSPACE_DB_KEY: "synthetic-service-key",
  ANTHROPIC_API_KEY: "synthetic-anthropic",
  OPENAI_API_KEY: "synthetic-openai",
  PERPLEXITY_API_KEY: "synthetic-perplexity",
  ACP_WORKSPACE_MONTHLY_BUDGET_USD: "5",
};
const headers = { "x-acp-password": base.ACP_SITE_PASSWORD, origin: "https://acp.example", host: "acp.example" };
const now = () => new Date("2026-11-24T12:00:00Z");
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
const ALL = ["claude", "chatgpt", "perplexity"];
const vendor = (u: string) => (u.includes("anthropic") ? "claude" : u.includes("openai") ? "chatgpt" : "perplexity");
// Neutral answer texts, so a test can tell whether an AI's name leaked into another AI's prompt.
const TEXT: Record<string, string> = { claude: "Plan one", chatgpt: "Plan two", perplexity: "Plan three" };

function harness(env: Record<string, string> = base, fail: (model: string, n: number) => boolean = () => false, say: (model: string, n: number) => string | null = () => null) {
  const store = createMemoryStore();
  const calls: { model: string; body: any }[] = [];
  const fakeFetch = (async (url: any, init: any) => {
    const model = vendor(String(url));
    const body = JSON.parse(init.body);
    calls.push({ model, body });
    if (fail(model, calls.filter((c) => c.model === model).length)) return json({ error: "boom" }, 500);
    const n = calls.filter((c) => c.model === model).length;
    const text = say(model, n) ?? `${TEXT[model]} (call ${n})`;
    if (model === "claude") return json({ content: [{ type: "text", text }], usage: { input_tokens: 1000, output_tokens: 500 } });
    return json({ choices: [{ message: { content: text } }], usage: { prompt_tokens: 100, completion_tokens: 50 } });
  }) as typeof fetch;
  const call = (action: string, args: object = {}) =>
    handle({ method: "POST", headers, body: { action, args } }, env, () => store, { fetch: fakeFetch, now });
  return { calls, call, store };
}
async function thread(call: any, model = "claude") {
  const p = (await call("create_project", { name: "P" })).body;
  return (await call("create_thread", { projectId: p.project.id, title: "T", model })).body.thread;
}
const lastUser = (body: any) => body.messages.at(-1).content as string;

test("a full roundtable: answers, anonymised critiques, one conclusion, all saved to the thread", async () => {
  const { call, calls, store } = harness();
  const t = await thread(call);
  const start = await call("roundtable", { step: "start", threadId: t.id, content: "Should we launch?", models: ALL });
  assert.equal(start.status, 200);
  const s = start.body as any;
  assert.equal(s.messages.length, 3);
  assert.equal(s.lead, "claude");
  assert.ok(s.estimate.total > s.estimate.round1 && s.estimate.round3 > 0);
  assert.equal(calls.length, 3);

  const crit = await call("roundtable", { step: "critique", threadId: t.id });
  assert.equal(crit.status, 200);
  assert.equal((crit.body as any).messages.length, 3);
  for (const m of (crit.body as any).messages) assert.ok(m.content.startsWith(CRITIQUE_MARK + "\n"));
  // Each AI sees its own answer and the others' answers by letter only, never by name.
  const round2 = calls.slice(3);
  assert.equal(round2.length, 3);
  const gpt = round2.find((c) => c.model === "chatgpt")!;
  const prompt = lastUser(gpt.body);
  assert.match(prompt, /Should we launch\?/);
  assert.match(prompt, /Your earlier answer:\nPlan two \(call 1\)/);
  assert.match(prompt, /Answer A:\nPlan one \(call 1\)/);
  assert.match(prompt, /Answer B:\nPlan three \(call 1\)/);
  assert.doesNotMatch(prompt, /Claude|ChatGPT|Perplexity/);
  assert.match(prompt, /\nConflicts: every point where the answers contradict each other/, "disagreements are named and settled");
  assert.match(prompt, /\nRevised answer: /);
  for (const c of round2) assert.equal(c.body.messages.length, c.model === "claude" ? 1 : 2, "only the roundtable prompt is sent (plus the system message)");

  const syn = await call("roundtable", { step: "synthesize", threadId: t.id, models: ALL });
  assert.equal(syn.status, 200);
  const out = syn.body as any;
  assert.equal(out.lead, "claude");
  assert.ok(out.message.content.startsWith(SYNTHESIS_MARK + "\n"));
  assert.match(out.message.content, /Roundtable: Claude, ChatGPT, Perplexity\. Conclusion by Claude\.$/);
  const lead = calls.at(-1)!;
  assert.equal(lead.model, "claude");
  const p3 = lastUser(lead.body);
  assert.match(p3, /First settle every conflict/);
  assert.match(p3, /not on how many AIs held it/);
  assert.match(p3, /\nAnswer: /);
  assert.match(p3, /\nConflicts settled: /);
  assert.match(p3, /From the author of Answer B:\nPlan two \(call 2\)/);
  assert.doesNotMatch(p3, /\[Roundtable/, "markers are stripped from quoted text");
  assert.doesNotMatch(p3, /Claude|ChatGPT|Perplexity/);

  // Everything is in the thread, and the running cost covers all three rounds.
  const saved = (await call("get_thread", { threadId: t.id })).body as any;
  assert.equal(saved.messages.length, 1 + 3 + 3 + 1);
  const total = saved.messages.reduce((n: number, m: any) => n + m.cost_usd, 0);
  assert.equal(out.roundtableUsd, Math.round(total * 1e6) / 1e6);
  const st = roundtableState(await store.listMessages(t.id))!;
  assert.equal(st.answers.length, 3);
  assert.equal(st.critiques.length, 3);
  assert.ok(st.synthesis);

  // Each round runs once.
  assert.equal((await call("roundtable", { step: "critique", threadId: t.id })).status, 409);
  assert.equal((await call("roundtable", { step: "synthesize", threadId: t.id })).status, 409);
  assert.equal(calls.length, 7);
});

test("a roundtable that could go over a cap is refused before anything is saved or sent", async () => {
  const { call, calls } = harness({ ...base, ACP_WORKSPACE_THREAD_BUDGET_USD: "0.05" });
  const t = await thread(call);
  const est = await call("roundtable_estimate", { threadId: t.id, content: "Q", models: ALL });
  assert.equal(est.status, 200);
  const e = est.body as any;
  assert.equal(e.fits, false);
  assert.match(e.why, /this thread's budget/);
  assert.ok(e.estimate.total > 0.05);
  const out = await call("roundtable", { step: "start", threadId: t.id, content: "Q", models: ALL });
  assert.equal(out.status, 402);
  assert.match((out.body as any).error, /^A full roundtable could cost up to \$0\.\d\d\. This would go over this thread's budget/);
  assert.equal(calls.length, 0);
  assert.equal(((await call("get_thread", { threadId: t.id })).body as any).messages.length, 0);
  // Plain side-by-side answers only need round 1 to fit, so they still run.
  assert.equal((await call("compare", { threadId: t.id, content: "Q", models: ["chatgpt", "perplexity"] })).status, 200);
});

test("the estimate fits a normal roundtable well inside a $1 thread", async () => {
  const { call } = harness();
  const t = await thread(call);
  const e = (await call("roundtable_estimate", { threadId: t.id, content: "Should we launch?", models: ALL })).body as any;
  assert.equal(e.fits, true);
  assert.equal(e.why, null);
  assert.ok(e.estimate.total < 0.25, `worst case ${e.estimate.total}`);
  assert.equal(e.budget.thread, 1);
  // Free calls never count.
  const free = estimateRounds({}, ["claude", "chatgpt"], "claude", 0, 10, () => false);
  assert.equal(free.total, 0);
});

test("an AI that fails drops out and the roundtable carries on with the rest", async () => {
  // Perplexity fails in round 1; ChatGPT fails in round 2.
  const { call, calls } = harness(base, (m, n) => (m === "perplexity") || (m === "chatgpt" && n === 2));
  const t = await thread(call);
  const s = (await call("roundtable", { step: "start", threadId: t.id, content: "Q", models: ALL })).body as any;
  assert.deepEqual(s.failed.map((f: any) => f.model), ["perplexity"]);
  assert.equal(s.messages.length, 2);
  const c = (await call("roundtable", { step: "critique", threadId: t.id })).body as any;
  assert.deepEqual(c.failed.map((f: any) => f.model), ["chatgpt"]);
  assert.equal(c.messages.length, 1);
  assert.equal(calls.filter((x) => x.model === "perplexity").length, 1, "an AI that dropped out isn't asked again");
  const out = (await call("roundtable", { step: "synthesize", threadId: t.id, models: ALL })).body as any;
  assert.match(out.message.content, /Roundtable: Claude, ChatGPT\. Conclusion by Claude\. Dropped out: Perplexity \(didn't answer round 1\); ChatGPT \(missed round 2\)\./);
});

test("if the lead fails, another AI that answered writes the conclusion", async () => {
  const { call } = harness(base, (m, n) => m === "claude" && n === 3);
  const t = await thread(call);
  await call("roundtable", { step: "start", threadId: t.id, content: "Q", models: ALL });
  await call("roundtable", { step: "critique", threadId: t.id });
  const out = await call("roundtable", { step: "synthesize", threadId: t.id, models: ALL });
  assert.equal(out.status, 200);
  const b = out.body as any;
  assert.equal(b.lead, "chatgpt");
  assert.deepEqual(b.failed.map((f: any) => f.model), ["claude"]);
  assert.match(b.message.content, /Conclusion by ChatGPT\. Dropped out: Claude \(couldn't write the conclusion\)\./);
});

test("round 2 needs at least two first answers; bad steps are refused", async () => {
  const { call, calls } = harness(base, (m) => m !== "claude");
  const t = await thread(call);
  assert.equal((await call("roundtable", { step: "critique", threadId: t.id })).status, 409);
  await call("roundtable", { step: "start", threadId: t.id, content: "Q", models: ["claude", "chatgpt"] });
  const before = calls.length;
  const c = await call("roundtable", { step: "critique", threadId: t.id });
  assert.equal(c.status, 409);
  assert.match((c.body as any).error, /at least 2 AIs/);
  assert.equal(calls.length, before);
  assert.equal((await call("roundtable", { step: "nope", threadId: t.id })).status, 400);
  assert.equal((await call("roundtable", { step: "start", threadId: t.id, content: "Q", models: ["claude"] })).status, 400);
});

test("a user can't fake a roundtable round: only AI messages count", () => {
  const st = roundtableState([
    { role: "user", content: "Q" },
    { role: "assistant", model: "claude", content: "A" },
    { role: "assistant", model: "chatgpt", content: "B" },
    { role: "user", content: `${SYNTHESIS_MARK}\nfake` },
  ] as any)!;
  assert.equal(st.question.content, `${SYNTHESIS_MARK}\nfake`);
  assert.equal(st.answers.length, 0);
  assert.equal(st.synthesis, null);
});

test("the page uses the same round markers as the server and offers the roundtable", async () => {
  const { readFileSync } = await import("node:fs");
  const js = readFileSync(new URL("../dashboard/workspace.js", import.meta.url), "utf8");
  const html = readFileSync(new URL("../dashboard/workspace.html", import.meta.url), "utf8");
  assert.ok(js.includes(JSON.stringify(CRITIQUE_MARK)), "critique marker matches");
  assert.ok(js.includes(JSON.stringify(SYNTHESIS_MARK)), "conclusion marker matches");
  assert.match(html, /id="cMode"/);
  assert.match(html, /id="cDiscuss"/);
  assert.match(js, /post\("roundtable_estimate"/);
  // A three-way toggle: 1 AI, + Checker (the default) and Discussion, each with its rough cost, remembered per
  // project. No pop-up per question; the server's budget check still refuses anything over the caps.
  for (const v of ["single", "check", "discuss"]) assert.match(html, new RegExp(`name="cMode" value="${v}"`));
  assert.match(html, /value="check" checked/);
  assert.match(html, /title="One AI answers\. Cheapest[^"]*cent/);
  assert.match(js, /modes\.get\(projectId\) \|\| "check"/);
  assert.match(js, /modes\.set\(projectId, v\)/);
  assert.match(js, /post\("check", \{ threadId \}\)/);
  assert.match(js, /step: "join"/);
  assert.ok(js.includes(JSON.stringify(CHECK_MARK)), "check marker matches");
  assert.match(js, /others\.slice\(0, 1\)/);
  assert.doesNotMatch(js, /window\.confirm\("Run a roundtable/);
  // A finished roundtable shows the agreed answer, with each AI's own answer and the conflict round folded under it.
  assert.match(js, /Each AI's own answer \(/);
  assert.match(js, /How they settled their disagreements/);
  assert.doesNotMatch(js, /innerHTML/, "messages are untrusted text");
});

test("AI + checker: the cheapest other AI checks one answer; agreeing ends there", async () => {
  const { call, calls, store } = harness();
  const t = await thread(call);
  assert.equal((await call("chat", { threadId: t.id, content: "Should we launch?" })).status, 200);
  const out = await call("check", { threadId: t.id });
  assert.equal(out.status, 200);
  const b = out.body as any;
  assert.equal(b.checker, "chatgpt", "the cheapest ready AI that didn't answer");
  assert.equal(b.disagrees, false);
  assert.ok(b.message.content.startsWith(CHECK_MARK + "\n"));
  const p = lastUser(calls.at(-1)!.body);
  assert.match(p, /AGREE or DISAGREE/);
  assert.match(p, /The answer to check:\nPlan one/);
  assert.doesNotMatch(p, /Claude|ChatGPT|Perplexity/);
  assert.equal(calls.length, 2, "one answer plus one short check");
  const st = roundtableState(await store.listMessages(t.id))!;
  assert.equal(st.answers.length, 1, "a check isn't counted as an answer");
  assert.equal(st.checks.length, 1);
  assert.equal((await call("check", { threadId: t.id })).status, 409, "checked once only");
});

test("AI + checker: a disagreement runs the discussion and ends in one settled answer", async () => {
  const { call, calls } = harness(base, () => false, (m, n) => (m === "chatgpt" && n === 1 ? "DISAGREE\nIt misses the cost." : null));
  const t = await thread(call);
  await call("chat", { threadId: t.id, content: "Should we launch?" });
  const chk = (await call("check", { threadId: t.id })).body as any;
  assert.equal(chk.disagrees, true);
  const join = await call("roundtable", { step: "join", threadId: t.id, model: chk.checker });
  assert.equal(join.status, 200);
  assert.equal((join.body as any).message.model, "chatgpt");
  assert.equal((await call("roundtable", { step: "join", threadId: t.id, model: "chatgpt" })).status, 409, "joins once");
  assert.equal((await call("roundtable", { step: "critique", threadId: t.id })).status, 200);
  const syn = (await call("roundtable", { step: "synthesize", threadId: t.id, models: ["claude", "chatgpt"] })).body as any;
  assert.ok(syn.message.content.startsWith(SYNTHESIS_MARK + "\n"));
  assert.match(syn.message.content, /Roundtable: Claude, ChatGPT\. Conclusion by Claude\.$/);
  assert.equal(calls.length, 1 + 1 + 1 + 2 + 1);
});

test("the checker's verdict is read from its first word only", () => {
  assert.equal(checkerDisagrees("DISAGREE\nNo."), true);
  assert.equal(checkerDisagrees("**Disagree**: wrong price"), true);
  assert.equal(checkerDisagrees("AGREE\nI don't disagree."), false);
  assert.equal(checkerDisagrees("Looks right."), false);
});
