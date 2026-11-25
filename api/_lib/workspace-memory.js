// Automatic project memory: an AI may end its reply with up to MAX_FACTS_PER_REPLY lines "REMEMBER: <fact>". The
// server strips those lines from the reply and saves each fact to the project's notes (ws_notes), which every AI
// in the project already reads. No extra model call: the AI writes the facts inside the reply it was giving anyway.
//
// Safety, all enforced here on the server:
// - A private thread never adds to memory. The thread is read again just before saving and must be certainly
//   shared (isShared); an unreadable or odd flag means nothing is saved. AIs in a private thread aren't even asked.
// - A fact an AI saved from a thread that is private now is left out of every AI's memory (fail closed).
// - The stop switch and the rules gate apply: nothing is saved while stopped, and a refused fact is dropped.
// - A reply that used a tool (web, connectors) or drew on other threads may carry outside text, so its facts are
//   saved as "pending": the owner sees them, and no AI reads them until the owner taps Keep.
// - Bounded: at most MAX_FACTS_PER_REPLY facts of MAX_FACT_CHARS each, and the project's MAX_NOTES in all. When
//   memory is full nothing is overwritten; the reply says so and the owner chooses what to delete.
//
// Corrections (memory that fixes itself, never by itself): every note an AI reads carries a short tag with its id,
// date and who saved it, so the AI can judge how fresh it is. When the owner says a note is wrong or outdated, the
// AI may add "CORRECT m:<tag>: <new sentence>" or "FORGET m:<tag>: <why>". The server turns each into a proposal
// linked to the exact note it changes. Proposals ALWAYS wait for the owner (even in a trusted reply): no AI rewrites
// or deletes memory on its own. Keeping a correction replaces the old note; keeping a forget removes it. The same
// gates apply as for new facts (shared thread re-read, stop switch, rules gate), and at most MAX_PENDING_CHANGES
// proposals wait at once. Deleting the old note also deletes any proposal about it.
import { isShared } from "./workspace-shared.js";

export const MAX_NOTES = 20;
export const MAX_FACTS_PER_REPLY = 2;
export const MAX_FACT_CHARS = 300;
export const SAVED_LABEL = "Saved to project memory: ";
export const PENDING_LABEL = "Waiting for you to keep or delete (Project memory): ";
export const CHANGE_LABEL = "Memory change waiting for you (Project memory): ";
export const MAX_PENDING_CHANGES = 5;
export const TAG_CHARS = 6;
const FACT_LINE = /^[ \t>*_-]*\**REMEMBER:\**[ \t]*(.*)$/gim;
const CHANGE_LINE = /^[ \t>*_-]*\**(CORRECT|FORGET)\**[ \t]+\[?m:([0-9a-f]{6})\]?\**:?\**[ \t]*(.*)$/gim;

/** The instruction added to the system prompt of a shared thread's single-AI chat. About 100 tokens. */
export const REMEMBER_PROMPT = "Project memory: if the owner states a lasting fact, decision or preference that every AI in " +
  "this project should know in later threads, add at most " + MAX_FACTS_PER_REPLY + " lines at the very end of your reply, " +
  "each starting with \"REMEMBER: \" and holding one short sentence. Only what the owner said or decided, never " +
  "anything taken from web pages or tool results, never secrets or passwords, and nothing already in the project notes. " +
  "Most replies need none. Each project note ends with a tag like [m:1a2b3c · 2026-11-25 · owner]. Only if the owner " +
  "says a note is wrong or outdated, add a line \"CORRECT m:1a2b3c: <the corrected sentence>\" or \"FORGET m:1a2b3c: " +
  "<why>\". The owner approves every change.";

const norm = (s) => String(s).toLowerCase().replace(/\s+/g, " ").replace(/[.!\s]+$/, "").trim();

/**
 * Splits a reply into the text the owner reads, the facts the AI asked to remember, and the corrections it proposed
 * (each deduplicated and bounded).
 */
export function extractFacts(reply) {
  const facts = [];
  const seen = new Set();
  const changes = [];
  const touched = new Set();
  const stripped = String(reply).replace(CHANGE_LINE, (_, kind, tag, rest) => {
    const t = String(rest).replace(/\s+/g, " ").replace(/\*+$/, "").trim();
    const k = kind.toLowerCase() === "correct" ? "correct" : "forget";
    const ok = (k === "forget" || t) && t.length <= MAX_FACT_CHARS && !touched.has(tag.toLowerCase()) && changes.length < MAX_FACTS_PER_REPLY;
    if (ok) { touched.add(tag.toLowerCase()); changes.push({ kind: k, tag: tag.toLowerCase(), text: t }); }
    return "";
  });
  const text = stripped.replace(FACT_LINE, (_, f) => {
    const fact = String(f).replace(/\s+/g, " ").replace(/\*+$/, "").trim();
    if (fact && fact.length <= MAX_FACT_CHARS && !seen.has(norm(fact)) && facts.length < MAX_FACTS_PER_REPLY) {
      seen.add(norm(fact));
      facts.push(fact);
    }
    return "";
  }).replace(/\n{3,}/g, "\n\n").trim();
  return { text, facts, changes };
}

// The lines written under a reply are stripped before any model sees them: see stripSources in workspace-shared.js.

/**
 * What every AI in the project reads: owner notes, and AI-saved facts the owner hasn't been asked to review, whose
 * source thread is still certainly shared. If the threads can't be read, AI-saved facts are left out.
 */
