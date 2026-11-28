// Live worker activity view (ARN-163), shared by the Team map avatars and, later, the task-row worker avatar.
// It only reads the `activity` report /api/console returns (api/_lib/worker-activity.js) and fails closed: no report,
// a failed or incomplete read, a check older than the heartbeat window, an aged heartbeat or any shape it doesn't
// know all read "unknown". "Working" is a recent observation shown with its heartbeat age, never a live connection.
(function (root) {
  "use strict";
  const ENGINE = ["claude", "chatgpt", "perplexity", "gemini"];
  // Cards with no worker behind them get no live line: groups, and AIs the owner suspended (src/config.ts).
  const NO_LINE = ["shared", "none", "gemini"];
  const STATES = ["working", "idle", "blocked", "completed", "unknown"];
  const LABEL = { working: "Working", idle: "Idle", blocked: "Blocked", completed: "Finished", unknown: "Status unknown" };
  const ID_RE = /^[A-Z][A-Z0-9]{0,9}-[1-9]\d{0,8}$/;
  const WHY = { unconfigured: "No activity source is connected", incomplete: "Activity read was incomplete" };
  function ago(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 60) return s + "s ago";
    const m = Math.round(s / 60);
    return m < 60 ? m + " min ago" : Math.round(m / 60) + " h ago";
  }
  const unknown = detail => ({ state: "unknown", label: LABEL.unknown, detail });
  // The report as a whole: usable, or the reason it isn't.
  function usable(activity, nowMs) {
    if (!activity || typeof activity !== "object") return "No activity report";
    if (activity.status !== "reported") return WHY[activity.status] || "Activity couldn't be read";
    const readAt = Date.parse(activity.readAt), ttl = Number(activity.ttlMs);
    if (!isFinite(readAt) || !(ttl > 0)) return "Activity report is malformed";
    if (nowMs - readAt > ttl) return "Last check is too old; refresh to check again";
    return null;
  }
  /** What one AI's avatar may show; null for cards with no worker behind them. */
  function liveView(activity, key, nowMs) {
    if (NO_LINE.includes(key)) return null;
    if (!ENGINE.includes(key)) return unknown("Not run by the engine; not checked here");
    const bad = usable(activity, nowMs);
    if (bad) return unknown(bad);
    const a = activity.agents && activity.agents[key];
    if (!a || !STATES.includes(a.state)) return unknown("No activity report for this AI");
    const issue = typeof a.issue === "string" && ID_RE.test(a.issue) ? a.issue : null;
    const at = Date.parse(a.at);
    if (a.state === "working") {
      if (!issue || !isFinite(at) || nowMs - at > Number(activity.ttlMs)) return unknown("Last heartbeat is too old");
      const step = Number.isInteger(a.step) && a.step > 0 ? " · step " + a.step : "";
      return { state: "working", label: LABEL.working, detail: issue + step + " · last heartbeat " + ago(nowMs - at), issue };
    }
    if (a.state === "idle") return { state: "idle", label: LABEL.idle, detail: "No engine run is working on its tasks" };
    if (a.state === "unknown") return unknown(typeof a.reason === "string" ? a.reason.slice(0, 80) : "Activity can't be confirmed");
    const when = isFinite(at) ? " · " + ago(nowMs - at) : "";
    const label = a.state === "blocked" && a.stopped === true ? "Stopped" : LABEL[a.state];
    return { state: a.state, label, detail: (issue || "Task") + when, issue };
  }
  /**
   * Whether one task is being worked right now by any AI, by the same rules: true only for a fresh "working"
   * report naming this task; false otherwise, including when nothing can be checked. For a task-row avatar.
   */
  function taskWorking(activity, identifier, nowMs) {
    if (!ID_RE.test(String(identifier)) || usable(activity, nowMs)) return false;
    return ENGINE.some(k => {
      const v = liveView(activity, k, nowMs), a = activity.agents && activity.agents[k];
      return !!v && v.state === "working" && Array.isArray(a.issues) && a.issues.includes(identifier);
    });
  }
  root.ACPLive = { STATES, liveView, taskWorking };
})(typeof window !== "undefined" ? window : globalThis);
