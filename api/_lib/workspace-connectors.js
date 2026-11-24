// Connectors and custom tools the owner adds on the Tools page (dashboard/tools.html), saved in ws_connectors.
//
// Two kinds, both READ-ONLY:
//  - "mcp": a remote MCP server he already uses, added by address. Same rules as ACP_MCP_SERVERS
//    (workspace-mcp.js): only tools he picks, only ones the server marks read-only, only the arguments he approves.
//  - "http": a custom look-up tool he builds himself over one https address. The AI fills in the inputs he named;
//    they go into the address as ?name=value. Always a GET: nothing is posted, sent, bought or changed.
//
// Fences, in the order they apply:
//  1. The builder refuses anything that sounds like a write (send, post, delete, buy, …), any method but GET, and
//     any secret in the definition: keys only ever come from a Vercel variable he names, never typed here.
//  2. Addresses must be public https. IP addresses, localhost, private and internal names are refused when saved,
//     and the network call itself re-checks every address the name resolves to (guardedFetch), so a public name
//     that points at a private address is refused too. Redirects are never followed.
//  3. Nothing is usable until he has seen the plain-language summary and confirmed it (the fingerprint).
//  4. Each call goes through the Stop switch and the rules gate (gatedRunTool in api/workspace.js), and is
//     counted against the spend caps (CALL_COST_USD) and listed under the reply.
//  5. What comes back is wrapped as untrusted data, never instructions.
import { createHash } from "node:crypto";
import dns from "node:dns";
import https from "node:https";
import { ToolError, untrusted } from "./workspace-plugins.js";
import { checkArgs, connect, mcpServers, mcpTools, parseServer } from "./workspace-mcp.js";
import { harmCheck } from "./workspace-rules.js";

// A nominal charge per call, so connector use is metered against the caps like everything else and a runaway
// loop of calls stops at the cap. The services themselves are his and usually free.
export const CALL_COST_USD = 0.001;
export const MAX_CONNECTORS = 20;
const MAX_INPUTS = 6;
const MAX_RESPONSE_BYTES = 500_000;
const MAX_TEXT = 7_000;
const SECRET_VAR = /(KEY|TOKEN|SECRET|PASSWORD)/i;

// ---------------------------------------------------------------------------------------------------------------
// Addresses

// True only for a public internet address. Everything private, local, link-local (169.254.x, cloud metadata),
// carrier-grade NAT, multicast, reserved or documentation-only is false.
export function isPublicIp(ip) {
  const s = String(ip).toLowerCase();
  const v4 = s.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b, c] = v4.slice(1, 4).map(Number);
    if (v4.slice(1).some((x) => Number(x) > 255)) return false;
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0 && (c === 0 || c === 2))
      || (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113));
  }
  if (!s.includes(":")) return false;
  const mapped = s.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped) return isPublicIp(mapped[1]);
  // Only global unicast (2000::/3) is public. 6to4 (2002::/16) carries an IPv4 address that must be public too.
  if (!/^[23][0-9a-f]{0,3}:/.test(s) || s.startsWith("2001:db8") || s.startsWith("2001:0db8")) return false;
  const six = s.match(/^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4}):/);
  if (six) {
    const [h, l] = [parseInt(six[1], 16), parseInt(six[2], 16)];
    return isPublicIp(`${h >> 8}.${h & 255}.${l >> 8}.${l & 255}`);
  }
  return true;
}

const INTERNAL_NAME = /(?:^|\.)(?:localhost|local|internal|intranet|lan|home|corp|localdomain|private|test|invalid|example|onion|arpa)$/;

// Why an address can't be used, in plain words, or null when it can.
export function addressProblem(raw) {
  if (typeof raw !== "string" || !raw.trim() || raw.length > 500) return "Give the full address, starting with https://.";
  let u;
  try { u = new URL(raw.trim()); } catch { return "That isn't a web address. It should start with https://."; }
  if (u.protocol !== "https:") return "Only secure addresses (https://) are allowed.";
  if (u.username || u.password) return "The address can't contain a username or password. Put the key in a Vercel variable instead.";
  if (u.port && u.port !== "443") return "Only the standard secure port is allowed (no :port in the address).";
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  if (host.startsWith("[") || /^[\d.]+$/.test(host) || /^0x/i.test(host) || host.includes(":")) {
    return "Number-only (IP) addresses aren't allowed. Use the service's name, like api.example.com.";
  }
  if (!host.includes(".") || INTERNAL_NAME.test(host)) {
    return "That points at a private or internal network (like localhost or .internal), which is blocked so a tool can't reach our own systems.";
  }
  if (u.hash) return "Leave out the # part of the address.";
  return null;
}

