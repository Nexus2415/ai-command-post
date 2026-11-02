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
                children: { nodes: [{ id: "u2" }], pageInfo: { hasNextPage: false } },
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
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
  assert.equal(i!.childrenIncomplete, undefined, "an explicit last page proves the sub-task list complete");
  assert.equal((seen[0]!.init.headers as Record<string, string>)["authorization"], "lin_key");
});

test("ARN-45: a sub-task list without proof of completeness is flagged, never read as complete", async () => {
  const read = async (children: unknown) => {
    const node = { id: "u1", identifier: "ARN-20", title: "t", url: "u", createdAt: "2026-10-07T00:00:00Z", state: { type: "started", name: "In Progress" }, labels: { nodes: [] }, children };
    const [i] = await new LinearStore("k", fakeFetch({ data: { issues: { nodes: [node], pageInfo: { hasNextPage: false, endCursor: null } } } })).listOpenAndRecent("ARN");
    return i!;
  };
  const done = { hasNextPage: false };
  for (const [name, children, ids] of [
    ["empty, complete", { nodes: [], pageInfo: done }, []],
    ["two children, complete", { nodes: [{ id: "c1" }, { id: "c2" }], pageInfo: done }, ["c1", "c2"]],
  ] as [string, unknown, string[]][]) {
    const i = await read(children);
    assert.deepEqual(i.childIds, ids, name);
    assert.equal(i.childrenIncomplete, undefined, name);
  }
  for (const [name, children] of [
    ["no children", undefined],
    ["null children", null],
    ["no nodes", { pageInfo: done }],
    ["no pageInfo", { nodes: [{ id: "c1" }] }],
    ["string hasNextPage", { nodes: [{ id: "c1" }], pageInfo: { hasNextPage: "false" } }],
    ["more children on another page", { nodes: [{ id: "c1" }], pageInfo: { hasNextPage: true } }],
    ["a child without an id", { nodes: [{ id: "c1" }, {}], pageInfo: done }],
    ["a null child", { nodes: [null], pageInfo: done }],
    ["the same child twice", { nodes: [{ id: "c1" }, { id: "c1" }], pageInfo: done }],
    ["the same child three times", { nodes: [{ id: "c1" }, { id: "c1" }, { id: "c1" }], pageInfo: done }],
    ["a repeat among distinct children", { nodes: [{ id: "c1" }, { id: "c2" }, { id: "c1" }], pageInfo: done }],
    ["a repeat plus a child without an id", { nodes: [{ id: "c1" }, { id: "c1" }, {}], pageInfo: done }],
  ] as [string, unknown][]) {
    assert.equal((await read(children)).childrenIncomplete, true, name);
  }
  // A repeated child is listed once, and the list stays flagged incomplete rather than deduped into "complete".
  const dup = await read({ nodes: [{ id: "c1" }, { id: "c2" }, { id: "c1" }], pageInfo: done });
  assert.deepEqual(dup.childIds, ["c1", "c2"]);
  assert.equal(dup.childrenIncomplete, true);
});

