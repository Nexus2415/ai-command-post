import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AgentKey } from "./config.ts";

/**
 * USD per million tokens. Free-tier entries cost 0 but are still metered.
 * These are placeholders: confirm current list prices before raising the budget above $0.
 */
export interface Rate {
  inputPerM: number;
  outputPerM: number;
  /** True when the provider offers a no-cost tier for this model that the engine may use at a $0 cap. */
  freeTier: boolean;
}

export const DEFAULT_RATES: Record<AgentKey, Rate> = {
  claude: { inputPerM: 3, outputPerM: 15, freeTier: false },
  chatgpt: { inputPerM: 0.25, outputPerM: 2, freeTier: false },
  gemini: { inputPerM: 0, outputPerM: 0, freeTier: true },
  perplexity: { inputPerM: 1, outputPerM: 1, freeTier: false },
};

export interface LedgerEntry {
  at: string;
  agent: AgentKey;
  issue: string;
  inputTokens: number;
  outputTokens: number;
  usd: number;
}

export interface LedgerState {
  month: string;
  entries: LedgerEntry[];
}

export function monthKey(d = new Date()): string {
  return d.toISOString().slice(0, 7);
}

export function costUsd(rate: Rate, inputTokens: number, outputTokens: number): number {
  return (inputTokens * rate.inputPerM + outputTokens * rate.outputPerM) / 1_000_000;
}

export class Budget {
  private state: LedgerState;
  private readonly path: string | null;
  readonly capUsd: number;
  readonly rates: Record<AgentKey, Rate>;

  /** Why the stored month-to-date spend can't be trusted, or null when it can. Paid calls are refused while set. */
  readonly ledgerProblem: string | null;

  /**
   * `resetMonth` (ACP_LEDGER_RESET) is the owner's acknowledgement, for that month only, that a missing or unreadable
   * ledger may restart at $0. Without it a lost ledger is not silently reset while paid calls are possible (ARN-83 F5).
   */
  constructor(opts: { capUsd: number; path?: string | null; rates?: Record<AgentKey, Rate>; now?: Date; resetMonth?: string }) {
    this.capUsd = opts.capUsd;
    this.path = opts.path ?? null;
    this.rates = { ...(opts.rates ?? DEFAULT_RATES) };
    const month = monthKey(opts.now);
    let loaded: LedgerState | null = null;
    let problem: string | null = null;
    if (this.path) {
      let raw: string | null = null;
      try {
        raw = readFileSync(this.path, "utf8");
      } catch {
        problem = "the spend ledger is missing";
      }
      if (raw !== null) {
        try {
          const v: unknown = JSON.parse(raw);
          loaded = validLedger(v) ? v : null;
        } catch {
          loaded = null;
        }
        if (!loaded) problem = "the spend ledger is unreadable";
        else if (loaded.month > month) problem = `the spend ledger is dated ${loaded.month}, after ${month}`;
      }
    }
    // Nothing paid can run at a $0 cap, so a fresh ledger is safe there; otherwise only the owner's reset for this month.
    if (problem && (this.capUsd <= 0 || opts.resetMonth === month)) problem = null;
    this.ledgerProblem = problem;
    this.state = !problem && loaded && loaded.month === month ? loaded : { month, entries: [] };
    // Keep a trusted ledger on disk every run so a later cap increase starts from a real record.
    if (!problem) this.persist();
  }

  spentUsd(): number {
    return this.state.entries.reduce((s, e) => s + e.usd, 0);
  }

  remainingUsd(): number {
    return Math.max(0, this.capUsd - this.spentUsd());
  }

  /**
   * Decide whether a call may run. A call is allowed when it is free, or when its
   * worst-case cost (all max output tokens used) still fits under the cap.
   */
  check(agent: AgentKey, estInputTokens: number, maxOutputTokens: number): { ok: true } | { ok: false; reason: string } {
    const rate = this.rates[agent];
    if (rate.freeTier) return { ok: true };
    const worst = costUsd(rate, estInputTokens, maxOutputTokens);
    if (this.capUsd <= 0) {
      return { ok: false, reason: `${agent} has no free tier and the monthly cap is $0` };
    }
    if (this.ledgerProblem) {
      return {
        ok: false,
        reason: `${agent} has no free tier and ${this.ledgerProblem}, so this month's spend can't be proven; set ACP_LEDGER_RESET=${this.state.month} to restart it at $0`,
      };
    }
    if (this.spentUsd() + worst > this.capUsd) {
      return {
        ok: false,
        reason: `${agent} call could cost up to $${worst.toFixed(4)}; only $${this.remainingUsd().toFixed(4)} left of $${this.capUsd.toFixed(2)}`,
      };
    }
    return { ok: true };
  }

  record(entry: Omit<LedgerEntry, "usd" | "at">): LedgerEntry {
    const full: LedgerEntry = {
      ...entry,
      at: new Date().toISOString(),
      usd: costUsd(this.rates[entry.agent], entry.inputTokens, entry.outputTokens),
    };
    this.state.entries.push(full);
    this.persist();
    return full;
  }

  summary(): { month: string; spentUsd: number; capUsd: number; calls: number; ledgerProblem: string | null } {
    return { month: this.state.month, spentUsd: this.spentUsd(), capUsd: this.capUsd, calls: this.state.entries.length, ledgerProblem: this.ledgerProblem };
  }

  private persist(): void {
    // An untrusted ledger is never overwritten: a fresh file would be trusted on the next run.
    if (!this.path || this.ledgerProblem) return;
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.state, null, 2));
  }
}

function validLedger(v: unknown): v is LedgerState {
  if (!v || typeof v !== "object") return false;
  const l = v as Record<string, unknown>;
  return typeof l["month"] === "string" && /^\d{4}-\d{2}$/.test(l["month"]) && Array.isArray(l["entries"]) &&
    l["entries"].every((e: unknown) => {
      const x = e as Record<string, unknown> | null;
      return !!x && typeof x["usd"] === "number" && Number.isFinite(x["usd"]) && x["usd"] >= 0;
    });
}

/** Rough token estimate (≈4 chars/token) used only for the pre-call budget check. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