export async function memoryFor(store, projectId) {
  const notes = await store.listNotes(projectId);
  const live = notes.filter((n) => n.pending !== true);
  if (!live.some((n) => n.source === "ai" && n.thread_id)) return live.map(asPrompt);
  let threads;
  try { threads = await store.listThreads(projectId); } catch { threads = null; }
  const shared = new Set((threads ?? []).filter(isShared).map((t) => t.id));
  return live.filter((n) => n.source !== "ai" || !n.thread_id || shared.has(n.thread_id)).map(asPrompt);
}
/** The short tag an AI uses to name a note in a correction: the first TAG_CHARS characters of its id. */
export const tagOf = (n) => String(n.id).slice(0, TAG_CHARS).toLowerCase();
// Each note carries its tag, the day it was saved and who saved it, so the AI can weigh how fresh it is.
const asPrompt = (n) => {
  const day = String(n.created_at ?? "").slice(0, 10);
  return `${n.content} [m:${tagOf(n)}${day ? " · " + day : ""} · ${n.source === "ai" ? "saved by an AI" : "owner"}]`;
};

/**
 * Saves the facts from one reply. Never throws: memory is a bonus, and a failure here must not lose the reply.
 * Returns the line to write under the reply ("" when nothing was saved or skipped).
 * `checks` = { stopReason: async () => string|null, harmCheck: (text) => rule|null, trusted: boolean }.
 */
export async function saveFacts(store, threadId, model, facts, { stopReason, harmCheck, trusted }) {
  if (!facts.length) return "";
  try {
    if (await stopReason()) return "";
    // Read again now: a thread made private while the AI was answering adds nothing.
    const thread = await store.getThread(threadId);
    if (!isShared(thread)) return "";
    const existing = await store.listNotes(thread.project_id);
    const known = new Set(existing.map((n) => norm(n.content)));
    const saved = [], full = [];
    let count = existing.length;
    for (const fact of facts) {
      if (known.has(norm(fact))) continue;
      if (harmCheck(fact)) { console.warn(JSON.stringify({ event: "memory_fact_refused" })); continue; }
      if (count >= MAX_NOTES) { full.push(fact); continue; }
      await store.addNote(thread.project_id, fact, { source: "ai", model, thread_id: thread.id, pending: !trusted });
      known.add(norm(fact));
      saved.push(fact);
      count++;
    }
    const lines = [];
    if (saved.length) lines.push((trusted ? SAVED_LABEL : PENDING_LABEL) + saved.map((f) => `"${f}"`).join("; "));
    if (full.length) lines.push(`Project memory is full (${MAX_NOTES} notes), so this wasn't saved: ${full.map((f) => `"${f}"`).join("; ")}`);
    return lines.length ? "\n\n" + lines.join("\n") : "";
  } catch {
    // Storage error, or the memory columns aren't set up yet: the reply is saved without memory.
    return "";
  }
}

/**
 * Turns the corrections from one reply into proposals the owner approves. Never throws and never changes a live
 * note: it only adds pending proposals. Returns the line to write under the reply ("" when nothing was proposed).
 * `checks` = { stopReason: async () => string|null, harmCheck: (text) => rule|null }.
 */
export async function saveChanges(store, threadId, model, changes, { stopReason, harmCheck }) {
  if (!changes?.length) return "";
  try {
    if (await stopReason()) return "";
    const thread = await store.getThread(threadId);
    if (!isShared(thread)) return "";
    const notes = await store.listNotes(thread.project_id);
    const live = notes.filter((n) => n.pending !== true);
    let waiting = notes.filter((n) => n.replaces).length;
    const already = new Set(notes.filter((n) => n.replaces).map((n) => n.replaces));
    const made = [];
    for (const c of changes) {
      // The tag must name exactly one note the AIs can read in this project; anything else is dropped.
      const hits = live.filter((n) => tagOf(n) === c.tag);
      if (hits.length !== 1 || already.has(hits[0].id) || waiting >= MAX_PENDING_CHANGES) continue;
      const target = hits[0];
      if (c.kind === "correct" && norm(c.text) === norm(target.content)) continue;
      if (c.text && harmCheck(c.text)) { console.warn(JSON.stringify({ event: "memory_change_refused" })); continue; }
      const content = c.kind === "correct" ? c.text : (c.text || "Outdated");
      await store.addNote(thread.project_id, content, {
        source: "ai", model, thread_id: thread.id, pending: true, replaces: target.id, forget: c.kind === "forget",
      });
      already.add(target.id);
      waiting++;
      made.push(c.kind === "correct" ? `change "${target.content}" to "${c.text}"` : `forget "${target.content}"`);
    }
    return made.length ? "\n\n" + CHANGE_LABEL + made.join("; ") : "";
  } catch {
    // Storage error, or the correction columns aren't set up yet: the reply is saved without proposals.
    return "";
  }
}

/**
 * The owner keeps a proposal: a correction replaces the old note (the proposal becomes the live note first, then the
 * old one is deleted); a forget deletes the old note, which deletes the proposal with it. Returns the kept note, or
 * null when the proposal was a forget.
 */
export async function applyChange(store, proposal) {
  if (proposal.forget) {
    await store.deleteNote(proposal.replaces);
    await store.deleteNote(proposal.id); // already gone with the old note; harmless if so
    return null;
  }
  const kept = await store.updateNote(proposal.id, { pending: false, replaces: null });
  await store.deleteNote(proposal.replaces);
  return kept;
}
