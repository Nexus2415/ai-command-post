// MCP plugins (Phase 2 step 4): remote MCP servers the owner lists in ACP_MCP_SERVERS, over Streamable HTTP.
// Only tools the owner names for a server are offered, and only when the server marks them read-only
// (readOnlyHint), so like the built-in plugins they can only read. Writes stay with the engine.
//
// ACP_MCP_SERVERS is JSON, for example:
//   [{"name":"notion","url":"https://mcp.example.com/mcp","tokenVar":"ACP_MCP_TOKEN_NOTION","tools":["search"]}]
// A server's token can only come from a variable named ACP_MCP_TOKEN_*, so no other secret can be sent to it.
import { ToolError } from "./workspace-plugins.js";

const MAX_SERVERS = 5;
const PROTOCOL = "2025-06-18";
const MAX_BODY_CHARS = 1_000_000;

// The owner's server list, keeping only well-formed entries.
export function mcpServers(env) {
  let list;
  try { list = JSON.parse(String(env.ACP_MCP_SERVERS ?? "[]")); } catch { return []; }
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  return list.filter((s) => {
    const ok = s && typeof s === "object" && typeof s.name === "string" && /^[a-z][a-z0-9]{1,19}$/.test(s.name) && !seen.has(s.name)
      && typeof s.url === "string" && /^https:\/\/[^\s/?#@]+(\/[^\s]*)?$/.test(s.url)
      && (s.tokenVar === undefined || (typeof s.tokenVar === "string" && /^ACP_MCP_TOKEN_[A-Z0-9_]{1,40}$/.test(s.tokenVar)))
      && Array.isArray(s.tools) && s.tools.length > 0 && s.tools.length <= 20
      && s.tools.every((t) => typeof t === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(t));
    if (ok) seen.add(s.name);
    return ok;
  }).slice(0, MAX_SERVERS).map((s) => ({ name: s.name, url: s.url, tokenVar: s.tokenVar ?? null, tools: [...s.tools] }));
}

// A server is ready when it is listed and, if it names a token variable, that variable is set.
export const mcpReady = (env, s) => !s.tokenVar || Boolean(env[s.tokenVar]);

export function mcpStatus(env) {
  return Object.fromEntries(mcpServers(env).map((s) => [`mcp_${s.name}`, {
    title: `MCP: ${s.name}`, description: `Owner-approved read-only tools: ${s.tools.join(", ")}.`, ready: mcpReady(env, s),
  }]));
}

// One JSON-RPC exchange. The answer may be plain JSON or a server-sent event stream.
async function rpc(f, s, env, session, body) {
  const label = `MCP server ${s.name}`;
  let res;
  try {
    res = await f(s.url, {
      method: "POST",
      headers: {
        "content-type": "application/json", accept: "application/json, text/event-stream",
        ...(s.tokenVar ? { authorization: `Bearer ${String(env[s.tokenVar]).trim()}` } : {}),
        ...(session.id ? { "mcp-session-id": session.id } : {}),
        ...(session.version ? { "mcp-protocol-version": session.version } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", ...body }),
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
    });
  } catch {
    throw new ToolError(`${label} didn't answer in time.`);
  }
  // Only the status goes back to the model, never the server's own error text.
  if (!res.ok) throw new ToolError(`${label} returned an error (${res.status}).`);
  if (body.id === undefined) return null;
  const id = res.headers.get("mcp-session-id");
  if (id && !session.id && /^[\x21-\x7e]{1,200}$/.test(id)) session.id = id;
  const text = (await res.text().catch(() => "")).slice(0, MAX_BODY_CHARS);
  const messages = (res.headers.get("content-type") ?? "").includes("text/event-stream")
    ? text.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim())
    : [text];
  for (const m of messages) {
    let j;
    try { j = JSON.parse(m); } catch { continue; }
    if (j && j.id === body.id) {
      if (j.error || !j.result || typeof j.result !== "object") throw new ToolError(`${label} refused the request.`);
      return j.result;
    }
  }
  throw new ToolError(`${label} sent an invalid response.`);
}

async function connect(f, s, env) {
  const session = { id: null, version: null };
  const init = await rpc(f, s, env, session, {
    id: 1, method: "initialize",
    params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "ai-command-post", version: "1" } },
  });
  session.version = typeof init.protocolVersion === "string" && /^[\w.-]{1,20}$/.test(init.protocolVersion) ? init.protocolVersion : PROTOCOL;
  await rpc(f, s, env, session, { method: "notifications/initialized" });
  const listed = [];
  let cursor;
  for (let page = 0; page < 3; page++) {
    const r = await rpc(f, s, env, session, { id: 2 + page, method: "tools/list", ...(cursor ? { params: { cursor } } : {}) });
    if (Array.isArray(r.tools)) listed.push(...r.tools);
    cursor = typeof r.nextCursor === "string" && r.nextCursor ? r.nextCursor : null;
    if (!cursor) break;
  }
  return { session, listed };
}

const flatten = (content) => (Array.isArray(content) ? content : [])
  .map((c) => (c?.type === "text" && typeof c.text === "string" ? c.text : `[${String(c?.type ?? "item").slice(0, 20)} left out]`))
  .join("\n");

/**
 * The tools of every ready MCP server: the ones the owner named, that the server lists and marks read-only.
 * A server that can't be reached is skipped, so the reply still goes ahead.
 */
export async function mcpTools(env, f = fetch) {
  const servers = mcpServers(env).filter((s) => mcpReady(env, s));
  const lists = await Promise.all(servers.map((s) => connect(f, s, env).then((c) => ({ s, ...c }), () => null)));
  const tools = [];
  let nextId = 100;
  for (const item of lists) {
    if (!item) continue;
    const { s, session, listed } = item;
    for (const t of listed) {
      if (!t || typeof t.name !== "string" || !s.tools.includes(t.name) || t.annotations?.readOnlyHint !== true) continue;
      const name = `mcp_${s.name}_${t.name}`.slice(0, 64);
      if (tools.some((x) => x.name === name)) continue;
      const schema = t.inputSchema && typeof t.inputSchema === "object" && t.inputSchema.type === "object" ? t.inputSchema : { type: "object", properties: {} };
      tools.push({
        name,
        description: `[${s.name}] ${typeof t.description === "string" ? t.description : t.name}`.slice(0, 1_000),
        parameters: schema,
        async run(env2, args, f2) {
          const r = await rpc(f2, s, env2, session, { id: nextId++, method: "tools/call", params: { name: t.name, arguments: args } });
          const text = flatten(r.content);
          if (r.isError) throw new ToolError(`The ${s.name} tool reported a problem: ${text.slice(0, 500)}`);
          return text || "(The tool returned nothing.)";
        },
      });
    }
  }
  return tools;
}