// Node's DNS lookup, wrapped so a connection is only made to public addresses. Every address the name resolves to
// must be public; one private answer blocks the call. Because this runs at connect time, it also covers a name
// that changed what it points to after it was saved.
export function safeLookup(resolve = dns.lookup) {
  return (hostname, options, cb) => {
    if (typeof options === "function") { cb = options; options = {}; }
    resolve(hostname, { all: true, verbatim: true }, (err, addrs) => {
      if (err) return cb(err);
      const list = (Array.isArray(addrs) ? addrs : [{ address: addrs, family: options?.family || 4 }])
        .map((a) => ({ address: a.address, family: a.family }));
      if (!list.length || list.some((a) => !isPublicIp(a.address))) {
        const e = new Error(`${hostname} points at a private or internal address, so it was blocked.`);
        e.code = "EBLOCKED";
        return cb(e);
      }
      if (options?.all) return cb(null, list);
      cb(null, list[0].address, list[0].family);
    });
  };
}

/**
 * fetch(), but only to public https addresses: the address is checked first, every resolved IP is checked when
 * connecting, redirects are never followed, and the answer is capped in size. Returns a standard Response.
 */
export function guardedFetch(url, init = {}, { lookup = safeLookup(), maxBytes = 1_000_000, request = https.request } = {}) {
  const why = addressProblem(String(url));
  if (why) return Promise.reject(new TypeError(why));
  return new Promise((resolve, reject) => {
    const req = request(String(url), {
      method: init.method ?? "GET", headers: init.headers ?? {}, lookup, signal: init.signal, timeout: 15_000,
    }, (res) => {
      const chunks = [];
      let n = 0;
      res.on("data", (c) => {
        n += c.length;
        if (n > maxBytes) { req.destroy(); reject(new Error("The answer was too large.")); } else chunks.push(c);
      });
      res.on("end", () => {
        const h = new Headers();
        for (const [k, v] of Object.entries(res.headers)) if (v != null) h.set(k, Array.isArray(v) ? v.join(", ") : String(v));
        try {
          const empty = [204, 205, 304].includes(res.statusCode);
          resolve(new Response(empty ? null : Buffer.concat(chunks), { status: res.statusCode, headers: h }));
        } catch (e) { reject(e); }
      });
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    if (init.body) req.write(init.body);
    req.end();
  });
}

// ---------------------------------------------------------------------------------------------------------------
// What the builder refuses

// Words that mean changing something in the outside world. A look-up tool never needs them.
const WRITE_WORDS = new Set(("send sends sending sent post posting create creates delete deletes remove removes update updates " +
  "write writes edit edits modify buy buys purchase purchases pay pays payment payments charge charges checkout transfer " +
  "transfers submit submits publish publishes upload uploads cancel cancels refund refunds subscribe unsubscribe email emails " +
  "sms tweet reply replies approve approves merge merges deploy deploys execute executes insert inserts put patch destroy " +
  "wipe drop reset invite invites book books reserve reserves order orders withdraw deposit sell sells trade trades sign " +
  "signs mutate mutation rename move moves archive archives grant revoke ban kick").split(" "));
export function writeWords(...texts) {
  const words = texts.join(" ").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z]+/);
  return [...new Set(words.filter((w) => WRITE_WORDS.has(w)))];
}

const KEY_SHAPES = /(?:\bsk-[A-Za-z0-9_-]{8,}|\bsk_(?:live|test)_|\bghp_[A-Za-z0-9]{8,}|\bgithub_pat_|\bxox[abprs]-|\bAKIA[0-9A-Z]{12,}|\beyJ[A-Za-z0-9_-]{10,}\.|\blin_api_|\bsb_secret_|\bfc-[0-9a-f]{16,}|\bBearer\s+\S{8,})/;
const KEY_PARAM = /^(?:key|apikey|api_key|api-key|token|access_token|auth|authorization|secret|client_secret|password|pass|pwd|sig|signature|session|code)$/i;

// Secret values this deployment holds, so none can be copied into a definition or sent by a tool.
const envSecrets = (env) => Object.entries(env)
  .filter(([k, v]) => SECRET_VAR.test(k) && typeof v === "string" && v.trim().length >= 8).map(([, v]) => v.trim());

