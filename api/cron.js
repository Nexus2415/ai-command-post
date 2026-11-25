// Vercel cron (vercel.json "crons"): once a day, runs the workspace's scheduled agents (api/_lib/workspace-agents.js).
// Only Vercel's own call gets through: it must carry "Authorization: Bearer <CRON_SECRET>", and with CRON_SECRET
// unset (or shorter than 32 characters) every call is refused, so scheduled runs stay off until the owner adds it.
import { isCronCall } from "./_lib/workspace-agents.js";
import { runDueAgents } from "./workspace.js";
import { createSupabaseStore } from "./_lib/workspace-store.js";

export const config = { maxDuration: 120 };

export async function handleCron(req, env, makeStore = createSupabaseStore, deps = {}) {
  if (req.method !== "GET") return { status: 405, body: { error: "GET only" } };
  if (!isCronCall(req, env)) return { status: 401, body: { error: "Not allowed." } };
  return runDueAgents(env, makeStore, deps);
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  const out = await handleCron(req, process.env);
  res.status(out.status).json(out.body);
}
