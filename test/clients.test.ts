import assert from "node:assert/strict";
import { test } from "node:test";
import { DryRunStore, LinearStore } from "../src/linear.ts";
import { anthropicClient, chatCompletionsClient, geminiClient, ProviderError } from "../src/providers.ts";

type Captured = { url: string; init: RequestInit };

function fakeFetch(body: unknown, status = 200, seen: Captured[] = []): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
}

test("LinearStore maps GraphQL issue nodes", async () => {
  const seen: Captured[] = [];
  const store = new LinearStore(
    "lin_key",
    fakeFetch(
      {
        data: {
          issues: {
            nodes: [
              {
                id: "u1",
                identifier: "ARN-20",
                title: "[Claude] Plan",
                description: null,
                url: "https://linear.app/x",
                priority: 2,
                createdAt: "2026-10-07T00:00:00Z",
                state: { type: "unstarted", name: "Todo" },
                labels: { nodes: [{ name: "Feature" }] },
                assignee: null,
                parent: null,
                children: { nodes: [{ id: "u2" }] },
              },
            ],
          },
        },
      },
      200,
      seen,
    ),
  );
  const [i] = await store.listOpenAndRecent("ARN");
  assert.equal(i!.identifier, "ARN-20");
  assert.equal(i!.description, "");
  assert.deepEqual(i!.labels, ["Feature"]);
  assert.deepEqual(i!.childIds, ["u2"]);
  assert.equal((seen[0]!.init.headers as Record<string, string>)["authorization"], "lin_key");
});

test("LinearStore surfaces GraphQL errors", async () => {
  const store = new LinearStore("k", fakeFetch({ errors: [{ message: "bad" }] }));
  await assert.rejects(() => store.listOpenAndRecent("ARN"), /Linear 200/);
});

test("DryRunStore logs writes and never forwards them", async () => {
  let writes = 0;
  const inner = {
    listOpenAndRecent: async () => [],
    getComments: async () => [],
    createIssue: async () => {
      writes++;
      throw new Error("should not be called");
    },
    comment: async () => {
      writes++;
    },
    setState: async () => {
      writes++;
    },
  };
  const d = new DryRunStore(inner);
  await d.createIssue({ teamKey: "ARN", title: "[Gemini] x", description: "" });
  await d.comment("a", "hello");
  await d.setState("a", "ARN", "started");
  assert.equal(writes, 0);
  assert.equal(d.log.length, 3);
});

test("Anthropic client sends system separately and reads usage", async () => {
  const seen: Captured[] = [];
  const c = anthropicClient("k", "m", fakeFetch({ content: [{ type: "text", text: "hi" }], usage: { input_tokens: 7, output_tokens: 3 } }, 200, seen));
  const r = await c.chat([{ role: "system", content: "S" }, { role: "user", content: "U" }], { maxOutputTokens: 10 });
  assert.deepEqual(r, { text: "hi", inputTokens: 7, outputTokens: 3 });
  const body = JSON.parse(String(seen[0]!.init.body));
  assert.equal(body.system, "S");
  assert.deepEqual(body.messages, [{ role: "user", content: "U" }]);
});

test("Gemini client maps roles and usage", async () => {
  const seen: Captured[] = [];
  const c = geminiClient("k", "gemini-x", fakeFetch({ candidates: [{ content: { parts: [{ text: "ok" }] } }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2 } }, 200, seen));
  const r = await c.chat([{ role: "system", content: "S" }, { role: "user", content: "U" }, { role: "assistant", content: "A" }], { maxOutputTokens: 10 });
  assert.equal(r.text, "ok");
  const body = JSON.parse(String(seen[0]!.init.body));
  assert.deepEqual(body.contents.map((c: { role: string }) => c.role), ["user", "model"]);
  assert.match(seen[0]!.url, /gemini-x:generateContent$/);
});

test("Perplexity citations are appended as sources", async () => {
  const c = chatCompletionsClient("perplexity", "https://api.perplexity.ai", "k", "sonar", fakeFetch({ choices: [{ message: { content: "Answer" } }], citations: ["https://a.example"], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
  const r = await c.chat([{ role: "user", content: "q" }], { maxOutputTokens: 10 });
  assert.match(r.text, /Sources:\n- https:\/\/a\.example/);
});

test("provider HTTP errors become ProviderError", async () => {
  const c = chatCompletionsClient("openai", "https://api.openai.com/v1", "k", "m", fakeFetch({ error: "nope" }, 429));
  await assert.rejects(() => c.chat([{ role: "user", content: "q" }], { maxOutputTokens: 10 }), ProviderError);
});

test("LinearStore.getComments pages through every comment", async () => {
  const pages = [
    { nodes: [{ body: "late", createdAt: "2026-10-08T10:00:02Z" }], pageInfo: { hasNextPage: true, endCursor: "c1" } },
    { nodes: [{ body: "early", createdAt: "2026-10-08T10:00:00Z" }], pageInfo: { hasNextPage: false, endCursor: null } },
  ];
  const afters: unknown[] = [];
  const f = (async (_u: string, init: { body: string }) => {
    const v = JSON.parse(init.body).variables;
    afters.push(v.after);
    const page = pages[afters.length - 1];
    return new Response(JSON.stringify({ data: { issue: { comments: page } } }), { status: 200 });
  }) as unknown as typeof fetch;
  const all = await new LinearStore("k", f).getComments("i1");
  assert.deepEqual(all.map((c) => c.body), ["late", "early"]);
  assert.deepEqual(afters, [null, "c1"]);
});