function secretProblem(env, texts) {
  const all = texts.filter((t) => typeof t === "string");
  if (all.some((t) => KEY_SHAPES.test(t)) || envSecrets(env).some((s) => all.some((t) => t.includes(s)))) {
    return "It looks like a key or password was typed in. Never type keys here: put the key in a Vercel variable and give only the variable's name.";
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// Checking a definition

const NAME = /^[a-z][a-z0-9]{1,19}$/;
const INPUT_NAME = /^[a-z][a-z0-9_]{0,29}$/;
const TYPES = { string: "text", number: "number", boolean: "yes/no" };
const cleanText = (v, max) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max + 1) : "");

function commonChecks(raw, env, problems, taken) {
  const name = cleanText(raw.name, 20).toLowerCase();
  if (!NAME.test(name)) problems.push("Name: 2 to 20 lowercase letters or digits, starting with a letter (for example weather).");
  else if (taken.has(name)) problems.push(`The name "${name}" is already used. Pick another.`);
  const projectId = raw.projectId ?? null;
  return { name, projectId };
}

function tokenProblem(tokenVar, prefix) {
  if (tokenVar == null || tokenVar === "") return null;
  if (typeof tokenVar !== "string" || !new RegExp(`^${prefix}[A-Z0-9_]{1,40}$`).test(tokenVar)) {
    return `The key's Vercel variable name must start with ${prefix} (for example ${prefix}WEATHER). Give only the name, never the key.`;
  }
  return null;
}

/**
 * Checks a custom look-up tool. Returns { spec, problems }: problems is a list of plain-language reasons it was
 * refused (empty when it is fine). `taken` is the set of connector names already in use.
 */
export function checkHttpTool(raw, env, taken = new Set()) {
  const problems = [];
  if (!raw || typeof raw !== "object") return { spec: null, problems: ["Nothing to check."] };
  const { name, projectId } = commonChecks(raw, env, problems, taken);
  const description = cleanText(raw.description, 300);
  const returns = cleanText(raw.returns, 300);
  if (description.length < 10 || description.length > 300) problems.push("Say what the tool does in 10 to 300 characters.");
  if (returns.length < 3 || returns.length > 300) problems.push("Say what it gives back in 3 to 300 characters.");
  const method = raw.method == null ? "GET" : String(raw.method).toUpperCase();
  if (method !== "GET") problems.push(`Only look-ups (GET) can be built. ${method} would send or change something, which waits for the approval gate.`);
  const addr = addressProblem(raw.url);
  if (addr) problems.push(`Address: ${addr}`);
  let url = null;
  if (!addr) {
    const u = new URL(raw.url.trim());
    for (const k of u.searchParams.keys()) {
      if (KEY_PARAM.test(k)) problems.push(`The address carries "${k}=…", which looks like a key. Put the key in a Vercel variable instead.`);
    }
    url = u.href;
  }
  const tokenVar = raw.tokenVar ? String(raw.tokenVar).trim() : null;
  const tp = tokenProblem(tokenVar, "ACP_TOOL_TOKEN_");
  if (tp) problems.push(tp);

  const inputs = [];
  const rawInputs = Array.isArray(raw.inputs) ? raw.inputs : [];
  if (rawInputs.length > MAX_INPUTS) problems.push(`Up to ${MAX_INPUTS} inputs.`);
  for (const i of rawInputs.slice(0, MAX_INPUTS)) {
    const n = cleanText(i?.name, 30);
    const type = Object.hasOwn(TYPES, i?.type) ? i.type : null;
    if (!INPUT_NAME.test(n)) { problems.push(`Input "${n.slice(0, 30)}": use lowercase letters, digits or _ (for example city).`); continue; }
    if (!type) { problems.push(`Input "${n}": pick text, number or yes/no.`); continue; }
    if (KEY_PARAM.test(n)) { problems.push(`Input "${n}" looks like a key. Keys come from a Vercel variable, never from the AI.`); continue; }
    if (inputs.some((x) => x.name === n)) { problems.push(`Input "${n}" is listed twice.`); continue; }
    if (url && new URL(url).searchParams.has(n)) { problems.push(`Input "${n}" is already fixed in the address.`); continue; }
    inputs.push({ name: n, type, description: cleanText(i.description, 200).slice(0, 200), required: i.required === true });
  }

  const words = writeWords(name, description, returns, url ? new URL(url).pathname : "", ...inputs.map((i) => `${i.name} ${i.description}`));
  if (words.length) {
    problems.push(`It sounds like it would change something ("${words.join('", "')}"). This builder only makes read-only look-up tools; ` +
      "anything that sends, posts, buys or changes waits for the approval gate.");
  }
  const sp = secretProblem(env, [name, description, returns, String(raw.url ?? ""), ...inputs.map((i) => i.description)]);
  if (sp) problems.push(sp);
  const rule = harmCheck([description, returns, ...inputs.map((i) => i.description)].join("\n"));
  if (rule) problems.push(`Refused by the workspace's rules: ${rule.reason}.`);
  const spec = { kind: "http", name, projectId, description, returns, url, method: "GET", inputs, tokenVar };
  return { spec, problems };
}

