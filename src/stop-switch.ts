// The engine obeys the site's "Stop everything" switch (ws_control row id 1 in the workspace Supabase project).
//
// Before this, the switch only stopped the website's own AI calls; the scheduled engine (GitHub Actions) never read
// it, so pressing Stop everything didn't stop an engine that was turned on. Now the engine reads the same row at the
// start of every run, before every model call and before every tool call. The check is plain code, not a prompt:
// no model can talk its way past it.
//
// Fail closed: a switch that can't be read (store down, missing row, odd answer, timeout) counts as stopped, exactly
// like the website (api/workspace.js). Uses the same ACP_WORKSPACE_DB_URL / ACP_WORKSPACE_DB_KEY (service_role) the
// site and the claim store use. When they're unset the switch isn't connected; src/cli.ts then refuses live writes.

export const STOPPED = "Everything is stopped: the owner pressed Stop everything. The engine does nothing until it is turned back on.";
export const UNREADABLE = "Everything is stopped: the Stop everything switch can't be read right now, so the engine does nothing (fail-safe).";

/** Returns null when the engine may go on, or the reason it must stop. Never throws. */
export type StopCheck = () => Promise<string | null>;

type Fetch = (url: string, init: { method: string; headers: Record<string, string>; signal: AbortSignal }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

export function stopSwitchFrom(env: Record<string, string | undefined>, fetchImpl: Fetch = fetch as unknown as Fetch, timeoutMs = 5_000): StopCheck | null {
  const url = env["ACP_WORKSPACE_DB_URL"]?.trim().replace(/\/+$/, "");
  const key = env["ACP_WORKSPACE_DB_KEY"]?.trim();
  if (!url || !key) return null;
  if (!/^https:\/\/[^/\s]+$/.test(url)) return async () => UNREADABLE;
  return async () => {
    try {
      const r = await fetchImpl(`${url}/rest/v1/ws_control?select=stopped&id=eq.1`, {
        method: "GET",
        headers: { apikey: key, authorization: `Bearer ${key}`, accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!r.ok) return UNREADABLE;
      const rows = await r.json();
      const row = Array.isArray(rows) ? (rows[0] as { stopped?: unknown } | undefined) : undefined;
      if (!row) return UNREADABLE; // a missing row reads as stopped, as on the site
      return row.stopped === false ? null : STOPPED;
    } catch {
      return UNREADABLE;
    }
  };
}

/** Wraps a check so a throwing implementation still fails closed. */
export async function haltReason(check: StopCheck | undefined): Promise<string | null> {
  if (!check) return null;
  try {
    return await check();
  } catch {
    return UNREADABLE;
  }
}
