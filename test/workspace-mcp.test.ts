import { test } from "node:test";
import assert from "node:assert/strict";
import { handle } from "../api/workspace.js";
import { createMemoryStore } from "../api/lib/workspace-store.js";
import { mcpServers, mcpStatus, mcpTools } from "../api/lib/workspace-mcp.js";
import { runTool } from "../api/lib/workspace-plugins.js";

// Phase 2 step 4: MCP plugins. A fake MCP server answers over a fake fetch; nothing real is ever called.
const MCP_URL = "https://mcp.example.com/mcp";
const servers = (extra: object = {}) => JSON.stringify([{ name: "notes", url: MCP_URL, tokenVar: "ACP_MCP_TOKEN_NOTES", tools: [{ name: "search", args: { q: "string" } }, "delete_page", "export_all"], ...extra }]);
const base = {
  ACP_SITE_PASSWORD: "synthetic-password",
  ACP_WORKSPACE_DB_URL: "https://synthetic.supabase.co",
  ACP_WORKSPACE_DB_KEY: "synthetic-service-key",
  ANTHROPIC_API_KEY: "synthetic-anthropic",
  ACP_WORKSPACE_MONTHLY_BUDGET_USD: "5",
  ACP_MCP_SERVERS: servers(),
  ACP_MCP_TOKEN_NOTES: "synthetic-mcp-token",
};
const headers = { "x-acp-password": base.ACP_SITE_PASSWORD, origin: "https://acp.example", host: "acp.example" };
const now = () => new Date("2026-10-22T12:00:00Z");
const TOOLS = [
  { name: "search", description: "Search notes", inputSchema: { type: "object", properties: { q: { type: "string" }, everything: { type: "string" } } }, annotations: { readOnlyHint: true } },
  { name: "delete_page", description: "Delete a page", inputSchema: { type: "object" }, annotations: { readOnlyHint: false, destructiveHint: true } },
  // Claims to be read-only; the owner named it, but without arguments, so it can receive nothing.
  { name: "export_all", description: "Export everything", inputSchema: { type: "object", properties: { data: { type: "string" } } }, annotations: { readOnlyHint: true } },
  { name: "not_listed", description: "Not approved by the owner", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
];

// A minimal Streamable HTTP MCP server: SSE for initialize, JSON for the rest, and a session id.
function fakeMcp(log: { method: string; headers: any; body: any }[], opts: { callResult?: object; fail?: number } = {}) {
  return (init: any) => {
    const body = JSON.parse(init.body);
    log.push({ method: body.method, headers: init.headers, body });
    if (opts.fail) return new Response("secret detail sk-mcp-1", { status: opts.fail });
    if (body.method === "initialize") {
      const msg = JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} } } });
      return new Response(`event: message\ndata: ${msg}\n\n`, { headers: { "content-type": "text/event-stream", "mcp-session-id": "sess-1" } });
    }
    if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (body.method === "tools/list") return Response.json({ jsonrpc: "2.0", id: body.id, result: { tools: TOOLS } });
    if (body.method === "tools/call") return Response.json({ jsonrpc: "2.0", id: body.id, result: opts.callResult ?? { content: [{ type: "text", text: "Found: launch plan" }, { type: "image", data: "x" }] } });
    return Response.json({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "no" } });
  };
}

test("only well-formed servers count, and a token can only come from an ACP_MCP_TOKEN_ variable", () => {
  assert.equal(mcpServers(base).length, 1);
  assert.equal(mcpServers({ ACP_MCP_SERVERS: "not json" }).length, 0);
  for (const bad of [
    { tokenVar: "ANTHROPIC_API_KEY" }, { tokenVar: "OPENROUTER_API_KEY" }, { url: "http://mcp.example.com/mcp" },
    { url: "https://user:pw@mcp.example.com" }, { name: "Bad Name" }, { tools: [] }, { tools: ["a.b"] },
    { tools: [{ name: "search", args: { q: "object" } }] }, { tools: [{ name: "search", args: { "__proto__x": "string" } }] },
    { tools: [{ name: "search", args: ["q"] }] }, { tools: ["search", { name: "search" }] },
  ]) assert.equal(mcpServers({ ACP_MCP_SERVERS: servers(bad) }).length, 0, JSON.stringify(bad));
  assert.equal((mcpStatus(base) as any).mcp_notes.ready, true);
  assert.equal((mcpStatus({ ...base, ACP_MCP_TOKEN_NOTES: "" }) as any).mcp_notes.ready, false);
  assert.deepEqual(mcpStatus({}), {});
});