/** Checks an MCP connector the owner picked tools for. `listed` is what the server said it offers. */
export function checkMcpConnector(raw, env, listed, taken = new Set()) {
  const problems = [];
  if (!raw || typeof raw !== "object") return { spec: null, problems: ["Nothing to check."] };
  const { name, projectId } = commonChecks(raw, env, problems, taken);
  const addr = addressProblem(raw.url);
  if (addr) problems.push(`Address: ${addr}`);
  const tokenVar = raw.tokenVar ? String(raw.tokenVar).trim() : null;
  const tp = tokenProblem(tokenVar, "ACP_MCP_TOKEN_");
  if (tp) problems.push(tp);
  const picked = Array.isArray(raw.tools) ? raw.tools : [];
  if (!picked.length) problems.push("Pick at least one tool.");
  const tools = [];
  for (const t of picked.slice(0, 20)) {
    const tname = typeof t?.name === "string" ? t.name : "";
    const offered = listed.find((x) => x.name === tname);
    if (!offered) { problems.push(`The server doesn't offer a tool called "${tname.slice(0, 40)}".`); continue; }
    if (!offered.readOnly) { problems.push(`"${tname}" isn't marked read-only by the server, so it can't be turned on.`); continue; }
    const words = writeWords(tname);
    if (words.length) { problems.push(`"${tname}" sounds like it changes something ("${words.join('", "')}"), so it was refused.`); continue; }
    const args = {};
    for (const [k, v] of Object.entries(t.args && typeof t.args === "object" && !Array.isArray(t.args) ? t.args : {})) {
      if (offered.args[k] === v) args[k] = v;
    }
    tools.push({ name: tname, args });
  }
  const server = parseServer({ name: NAME.test(name) ? name : "x0", url: addr ? "https://x.invalid" : String(raw.url).trim(), tokenVar, tools });
  if (!server && !problems.length) problems.push("That combination of tools isn't valid.");
  const sp = secretProblem(env, [name, String(raw.url ?? "")]);
  if (sp) problems.push(sp);
  const spec = { kind: "mcp", name, projectId, url: addr ? null : new URL(String(raw.url).trim()).href, tokenVar, tools };
  return { spec, problems };
}

// A key variable can only go to one host: no connector can be pointed somewhere else to collect a key that
// belongs to another service.
export function tokenReuseProblem(spec, existing, env) {
  if (!spec.tokenVar) return null;
  const host = new URL(spec.url).host;
  const others = [
    ...existing.filter((c) => c.name !== spec.name).map((c) => ({ tokenVar: c.spec?.tokenVar, url: c.spec?.url })),
    ...mcpServers(env).map((s) => ({ tokenVar: s.tokenVar, url: s.url })),
  ];
  const clash = others.find((o) => o.tokenVar === spec.tokenVar && o.url && new URL(o.url).host !== host);
  return clash ? `The key in ${spec.tokenVar} already belongs to ${new URL(clash.url).host}, so it can't be sent to ${host}.` : null;
}

