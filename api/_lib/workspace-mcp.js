// MCP plugins (Phase 2 step 4): remote MCP servers the owner lists in ACP_MCP_SERVERS, over Streamable HTTP.
// The owner's list is the authority (ARN-125). A tool is offered only when the owner names it AND the server
// marks it read-only (readOnlyHint), but that hint is the server's own claim and can't be enforced from here,
// so it is an extra check, never the permission. The owner also names each argument a tool may receive and its
// type; a tool named without args takes none. The server's own input schema is never shown to the model, and
// arguments are checked locally before anything is sent: unknown keys, wrong types, long values and any
// configured secret value are refused with no request made.
//
// ACP_MCP_SERVERS is JSON, for example:
//   [{"name":"notion","url":"https://mcp.example.com/mcp","tokenVar":"ACP_MCP_TOKEN_NOTION",
//     "tools":[{"name":"search","args":{"query":"string"}},"list_recent"]}]
// A server's token can only come from a variable named ACP_MCP_TOKEN_*, so no other secret can be sent to it.
import { ToolError } from "./workspace-plugins.js";

const MAX_SERVERS = 5;
const PROTOCOL = "2025-06-18";
const MAX_BODY_CHARS = 1_000_000;
const MAX_ARGS = 8;
const MAX_ARG_CHARS = 300;
const MAX_ARGS_JSON = 1_000;
const MAX_DESCRIPTION = 300;
const ARG_TYPES = ["string", "number", "boolean"];
const SECRET_VAR = /(KEY|TOKEN|SECRET|PASSWORD)/i;

// One owner-approved tool: a bare name (no arguments) or {name, args: {argName: "string"|"number"|"boolean"}}.
function ownerTool(t) {
  const name = typeof t === "string" ? t : t && typeof t === "object" && !Array.isArray(t) ? t.name : null;
  if (typeof name !== "string" || !/^[A-Za-z0-9_-]{1,40}$/.test(name)) return null;
  const raw = typeof t === "string" || t.args === undefined ? {} : t.args;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const entries = Object.entries(raw);
  if (entries.length > MAX_ARGS || !entries.every(([k, v]) => /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(k) && ARG_TYPES.includes(v))) return null;
  return { name, args: Object.fromEntries(entries) };
}

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
      && s.tools.every((t) => ownerTool(t) !== null)
      && new Set(s.tools.map((t) => ownerTool(t).name)).size === s.tools.length;
    if (ok) seen.add(s.name);
    return ok;
  }).slice(0, MAX_SERVERS).map((s) => ({ name: s.name, url: s.url, tokenVar: s.tokenVar ?? null, tools: s.tools.map(ownerTool) }));
}

// A server is ready when it is listed and, if it names a token variable, that variable is set.
export const mcpReady = (env, s) => !s.tokenVar || Boolean(env[s.tokenVar]);

export function mcpStatus(env) {
  return Object.fromEntries(mcpServers(env).map((s) => [`mcp_${s.name}`, {
    title: `MCP: ${s.name}`, description: `Owner-approved read-only tools: ${s.tools.map((t) => t.name).join(", ")}.`, ready: mcpReady(env, s),
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

// Checked before any request: only the owner's argument names and types, short values, and never a secret this
// deployment holds. A refusal goes back to the model and nothing is sent to the server.
export function checkArgs(env, tool, args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new ToolError("Arguments must be an object.");
  const secrets = Object.entries(env).filter(([k, v]) => SECRET_VAR.test(k) && typeof v === "string" && v.trim().length >= 8).map(([, v]) => v.trim());
  const out = {};
  for (const [k, v] of Object.entries(args)) {
    const type = Object.hasOwn(tool.args, k) ? tool.args[k] : null;
    if (!type) throw new ToolError(`"${k.slice(0, 40)}" is not an argument the owner approved for ${tool.name}.`);
    if (typeof v !== type || (type === "number" && !Number.isFinite(v))) throw new ToolError(`"${k}" must be a ${type}.`);
    if (type === "string" && (v.length > MAX_ARG_CHARS || secrets.some((x) => v.includes(x)))) {
      throw new ToolError(`"${k}" is too long or contains private data, so it wasn't sent.`);
    }
    out[k] = v;
  }
  if (JSON.stringify(out).length > MAX_ARGS_JSON) throw new ToolError("The arguments are too long, so they weren't sent.");
  return out;
}

const flatten = (content) => (Array.isArray(content) ? content : [])
  .map((c) => (c?.type === "text" && typeof c.text === "string" ? c.text : `[${String(c?.type ?? "item").slice(0, 20)} left out]`))
  .join("\n");

/**
 * The tools of every ready MCP server: the ones the owner named, that the server lists and also marks read-only.
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
      const own = t && typeof t.name === "string" ? s.tools.find((o) => o.name === t.name) : null;
      if (!own || t.annotations?.readOnlyHint !== true) continue;
      const name = `mcp_${s.name}_${own.name}`.slice(0, 64);
      if (tools.some((x) => x.name === name)) continue;
      // The schema comes from the owner's list, not the server.
      const schema = {
        type: "object", additionalProperties: false,
        properties: Object.fromEntries(Object.entries(own.args).map(([k, type]) => [k, { type }])),
      };
      const remote = typeof t.description === "string" ? t.description.replace(/\s+/g, " ").slice(0, MAX_DESCRIPTION) : "";
      tools.push({
        name,
        description: `[${s.name}, remote MCP tool] ${remote || own.name}`,
        parameters: schema,
        async run(env2, args, f2) {
          const safe = checkArgs(env2, own, args);
          const r = await rpc(f2, s, env2, session, { id: nextId++, method: "tools/call", params: { name: own.name, arguments: safe } });
          const text = flatten(r.content);
          if (r.isError) throw new ToolError(`The ${s.name} tool reported a problem: ${text.slice(0, 500)}`);
          return text || "(The tool returned nothing.)";
        },
      });
    }
  }
  return tools;
}
