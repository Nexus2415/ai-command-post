// Scheduled agents (2026-11-25): an instruction the owner saves in a project that runs by itself, daily or weekly.
//
// Each run is one ordinary workspace question, sent through the same chat path as the owner's own questions, so
// every fence applies unchanged: the Stop everything switch (checked first; a stopped or unreadable switch skips the
// run), the rules gate, the $15/month workspace cap and the per-thread cap, read-only web tools, and the approval
// gate (an agent can only PROPOSE a Linear issue or comment; nothing happens until the owner approves it).
//
// Each agent writes into its own thread, one per calendar month ("⏰ name · 2026-11"), so the per-thread cap is a
// per-agent monthly cap too. A run is claimed in one conditional database update before it starts, so a repeated
// cron call (or a double click on "Run now") never runs it twice.
import { timingSafeEqual, createHash } from "node:crypto";

export const MAX_AGENTS = 5;
export const MAX_PROMPT = 4_000;
export const CADENCES = Object.freeze(["daily", "weekly"]);
export const WEEKDAYS = Object.freeze(["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]);
// Vercel's free plan runs a cron at most once a day, at some minute inside the hour given in vercel.json.
export const CRON_HOUR_UTC = 12;
// "Run now" may not start the same agent again within this many milliseconds.
export const RUN_NOW_GAP_MS = 2 * 60_000;
// The cron call is refused unless CRON_SECRET is set and at least this long (Vercel sends it as a Bearer token).
export const MIN_SECRET = 32;
export const RUN_MARK = "[Scheduled run]";

export class AgentProblem extends Error {}

const clean = (v, max) => (typeof v === "string" && v.trim().length >= 1 && v.trim().length <= max ? v.trim() : null);

/** Checks a new agent. Returns the row to save, or throws AgentProblem. `models` are the thread models allowed. */
export function checkAgent(args, models) {
  const name = clean(args?.name, 60);
  if (!name || /[\u0000-\u001f<>]/.test(name)) throw new AgentProblem("Give the agent a plain name of up to 60 characters.");
  const prompt = clean(args.prompt, MAX_PROMPT);
  if (!prompt) throw new AgentProblem(`Tell the agent what to do, in up to ${MAX_PROMPT.toLocaleString("en-US")} characters.`);
  const model = args.model ?? "claude";
  if (!models.includes(model)) throw new AgentProblem("Pick which AI runs it.");
  const cadence = args.cadence ?? "daily";
  if (!CADENCES.includes(cadence)) throw new AgentProblem("Pick daily or weekly.");
  let weekday = null;
  if (cadence === "weekly") {
    weekday = Number(args.weekday);
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) throw new AgentProblem("Pick the day of the week.");
  }
  return { name, prompt, model, cadence, weekday };
}

export const dayStart = (now) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
export const monthKey = (now) => now.toISOString().slice(0, 7);
export const threadTitle = (agent, now) => `⏰ ${agent.name} · ${monthKey(now)}`;
// Due on this cron call: switched on, and today is its day. (The claim stops a second run on the same day.)
export const isDue = (agent, now) => agent.enabled === true && (agent.cadence === "daily" || (agent.cadence === "weekly" && agent.weekday === now.getUTCDay()));
export function describeSchedule(agent) {
  const at = `around ${CRON_HOUR_UTC}:00 UTC`;
  return agent.cadence === "weekly" ? `Every ${WEEKDAYS[agent.weekday] ?? "week"}, ${at}` : `Every day, ${at}`;
}
export const runMessage = (agent, now) => `${RUN_MARK} ${agent.name}, ${now.toISOString().slice(0, 16).replace("T", " ")} UTC\n\n${agent.prompt}`;

// Constant-time check of Vercel's cron call. An unset or short CRON_SECRET never matches (scheduled runs stay off).
export function cronReady(env) {
  return typeof env.CRON_SECRET === "string" && env.CRON_SECRET.length >= MIN_SECRET;
}
export function isCronCall(req, env) {
  if (!cronReady(env)) return false;
  const got = req.headers?.authorization;
  if (typeof got !== "string" || got.length > 1024) return false;
  const h = (s) => createHash("sha256").update(s).digest();
  return timingSafeEqual(h(got), h(`Bearer ${env.CRON_SECRET}`));
}