// What the server offers, for the owner to pick from. Each tool: name, description, whether the server marks it
// read-only, and its simple arguments (text, number, yes/no).
export async function inspectMcp(env, raw, net = guardedFetch) {
  const addr = addressProblem(raw?.url);
  if (addr) return { problems: [`Address: ${addr}`] };
  const tokenVar = raw.tokenVar ? String(raw.tokenVar).trim() : null;
  const tp = tokenProblem(tokenVar, "ACP_MCP_TOKEN_");
  if (tp) return { problems: [tp] };
  if (tokenVar && !env[tokenVar]) return { problems: [`The Vercel variable ${tokenVar} isn't set yet. Add the key there, redeploy, then check again.`] };
  let listed;
  try {
    ({ listed } = await connect(net, { name: "check", url: String(raw.url).trim(), tokenVar }, env));
  } catch {
    return { problems: ["The server didn't answer as an MCP server. Check the address, and the key if it needs one."] };
  }
  const tools = listed.filter((t) => t && typeof t.name === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(t.name)).slice(0, 50).map((t) => {
    const props = t.inputSchema?.properties && typeof t.inputSchema.properties === "object" ? t.inputSchema.properties : {};
    const args = Object.fromEntries(Object.entries(props)
      .filter(([k, v]) => /^[A-Za-z][A-Za-z0-9_]{0,39}$/.test(k) && ["string", "number", "boolean"].includes(v?.type))
      .slice(0, 8).map(([k, v]) => [k, v.type]));
    const readOnly = t.annotations?.readOnlyHint === true;
    const words = writeWords(t.name);
    return {
      name: t.name, description: typeof t.description === "string" ? t.description.replace(/\s+/g, " ").slice(0, 300) : "",
      readOnly, args, blocked: !readOnly ? "The server doesn't mark it read-only." : words.length ? `Sounds like it changes something ("${words.join('", "')}").` : null,
    };
  });
  return { problems: [], tools };
}

// ---------------------------------------------------------------------------------------------------------------
// The plain-language summary and the confirmation fingerprint

const money = (n) => "$" + Number(n).toFixed(n < 0.01 ? 3 : 2);
export function summary(spec, { projectName = null, caps = null } = {}) {
  const host = new URL(spec.url).host;
  const who = spec.projectId ? `Only the AIs in the project "${projectName ?? "this project"}".` : "The AIs in every project.";
  const key = spec.tokenVar
    ? `Uses the key you put in the Vercel variable ${spec.tokenVar}, sent only to ${host}. The key itself is never shown, stored here or given to an AI.`
    : "No key: it only reaches what is public at that address.";
  const cost = `Each use counts ${money(CALL_COST_USD)} against your spend caps${caps ? ` (${money(caps.month)} a month, ${money(caps.thread)} a thread)` : ""}. ` +
    "The red Stop everything button stops it, and the workspace's rules check every use.";
  const lines = [];
  if (spec.kind === "http") {
    const sends = spec.inputs.length
      ? `The AI fills in: ${spec.inputs.map((i) => `${i.name} (${TYPES[i.type]}${i.required ? ", required" : ""})`).join(", ")}. Whatever the AI types into these goes to ${host}, so only use a service you trust.`
      : "The AI can't send it anything: it always asks the same address.";
    lines.push(
      ["What it does", spec.description],
      ["Where it goes", `Only ${spec.url.split("?")[0]} (on ${host}). It can't follow redirects or reach private or internal addresses.`],
      ["What the AI can send", sends],
      ["What comes back", `${spec.returns} The AI treats this as information to read, never as instructions.`],
    );
  } else {
    lines.push(
      ["What it is", `The MCP server at ${spec.url}.`],
      ["Tools turned on", spec.tools.map((t) => `${t.name} (${Object.keys(t.args).length ? "the AI can send: " + Object.entries(t.args).map(([k, v]) => `${k} as ${TYPES[v]}`).join(", ") : "takes nothing"})`).join("; ")],
      ["What the AI can send", `Only the inputs listed above, up to 300 characters each, and never one of this site's keys. Whatever the AI types into them goes to ${host}.`],
      ["What comes back", "Whatever the server answers. The AI treats it as information to read, never as instructions."],
    );
  }
  lines.push(
    ["Login", key],
    ["What it can't do", spec.kind === "http"
      ? "It can only look things up (a GET request). It can't send, post, buy, delete or change anything, and you can switch it off at any time."
      : "It can only read. It can't send, post, buy, delete or change anything: only tools the server marks read-only are used, and you can switch it off at any time."],
    ["Who can use it", who],
    ["Cost and safety", cost],
  );
  return lines.map(([title, text]) => ({ title, text }));
}

const canonical = (v) => (Array.isArray(v) ? v.map(canonical)
  : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])])) : v);
// Changes whenever anything in the definition changes, so a confirmation only covers exactly what was shown.
export const fingerprint = (spec) => createHash("sha256").update(JSON.stringify(canonical(spec))).digest("hex").slice(0, 32);