test("ARN-45: listOpenAndRecent pages through the whole queue and refuses a partial one", async () => {
  const issue = (id: string) => ({ id, identifier: id, title: "t", url: "u", createdAt: "2026-10-07T00:00:00Z", state: { type: "unstarted", name: "Todo" }, labels: { nodes: [] }, children: { nodes: [], pageInfo: { hasNextPage: false } } });
  const run = (pages: unknown[]) => {
    const afters: unknown[] = [];
    const f = (async (_u: string, init: { body: string }) => {
      afters.push(JSON.parse(init.body).variables.after);
      return new Response(JSON.stringify({ data: { issues: pages[afters.length - 1] } }), { status: 200 });
    }) as unknown as typeof fetch;
    return { result: new LinearStore("k", f).listOpenAndRecent("ARN"), afters };
  };
  // Issue 251 sits on page 2 and is still read.
  const page1 = { nodes: Array.from({ length: 250 }, (_, n) => issue(`i${n + 1}`)), pageInfo: { hasNextPage: true, endCursor: "c250" } };
  const ok = run([page1, { nodes: [issue("i251")], pageInfo: { hasNextPage: false, endCursor: null } }]);
  const all = await ok.result;
  assert.equal(all.length, 251);
  assert.equal(all[250]!.id, "i251");
  assert.deepEqual(ok.afters, [null, "c250"]);
  const one = [issue("a")];
  const bad: [string, unknown[]][] = [
    ["no pageInfo", [{ nodes: one }]],
    ["null pageInfo", [{ nodes: one, pageInfo: null }]],
    ["string hasNextPage", [{ nodes: one, pageInfo: { hasNextPage: "false" } }]],
    ["no nodes", [{ pageInfo: { hasNextPage: false } }]],
    ["null nodes", [{ nodes: null, pageInfo: { hasNextPage: false } }]],
    ["a null issue", [{ nodes: [null], pageInfo: { hasNextPage: false } }]],
    ["no issues connection", [undefined]],
    ["more without a cursor", [{ nodes: one, pageInfo: { hasNextPage: true, endCursor: null } }]],
    ["more with an empty cursor", [{ nodes: one, pageInfo: { hasNextPage: true, endCursor: "" } }]],
    ["a cursor that doesn't advance", [{ nodes: one, pageInfo: { hasNextPage: true, endCursor: "c1" } }, { nodes: [issue("b")], pageInfo: { hasNextPage: true, endCursor: "c1" } }]],
    ["a malformed later page", [page1, { nodes: [issue("i251")] }]],
    // Cursors that loop back (A, B, A) before a final page: the later "no more pages" proves nothing.
    ["a cursor cycle A-B-A, then a last page", [
      { nodes: [issue("a")], pageInfo: { hasNextPage: true, endCursor: "A" } },
      { nodes: [issue("b")], pageInfo: { hasNextPage: true, endCursor: "B" } },
      { nodes: [issue("c")], pageInfo: { hasNextPage: true, endCursor: "A" } },
      { nodes: [issue("d")], pageInfo: { hasNextPage: false, endCursor: null } },
    ]],
    ["a cursor cycle A-B-C-A, then a last page", [
      { nodes: [issue("a")], pageInfo: { hasNextPage: true, endCursor: "A" } },
      { nodes: [issue("b")], pageInfo: { hasNextPage: true, endCursor: "B" } },
      { nodes: [issue("c")], pageInfo: { hasNextPage: true, endCursor: "C" } },
      { nodes: [issue("d")], pageInfo: { hasNextPage: true, endCursor: "A" } },
      { nodes: [issue("e")], pageInfo: { hasNextPage: false, endCursor: null } },
    ]],
    ["more pages than ACP reads", Array.from({ length: 9 }, (_, n) => ({ nodes: [issue(`p${n}`)], pageInfo: { hasNextPage: true, endCursor: `c${n + 1}` } }))],
  ];
  for (const [name, pages] of bad) {
    const r = run(pages);
    await assert.rejects(r.result, /refusing to act on a partial queue/, name);
    assert.ok(r.afters.length <= pages.length, `${name}: no reads past the bad page`);
    if (name.startsWith("a cursor cycle")) assert.equal(r.afters.length, pages.length - 1, `${name}: stops at the repeated cursor`);
  }
  // Control: three pages with distinct cursors read in full.
  const chain = run([
    { nodes: [issue("a")], pageInfo: { hasNextPage: true, endCursor: "A" } },
    { nodes: [issue("b")], pageInfo: { hasNextPage: true, endCursor: "B" } },
    { nodes: [issue("c")], pageInfo: { hasNextPage: false, endCursor: "B" } },
  ]);
  assert.deepEqual((await chain.result).map((i) => i.id), ["a", "b", "c"]);
  assert.deepEqual(chain.afters, [null, "A", "B"]);
});