test("only owner-named tools that the server marks read-only are offered, and they run through the session", async () => {
  const log: any[] = [];
  const server = fakeMcp(log);
  const f = (async (_url: any, init: any) => server(init)) as typeof fetch;
  const tools = await mcpTools(base, f);
  assert.deepEqual(tools.map((t: any) => t.name), ["mcp_notes_search", "mcp_notes_export_all"], "unapproved and write tools are left out");
  assert.deepEqual(tools[0]!.parameters, { type: "object", additionalProperties: false, properties: { q: { type: "string" } } }, "the schema is the owner's, not the server's");
  assert.deepEqual(tools[1]!.parameters, { type: "object", additionalProperties: false, properties: {} });
  assert.equal(log[0].headers.authorization, "Bearer synthetic-mcp-token");
  assert.equal(log[1].method, "notifications/initialized");
  assert.equal(log[1].headers["mcp-session-id"], "sess-1");
  assert.equal(log[2].headers["mcp-protocol-version"], "2025-06-18");
  const r = await runTool(base, tools, "mcp_notes_search", { q: "launch" }, f);
  assert.deepEqual(r, { ok: true, text: "Found: launch plan\n[image left out]" });
  const call = log.at(-1);
  assert.equal(call.method, "tools/call");
  assert.deepEqual(call.body.params, { name: "search", arguments: { q: "launch" } });
  assert.equal(call.headers["mcp-session-id"], "sess-1");
});

test("an unreachable server is skipped without its error text, and a tool error comes back as a failed call", async () => {
  const failing = fakeMcp([], { fail: 500 });
  assert.deepEqual(await mcpTools(base, (async (_u: any, i: any) => failing(i)) as typeof fetch), []);
  const server = fakeMcp([], { callResult: { isError: true, content: [{ type: "text", text: "no access" }] } });
  const f = (async (_u: any, i: any) => server(i)) as typeof fetch;
  const r = await runTool(base, await mcpTools(base, f), "mcp_notes_search", {}, f);
  assert.equal(r.ok, false);
  assert.match(r.text, /notes tool reported a problem: no access/);
});

test("Claude gets MCP tools in a chat, and the page lists the server as a plugin", async () => {
  const store = createMemoryStore();
  const log: any[] = [];
  const server = fakeMcp(log);
  const modelBodies: any[] = [];
  let round = 0;
  const fakeFetch = (async (url: any, init: any) => {
    if (String(url) === MCP_URL) return server(init);
    modelBodies.push(JSON.parse(init.body));
    return Response.json(round++ === 0
      ? { content: [{ type: "tool_use", id: "tu1", name: "mcp_notes_search", input: { q: "plan" } }], usage: { input_tokens: 10, output_tokens: 10 } }
      : { content: [{ type: "text", text: "The plan is ready." }], usage: { input_tokens: 10, output_tokens: 10 } });
  }) as typeof fetch;
  const call = (action: string, args: object = {}) =>
    handle({ method: "POST", headers, body: { action, args } }, base, () => store, { fetch: fakeFetch, now });
  const p = (await call("create_project", { name: "P" })).body as any;
  const t = ((await call("create_thread", { projectId: p.project.id, title: "T", model: "claude" })).body as any).thread;
  const out = (await call("chat", { threadId: t.id, content: "Find the plan" })).body as any;
  assert.deepEqual(modelBodies[0].tools.map((x: any) => x.name), ["mcp_notes_search", "mcp_notes_export_all"]);
  assert.match(modelBodies[1].messages.at(-1).content[0].content, /Found: launch plan/);
  assert.match(out.message.content, /Tools used: mcp_notes_search/);
  const status = (await call("models")).body as any;
  assert.equal(status.plugins.mcp_notes.title, "MCP: notes");
  assert.equal(status.plugins.mcp_notes.ready, true);
});

test("ARN-125: arguments outside the owner's list, long values and secrets are refused before anything is sent", async () => {
  const log: any[] = [];
  const server = fakeMcp(log);
  const f = (async (_url: any, init: any) => server(init)) as typeof fetch;
  const tools = await mcpTools(base, f);
  const before = log.length;
  for (const [tool, args] of [
    ["mcp_notes_export_all", { data: "SYNTHETIC_ONLY_PRIVATE_MARKER" }],
    ["mcp_notes_search", { q: "x", everything: "SYNTHETIC_ONLY_PRIVATE_MARKER" }],
    ["mcp_notes_search", { q: 5 }],
    ["mcp_notes_search", { q: "x".repeat(301) }],
    ["mcp_notes_search", { q: "find synthetic-password" }],
    ["mcp_notes_search", { q: "synthetic-mcp-token" }],
    ["mcp_notes_search", ["q"]],
    ["mcp_notes_delete_page", {}],
  ] as const) {
    const r = await runTool(base, tools, tool, args, f);
    assert.equal(r.ok, false, `${tool} ${JSON.stringify(args)}`);
    assert.doesNotMatch(r.text, /SYNTHETIC_ONLY_PRIVATE_MARKER|synthetic-password|synthetic-mcp-token/);
  }
  assert.equal(log.length, before, "no request reached the server");
  const ok = await runTool(base, tools, "mcp_notes_export_all", {}, f);
  assert.equal(ok.ok, true, "a tool named without arguments can still be called with none");
  assert.deepEqual(log.at(-1).body.params, { name: "export_all", arguments: {} });
});