// ---------------------------------------------------------------------------------------------------------------
// Turning saved connectors into tools for one chat

function checkInputs(env, inputs, args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new ToolError("Inputs must be an object.");
  const asArgs = Object.fromEntries(inputs.map((i) => [i.name, i.type]));
  const out = checkArgs(env, { name: "this tool", args: asArgs }, args);
  for (const i of inputs) if (i.required && !Object.hasOwn(out, i.name)) throw new ToolError(`"${i.name}" is required.`);
  return out;
}

function httpTool(row, net) {
  const spec = row.spec;
  const host = new URL(spec.url).host;
  const name = `tool_${row.name}`;
  return {
    name,
    description: `[Read-only look-up tool "${row.name}", built by the owner; it asks ${host}] ${spec.description} Gives back: ${spec.returns}`,
    parameters: {
      type: "object", additionalProperties: false,
      required: spec.inputs.filter((i) => i.required).map((i) => i.name),
      properties: Object.fromEntries(spec.inputs.map((i) => [i.name, { type: i.type, ...(i.description ? { description: i.description } : {}) }])),
    },
    costUsd: CALL_COST_USD,
    async run(env, args, _f, ctx = {}) {
      const safe = checkInputs(env, spec.inputs, args);
      const u = new URL(spec.url);
      for (const [k, v] of Object.entries(safe)) u.searchParams.set(k, String(v));
      if (addressProblem(u.href)) throw new ToolError("That address can't be used.");
      const token = spec.tokenVar ? String(env[spec.tokenVar] ?? "").trim() : "";
      if (spec.tokenVar && !token) throw new ToolError(`The ${row.name} tool isn't set up yet: its key variable is empty.`);
      ctx.audit?.("tool", `${name} (${host}${u.pathname})`, CALL_COST_USD);
      let res;
      try {
        res = await net(u.href, {
          method: "GET", redirect: "error", signal: AbortSignal.timeout(15_000),
          headers: { accept: "application/json, text/plain;q=0.9, text/*;q=0.5", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        });
      } catch {
        throw new ToolError(`The ${row.name} tool didn't answer, or its address was blocked.`);
      }
      // Only the status goes back to the model, never the service's own error text.
      if (!res.ok) throw new ToolError(`The ${row.name} tool returned an error (${res.status}).`);
      const type = (res.headers.get("content-type") ?? "").toLowerCase();
      if (type && !/^(?:text\/|application\/(?:json|xml|[\w.+-]+\+(?:json|xml))\b)/.test(type)) {
        throw new ToolError(`The ${row.name} tool sent something that isn't text.`);
      }
      const raw = (await res.text().catch(() => "")).slice(0, MAX_RESPONSE_BYTES);
      const text = raw.length > MAX_TEXT ? raw.slice(0, MAX_TEXT) + "\n…(cut)" : raw;
      return untrusted(`the owner's "${row.name}" tool (${host})`, text || "(It returned nothing.)");
    },
  };
}

/**
 * The tools from saved connectors that this project may use: switched on, confirmed, and for this project or all.
 * MCP connectors' tools are listed by asking each server (an unreachable one is skipped). `net` is the guarded
 * network function in production; tests pass a fake.
 */
export async function connectorTools(env, rows, projectId, net = guardedFetch) {
  const usable = rows.filter((r) => r.enabled && (!r.project_id || r.project_id === projectId) && r.fingerprint === fingerprint(r.spec));
  const tools = usable.filter((r) => r.kind === "http" && r.spec?.url && !addressProblem(r.spec.url)).map((r) => httpTool(r, net));
  const servers = usable.filter((r) => r.kind === "mcp" && r.spec?.url && !addressProblem(r.spec.url))
    .map((r) => parseServer({ name: r.name, url: r.spec.url, tokenVar: r.spec.tokenVar, tools: r.spec.tools })).filter(Boolean).slice(0, 5);
  if (servers.length) tools.push(...await mcpTools(env, net, servers, { net, costUsd: CALL_COST_USD, wrap: untrusted }));
  return tools;
}

// For the Tools page and the plugin list: what each connector is, without anything secret.
export const describeRow = (r) => ({
  id: r.id, name: r.name, kind: r.kind, projectId: r.project_id, enabled: r.enabled, created_at: r.created_at,
  confirmed: r.fingerprint === fingerprint(r.spec), spec: r.spec, host: r.spec?.url ? new URL(r.spec.url).host : null,
});