test("ARN-45: listOpenAndRecent refuses a queue with a repeated or unreadable issue id, never picks a copy", async () => {
  const issue = (id: unknown, type = "unstarted", identifier: unknown = id) => ({ id, identifier, title: "t", url: "u", createdAt: "2026-10-07T00:00:00Z", state: { type, name: type }, labels: { nodes: [] }, children: { nodes: [], pageInfo: { hasNextPage: false } } });
  const run = (pages: unknown[]) => {
    let reads = 0;
    const f = (async () => new Response(JSON.stringify({ data: { issues: pages[reads++] } }), { status: 200 })) as unknown as typeof fetch;
    return { result: new LinearStore("k", f).listOpenAndRecent("ARN"), reads: () => reads };
  };
  const last = (nodes: unknown[]) => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null } });
  const more = (nodes: unknown[], c: string) => ({ nodes, pageInfo: { hasNextPage: true, endCursor: c } });
  // Control: distinct ids on one page and across two pages are all read.
  assert.deepEqual((await run([last([issue("a"), issue("b")])]).result).map(i => i.id), ["a", "b"]);
  assert.deepEqual((await run([more([issue("a")], "c1"), last([issue("b")])]).result).map(i => i.id), ["a", "b"]);
  const dupes: [string, unknown[]][] = [
    ["same id twice on one page", [last([issue("a"), issue("a")])]],
    ["same id on two pages", [more([issue("a")], "c1"), last([issue("a")])]],
    ["conflicting snapshots of one id", [more([issue("a", "unstarted")], "c1"), last([issue("a", "started")])]],
  ];
  for (const [name, pages] of dupes) await assert.rejects(run(pages).result, /more than once; refusing to act on an inconsistent queue/, name);
  const unreadable: [string, unknown][] = [
    ["missing id", issue(undefined, "unstarted", "ARN-1")], ["empty id", issue("", "unstarted", "ARN-1")],
    ["numeric id", issue(7, "unstarted", "ARN-1")], ["missing identifier", { ...issue("a"), identifier: undefined }],
    ["empty identifier", issue("a", "unstarted", "")],
  ];
  for (const [name, node] of unreadable) {
    await assert.rejects(run([last([issue("ok"), node])]).result, /without a readable id; refusing to act on an inconsistent queue/, name);
  }
  // A bad first page stops before any later page is read.
  const r = run([more([issue("a"), issue("a")], "c1"), last([issue("b")])]);
  await assert.rejects(r.result);
  assert.equal(r.reads(), 1);
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

