// Model calls for the workspace chat (Phase 1 step 3). A small website-side twin of src/providers.ts and
// src/budget.ts: the website functions don't load the engine's TypeScript. test/workspace-chat.test.ts keeps
// the rates and suspensions identical to the engine's.

// USD per million tokens plus any flat per-request fee. Same values and sources as DEFAULT_RATES in src/budget.ts.
export const RATES = Object.freeze({
  claude: { inputPerM: 2, outputPerM: 10, freeTier: false },
  chatgpt: { inputPerM: 0.25, outputPerM: 2, freeTier: false },
  gemini: { inputPerM: 0, outputPerM: 0, freeTier: true },
  perplexity: { inputPerM: 1, outputPerM: 1, perRequestUsd: 0.012, freeTier: false },
});

// Same as SUSPENDED_AGENTS in src/config.ts (Darius blocked Gemini on 2026-10-09, ARN-115). Lifting it needs his
// written decision and a reviewed change in both places.
export const SUSPENDED_MODELS = Object.freeze(["gemini"]);

const KEY_VARS = { claude: "ANTHROPIC_API_KEY", chatgpt: "OPENAI_API_KEY", gemini: "GEMINI_API_KEY", perplexity: "PERPLEXITY_API_KEY" };
const MODEL_VARS = { claude: "ACP_MODEL_CLAUDE", chatgpt: "ACP_MODEL_CHATGPT", gemini: "ACP_MODEL_GEMINI", perplexity: "ACP_MODEL_PERPLEXITY" };
const DEFAULT_IDS = { claude: "claude-sonnet-5-5", chatgpt: "gpt-5-mini", gemini: "gemini-2.5-flash", perplexity: "sonar" };

export const MAX_OUTPUT_TOKENS = 2048;
// History sent with each message: the newest messages up to this many characters.
export const MAX_HISTORY_CHARS = 60_000;

export class ModelError extends Error {}

export function modelStatus(env, model) {
  if (SUSPENDED_MODELS.includes(model)) return { ready: false, reason: "Turned off by the owner." };
  if (!env[KEY_VARS[model]]) return { ready: false, reason: "No API key added yet." };
  return { ready: true, reason: null, id: env[MODEL_VARS[model]] || DEFAULT_IDS[model] };
}

export function costUsd(model, inputTokens, outputTokens) {
  const r = RATES[model];
  return (inputTokens * r.inputPerM + outputTokens * r.outputPerM) / 1_000_000 + (r.perRequestUsd ?? 0);
}

// Worst case for one reply, used before the call: about one token per 3 characters (tokens usually cover ~4),
// and the full output allowance.
export function estimateUsd(model, history) {
  const chars = history.reduce((n, m) => n + m.content.length, 0);
  return costUsd(model, Math.ceil(chars / 3) + 50, MAX_OUTPUT_TOKENS);
}

// Newest messages that fit the character allowance, oldest first, starting with a user message.
export function trimHistory(messages) {
  const out = [];
  let chars = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (chars + m.content.length > MAX_HISTORY_CHARS) break;
    chars += m.content.length;
    out.unshift({ role: m.role, content: m.content });
  }
  while (out.length && out[0].role !== "user") out.shift();
  return out;
}

async function postJson(f, url, headers, body) {
  let res;
  try {
    res = await f(url, {
      method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
      signal: AbortSignal.timeout(55_000),
    });
  } catch {
    throw new ModelError("The AI provider didn't answer in time.");
  }
  // Never relay the provider's error text: it can echo request details.
  if (!res.ok) throw new ModelError(`The AI provider returned an error (${res.status}).`);
  const j = await res.json().catch(() => null);
  if (!j || typeof j !== "object") throw new ModelError("The AI provider sent an invalid response.");
  return j;
}

const SYSTEM = "You are an assistant in the AI Command Post workspace for Arnexyia. Answer clearly and concisely.";

export async function callModel(env, model, history, f = fetch) {
  const status = modelStatus(env, model);
  if (!status.ready) throw new ModelError(status.reason);
  const key = String(env[KEY_VARS[model]]).trim();
  let text = "", input = 0, output = 0;
  if (model === "claude") {
    const j = await postJson(f, "https://api.anthropic.com/v1/messages",
      { "x-api-key": key, "anthropic-version": "2023-06-01" },
      { model: status.id, max_tokens: MAX_OUTPUT_TOKENS, system: SYSTEM, messages: history });
    text = (j.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("");
    input = j.usage?.input_tokens ?? 0; output = j.usage?.output_tokens ?? 0;
  } else if (model === "chatgpt" || model === "perplexity") {
    const base = model === "chatgpt" ? "https://api.openai.com/v1" : "https://api.perplexity.ai";
    const limit = model === "chatgpt" ? { max_completion_tokens: MAX_OUTPUT_TOKENS } : { max_tokens: MAX_OUTPUT_TOKENS };
    const j = await postJson(f, `${base}/chat/completions`, { authorization: `Bearer ${key}` },
      { model: status.id, messages: [{ role: "system", content: SYSTEM }, ...history], ...limit });
    text = j.choices?.[0]?.message?.content ?? "";
    const cites = Array.isArray(j.citations) ? j.citations.filter((c) => typeof c === "string") : [];
    if (cites.length) text += `\n\nSources:\n${cites.map((c) => `- ${c}`).join("\n")}`;
    input = j.usage?.prompt_tokens ?? 0; output = j.usage?.completion_tokens ?? 0;
  } else {
    const j = await postJson(f,
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(status.id)}:generateContent`,
      { "x-goog-api-key": key },
      {
        systemInstruction: { parts: [{ text: SYSTEM }] },
        contents: history.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
        generationConfig: { maxOutputTokens: MAX_OUTPUT_TOKENS },
      });
    text = (j.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("");
    input = j.usageMetadata?.promptTokenCount ?? 0; output = j.usageMetadata?.candidatesTokenCount ?? 0;
  }
  const inputTokens = Math.max(0, Math.floor(Number(input) || 0));
  const outputTokens = Math.max(0, Math.floor(Number(output) || 0));
  const reply = String(text).slice(0, 32_000).trim() || "(The AI sent an empty reply.)";
  return { text: reply, inputTokens, outputTokens, costUsd: costUsd(model, inputTokens, outputTokens) };
}
