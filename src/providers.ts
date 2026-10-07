import type { AgentKey, Config } from "./config.ts";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
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

// Free tiers often answer "busy" (429/5xx) for a few seconds; retry those before giving up on the tick.
const RETRYABLE = new Set([429, 500, 502, 503, 504]);
let retryDelaysMs = [5_000, 15_000];
export function setRetryDelays(ms: number[]): void {
  retryDelaysMs = ms;
}

async function postJson(f: Fetch, provider: string, url: string, headers: Record<string, string>, body: unknown): Promise<any> {
  let res: Response;
  let text: string;
  for (let attempt = 0; ; attempt++) {
    res = await f(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    text = await res.text();
    const wait = retryDelaysMs[attempt];
    if (res.ok || !RETRYABLE.has(res.status) || wait === undefined) break;
    await new Promise((r) => setTimeout(r, wait));
  }
  if (!res.ok) throw new ProviderError(provider, res.status, text.slice(0, 500));
  try {
    return JSON.parse(text);
  } catch {
    throw new ProviderError(provider, res.status, "Response was not JSON");
  }
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
      return { text, inputTokens: j.usage?.input_tokens ?? 0, outputTokens: j.usage?.output_tokens ?? 0 };
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
      const citations: string[] = Array.isArray(j.citations) ? j.citations : [];
      const withCites = citations.length ? `${text}\n\nSources:\n${citations.map((c) => `- ${c}`).join("\n")}` : text;
      return { text: withCites, inputTokens: j.usage?.prompt_tokens ?? 0, outputTokens: j.usage?.completion_tokens ?? 0 };
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
      );
      const text = (j.candidates?.[0]?.content?.parts ?? []).map((p: any) => p.text ?? "").join("");
      return {
        text,
        inputTokens: j.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: j.usageMetadata?.candidatesTokenCount ?? 0,
      };
    },
  };
}

/** Builds a client for each agent whose API key is present. Missing keys simply leave that agent offline. */
export function buildClients(cfg: Config, f: Fetch = fetch): Partial<Record<AgentKey, ModelClient>> {
  const out: Partial<Record<AgentKey, ModelClient>> = {};
  if (cfg.keys.anthropic) out.claude = anthropicClient(cfg.keys.anthropic, cfg.models.claude, f);
  if (cfg.keys.openai) out.chatgpt = chatCompletionsClient("openai", "https://api.openai.com/v1", cfg.keys.openai, cfg.models.chatgpt, f);
  if (cfg.keys.gemini) out.gemini = geminiClient(cfg.keys.gemini, cfg.models.gemini, f);
  if (cfg.keys.perplexity) out.perplexity = chatCompletionsClient("perplexity", "https://api.perplexity.ai", cfg.keys.perplexity, cfg.models.perplexity, f);
  return out;
}