test("ARN-45: getLabels refuses a label list it can't read in full; only an explicit empty list means no labels", async () => {
  const read = (data: unknown) => new LinearStore("k", (async () => new Response(JSON.stringify({ data }), { status: 200 })) as unknown as typeof fetch).getLabels("i1");
  const done = { hasNextPage: false };
  assert.deepEqual(await read({ issue: { labels: { nodes: [], pageInfo: done } } }), []);
  assert.deepEqual(await read({ issue: { labels: { nodes: [{ name: "executor:manual" }], pageInfo: done } } }), ["executor:manual"]);
  const bad: [string, unknown][] = [
    ["no issue", {}],
    ["null issue", { issue: null }],
    ["no labels", { issue: {} }],
    ["null labels", { issue: { labels: null } }],
    ["no nodes", { issue: { labels: { pageInfo: done } } }],
    ["null nodes", { issue: { labels: { nodes: null, pageInfo: done } } }],
    ["object nodes", { issue: { labels: { nodes: {}, pageInfo: done } } }],
    ["no pageInfo", { issue: { labels: { nodes: [] } } }],
    ["string hasNextPage", { issue: { labels: { nodes: [], pageInfo: { hasNextPage: "false" } } } }],
    ["more labels than one page", { issue: { labels: { nodes: [{ name: "a" }], pageInfo: { hasNextPage: true } } } }],
    ["a null label", { issue: { labels: { nodes: [null], pageInfo: done } } }],
    ["a label without a name", { issue: { labels: { nodes: [{}], pageInfo: done } } }],
    ["a non-string name", { issue: { labels: { nodes: [{ name: 7 }], pageInfo: done } } }],
  ];
  for (const [name, data] of bad) await assert.rejects(read(data), /refusing to guess its executor/, name);
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

test("ARN-45: getComments refuses a comment list it can't read in full", async () => {
  // An earlier foreign claim sits on page 2; page 1's page signal is missing or malformed.
  const later = { body: "acp claim later", createdAt: "2026-10-08T10:00:02Z" };
  const run = async (pages: unknown[]) => {
    let n = 0;
    const f = (async () => new Response(JSON.stringify({ data: { issue: { comments: pages[n++] } } }), { status: 200 })) as unknown as typeof fetch;
    return { result: new LinearStore("k", f).getComments("i1"), reads: () => n };
  };
  const bad: [string, unknown[]][] = [
    ["no pageInfo", [{ nodes: [later] }]],
    ["null pageInfo", [{ nodes: [later], pageInfo: null }]],
    ["missing hasNextPage", [{ nodes: [later], pageInfo: { endCursor: "c1" } }]],
    ["string hasNextPage", [{ nodes: [later], pageInfo: { hasNextPage: "false", endCursor: null } }]],
    ["null hasNextPage", [{ nodes: [later], pageInfo: { hasNextPage: null } }]],
    ["no nodes", [{ pageInfo: { hasNextPage: false } }]],
    ["no comments", [undefined]],
    ["more without a cursor", [{ nodes: [later], pageInfo: { hasNextPage: true, endCursor: null } }]],
    ["more with an empty cursor", [{ nodes: [later], pageInfo: { hasNextPage: true, endCursor: "" } }]],
    ["a cursor that doesn't advance", [
      { nodes: [later], pageInfo: { hasNextPage: true, endCursor: "c1" } },
      { nodes: [], pageInfo: { hasNextPage: true, endCursor: "c1" } },
    ]],
    ...([
      ["a missing body", { createdAt: "2026-10-08T10:00:00Z" }],
      ["a null body", { body: null, createdAt: "2026-10-08T10:00:00Z" }],
      ["a non-string body", { body: 7, createdAt: "2026-10-08T10:00:00Z" }],
      ["a missing timestamp", { body: "ACP executor: manual" }],
      ["a null timestamp", { body: "ACP executor: manual", createdAt: null }],
      ["an unparseable timestamp", { body: "ACP executor: manual", createdAt: "not a date" }],
      ["a null comment", null],
    ] as [string, unknown][]).flatMap(([what, node]): [string, unknown[]][] => [
      [`${what} on page 1`, [{ nodes: [later, node], pageInfo: { hasNextPage: false, endCursor: null } }]],
      [`${what} on a later page`, [
        { nodes: [later], pageInfo: { hasNextPage: true, endCursor: "c1" } },
        { nodes: [node], pageInfo: { hasNextPage: false, endCursor: null } },
      ]],
    ]),
    ["a malformed later page", [
      { nodes: [later], pageInfo: { hasNextPage: true, endCursor: "c1" } },
      { nodes: [{ body: "earlier foreign claim", createdAt: "2026-10-08T10:00:00Z" }] },
    ]],
    // Cursors that loop back before a final page: the earliest claim could sit on a page never reached.
    ["a cursor cycle A-B-A, then a last page", [
      { nodes: [later], pageInfo: { hasNextPage: true, endCursor: "A" } },
      { nodes: [], pageInfo: { hasNextPage: true, endCursor: "B" } },
      { nodes: [], pageInfo: { hasNextPage: true, endCursor: "A" } },
      { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
    ]],
    ["a cursor cycle A-B-C-A, then a last page", [
      { nodes: [later], pageInfo: { hasNextPage: true, endCursor: "A" } },
      { nodes: [], pageInfo: { hasNextPage: true, endCursor: "B" } },
      { nodes: [], pageInfo: { hasNextPage: true, endCursor: "C" } },
      { nodes: [], pageInfo: { hasNextPage: true, endCursor: "A" } },
      { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
    ]],
  ];
  for (const [name, pages] of bad) {
    const r = await run(pages);
    await assert.rejects(r.result, /refusing to guess the earliest claim/, name);
    assert.ok(r.reads() <= pages.length, `${name}: no reads past the bad page`);
    if (name.startsWith("a cursor cycle")) assert.equal(r.reads(), pages.length - 1, `${name}: stops at the repeated cursor`);
  }
  // Control: three pages with distinct cursors read in full.
  const chain = await run([
    { nodes: [later], pageInfo: { hasNextPage: true, endCursor: "A" } },
    { nodes: [], pageInfo: { hasNextPage: true, endCursor: "B" } },
    { nodes: [{ body: "early", createdAt: "2026-10-08T10:00:00Z" }], pageInfo: { hasNextPage: false, endCursor: "B" } },
  ]);
  assert.deepEqual((await chain.result).map((c) => c.body), ["acp claim later", "early"]);
  assert.equal(chain.reads(), 3);
});
