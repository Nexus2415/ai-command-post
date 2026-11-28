import { isSuspended, type AgentKey, type Config } from "./config.ts";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** Provider-reported observations only, not an authenticated gateway usage receipt or settlement authority. */
export interface ReportedUsage {
  provider: string;
  requestedModel: string;
  reportedModel: string;
  responseId: string;
  totalInputTokens: number;
  outputTokens: number;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningTokens: number | null;
}

export interface ChatResult {
  reportedUsage?: ReportedUsage;
  text: string;
  inputTokens: number;
  outputTokens: number;
  /** True when the provider stopped because the reply hit the output-token limit, so the text is cut off. */
  truncated?: boolean;
}

export interface ModelClient {
  chat(messages: ChatMessage[], opts: { maxOutputTokens: number }): Promise<ChatResult>;
}

type Fetch = typeof fetch;

export class ProviderError extends Error {
  readonly provider: string;
  readonly status: number;
  constructor(provider: string, status: number, message: string) {
    super(`${provider} ${status}: ${message}`);
    this.provider = provider;
    this.status = status;
  }
}

// Metered engine calls have exactly one admission/ledger reservation each. Retrying within
// this transport would create another potentially billable request without a fresh admission.
// The legacy suspended Gemini client retains its free-tier fixture retry behavior.
const RETRYABLE = new Set([429, 500, 502, 503, 504, 529]);
let retryDelaysMs = [5_000, 15_000];
export function setRetryDelays(ms: number[]): void {
  retryDelaysMs = ms;
}

async function postJson(f: Fetch, provider: string, url: string, headers: Record<string, string>, body: unknown, retryBusy = false): Promise<any> {
  let res: Response;
  let text: string;
  for (let attempt = 0; ; attempt++) {
    res = await f(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      redirect: "error", // Do not silently repeat a POST or send its body to a different origin.
      signal: AbortSignal.timeout(120_000),
    });
    text = await res.text();
    const wait = retryDelaysMs[attempt];
    if (res.ok || !retryBusy || !RETRYABLE.has(res.status) || wait === undefined) break;
    await new Promise((r) => setTimeout(r, wait));
  }
  if (!res.ok) throw new ProviderError(provider, res.status, text.slice(0, 500));
  try {
    return JSON.parse(text);
  } catch {
    throw new ProviderError(provider, res.status, "Response was not JSON");
  }
}

// Never convert a malformed/missing metered response into zero usage. Reported counts are not proof of tariff, cost or authority.
function usageCount(provider: string, value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new ProviderError(provider, 200, "Invalid reported usage: " + field);
  return value;
}
function optionalCount(provider: string, value: unknown, field: string): number | null {
  return value == null ? null : usageCount(provider, value, field);
}
function identity(provider: string, value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(value)) throw new ProviderError(provider, 200, "Invalid provider response " + field);
  return value;
}
function observedUsage(provider: string, requestedModel: string, j: any, maxOutputTokens: number): ReportedUsage {
  const u = j?.usage;
  if (!u || typeof u !== "object" || Array.isArray(u)) throw new ProviderError(provider, 200, "Missing reported usage");
  const responseId = identity(provider, j.id, "ID"), reportedModel = identity(provider, j.model, "model");
  // Preserve both identities. Aliases are legitimate for legacy chat but cannot establish a paid pinned-tariff match.
  const anthropic = provider === "anthropic";
  const input = usageCount(provider, anthropic ? u.input_tokens : u.prompt_tokens, "input");
  const outputTokens = usageCount(provider, anthropic ? u.output_tokens : u.completion_tokens, "output");
  const cacheReadTokens = optionalCount(provider, anthropic ? u.cache_read_input_tokens : u.prompt_tokens_details?.cached_tokens, "cache read");
  const cacheWriteTokens = optionalCount(provider, anthropic ? u.cache_creation_input_tokens : u.prompt_tokens_details?.cache_write_tokens, "cache write");
  const reasoningTokens = optionalCount(provider, anthropic ? null : u.completion_tokens_details?.reasoning_tokens, "reasoning");
  const totalInputTokens = anthropic ? input + (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0) : input;
  if (!Number.isSafeInteger(totalInputTokens + outputTokens) || outputTokens > maxOutputTokens || (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0) > totalInputTokens || (reasoningTokens ?? 0) > outputTokens) throw new ProviderError(provider, 200, "Reported usage exceeds bounds");
  if (!anthropic && usageCount(provider, u.total_tokens, "total") !== totalInputTokens + outputTokens) throw new ProviderError(provider, 200, "Inconsistent reported token total");
  return { provider, requestedModel, reportedModel, responseId, totalInputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens };
}

function splitSystem(messages: ChatMessage[]): { system: string; rest: ChatMessage[] } {
  const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  return { system, rest: messages.filter((m) => m.role !== "system") };
}

export function anthropicClient(apiKey: string, model: string, f: Fetch = fetch): ModelClient {
  return {
    async chat(messages, { maxOutputTokens }) {
      const { system, rest } = splitSystem(messages);
      const j = await postJson(
        f,
        "anthropic",
        "https://api.anthropic.com/v1/messages",
        { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
        { model, max_tokens: maxOutputTokens, system, messages: rest },
      );
      const text = (j.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
      const reportedUsage = observedUsage("anthropic", model, j, maxOutputTokens);
      return { text, inputTokens: reportedUsage.totalInputTokens, outputTokens: reportedUsage.outputTokens, reportedUsage, truncated: j.stop_reason === "max_tokens" };
    },
  };
}

/** OpenAI and Perplexity both speak the chat-completions shape. */
export function chatCompletionsClient(provider: string, baseUrl: string, apiKey: string, model: string, f: Fetch = fetch): ModelClient {
  return {
    async chat(messages, { maxOutputTokens }) {
      const body: Record<string, unknown> = { model, messages };
      body[provider === "openai" ? "max_completion_tokens" : "max_tokens"] = maxOutputTokens;
      const j = await postJson(f, provider, `${baseUrl}/chat/completions`, { authorization: `Bearer ${apiKey}` }, body);
      const text = j.choices?.[0]?.message?.content ?? "";
      if (typeof text !== "string") throw new ProviderError(provider, 200, "Invalid response text");
      const reportedUsage = observedUsage(provider, model, j, maxOutputTokens);
      const citations: string[] = Array.isArray(j.citations) ? j.citations : [];
      const withCites = citations.length ? `${text}\n\nSources:\n${citations.map((c) => `- ${c}`).join("\n")}` : text;
      return {
        text: withCites,
        inputTokens: reportedUsage.totalInputTokens,
        outputTokens: reportedUsage.outputTokens,
        reportedUsage,
        truncated: j.choices?.[0]?.finish_reason === "length",
      };
    },
  };
}

export function geminiClient(apiKey: string, model: string, f: Fetch = fetch): ModelClient {
  return {
    async chat(messages, { maxOutputTokens }) {
      const { system, rest } = splitSystem(messages);
      const j = await postJson(
        f,
        "gemini",
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        { "x-goog-api-key": apiKey },
        {
          ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
          contents: rest.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] })),
          generationConfig: { maxOutputTokens },
        },
        true, // Legacy free-tier client only; buildClients refuses suspended Gemini.
      );
      const text = (j.candidates?.[0]?.content?.parts ?? []).map((p: any) => p.text ?? "").join("");
      return {
        text,
        inputTokens: j.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: j.usageMetadata?.candidatesTokenCount ?? 0,
        truncated: j.candidates?.[0]?.finishReason === "MAX_TOKENS",
      };
    },
  };
}

/**
 * Builds a client for each agent whose API key is present. Missing keys simply leave that agent offline.
 * Suspended agents (ARN-115) get no client even when their key is present, so they can never be called.
 */
export function buildClients(cfg: Config, f: Fetch = fetch): Partial<Record<AgentKey, ModelClient>> {
  const out: Partial<Record<AgentKey, ModelClient>> = {};
  const add = (key: AgentKey, apiKey: string | undefined, make: (k: string) => ModelClient) => {
    if (apiKey && !isSuspended(key)) out[key] = make(apiKey);
  };
  add("claude", cfg.keys.anthropic, (k) => anthropicClient(k, cfg.models.claude, f));
  add("chatgpt", cfg.keys.openai, (k) => chatCompletionsClient("openai", "https://api.openai.com/v1", k, cfg.models.chatgpt, f));
  add("gemini", cfg.keys.gemini, (k) => geminiClient(k, cfg.models.gemini, f));
  add("perplexity", cfg.keys.perplexity, (k) => chatCompletionsClient("perplexity", "https://api.perplexity.ai", k, cfg.models.perplexity, f));
  return out;
}
