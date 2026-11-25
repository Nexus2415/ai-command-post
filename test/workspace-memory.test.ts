import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { handle } from "../api/workspace.js";
import { createMemoryStore, createSupabaseStore } from "../api/_lib/workspace-store.js";
import { MAX_FACT_CHARS, MAX_NOTES, PENDING_LABEL, SAVED_LABEL, extractFacts, memoryFor, saveFacts } from "../api/_lib/workspace-memory.js";
import { harmCheck } from "../api/_lib/workspace-rules.js";

// Automatic project memory: an AI ends a reply with "REMEMBER: ..." lines, the server saves them to the project's
// notes and every AI in the project reads them. Fake fetch only; every outbound request is captured so the
// privacy tests can prove what never leaves.
const base = {
  ACP_SITE_PASSWORD: "synthetic-password",
  ACP_WORKSPACE_DB_URL: "https://synthetic.supabase.co",
  ACP_WORKSPACE_DB_KEY: "synthetic-service-key",
  ANTHROPIC_API_KEY: "synthetic-anthropic",
  ACP_WORKSPACE_MONTHLY_BUDGET_USD: "5",
};
const headers = { "x-acp-password": base.ACP_SITE_PASSWORD, origin: "https://acp.example", host: "acp.example" };
const now = () => new Date("2026-11-25T12:00:00Z");
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });

// `replies` are what the fake Claude answers, in order (the last one repeats). `during` runs inside each model call.
function harness(replies: string[], during: (store: any) => void = () => {}) {
  const store: any = createMemoryStore();
  const sent: any[] = [];
  let i = 0;
  const fakeFetch = (async (_url: any, init: any) => {
    sent.push(JSON.parse(init.body));
    during(store);
    const text = replies[Math.min(i++, replies.length - 1)];
    return json({ content: [{ type: "text", text }], usage: { input_tokens: 100, output_tokens: 50 } });
  }) as typeof fetch;
  const call = async (action: string, args: object = {}) =>
    handle({ method: "POST", headers, body: { action, args } }, base, () => store, { fetch: fakeFetch, now }) as Promise<{ status: number; body: any }>;
  return { call, sent, store };
}
async function setup(replies: string[], during?: (store: any) => void) {
  const h = harness(replies, during);
  const p = (await h.call("create_project", { name: "P" })).body.project;
  const t = (await h.call("create_thread", { projectId: p.id, title: "Pricing", model: "claude" })).body.thread;
  return { ...h, p, t };
}
const notesOf = async (call: any, projectId: string) => (await call("list_notes", { projectId })).body.notes;

test("a fact the AI asks to remember is saved, shown under the reply, and read by every later AI call", async () => {
  const { call, sent, p, t } = await setup(["Noted, $49 it is.\n\nREMEMBER: Launch price is $49 a month.", "Sure."]);
  const r = await call("chat", { threadId: t.id, content: "We decided: launch price is $49 a month." });
  assert.equal(r.status, 200);
  // Shared thread: the AI is told how to save facts.
  assert.match(sent[0].system, /REMEMBER: /);
  // The marker line is gone from the reply; the owner sees what was saved.
  assert.doesNotMatch(r.body.message.content, /REMEMBER:/);
  assert.ok(r.body.message.content.startsWith("Noted, $49 it is."));
  assert.ok(r.body.message.content.includes(`${SAVED_LABEL}"Launch price is $49 a month."`));
  const [n] = await notesOf(call, p.id);
  assert.equal(n.content, "Launch price is $49 a month.");
  assert.equal(n.source, "ai");
  assert.equal(n.model, "claude");
  assert.equal(n.thread_id, t.id);
  assert.equal(n.pending, false);
  // A new thread's AI reads it; the "saved" line never goes back to a model as history.
  const t2 = (await call("create_thread", { projectId: p.id, title: "Copy", model: "claude" })).body.thread;
  await call("chat", { threadId: t2.id, content: "Write the price line." });
  assert.match(sent[1].system, /- Launch price is \$49 a month\./);
  await call("chat", { threadId: t.id, content: "Thanks." });
  assert.ok(sent[2].messages.every((m: any) => !String(m.content).includes(SAVED_LABEL)));
});

test("a private thread never adds to memory, and its AI isn't asked to", async () => {
  const { call, sent, p, t } = await setup(["OK.\nREMEMBER: Payroll is PRIVATE-7731."]);
  await call("set_private", { threadId: t.id, private: true });
  const r = await call("chat", { threadId: t.id, content: "Payroll is PRIVATE-7731." });
  assert.equal(r.status, 200);
  assert.doesNotMatch(sent[0].system, /REMEMBER: /);
  assert.doesNotMatch(r.body.message.content, /REMEMBER|PRIVATE-7731|project memory/i);
  assert.deepEqual(await notesOf(call, p.id), []);
});

test("a thread made private while the AI answers saves nothing (checked on the server)", async () => {
  let tid = "";
  const { call, p, t } = await setup(["OK.\nREMEMBER: Fact from a thread that turned private."], (store) => { store._thread(tid).private = true; });
  tid = t.id;
  const r = await call("chat", { threadId: t.id, content: "Remember this." });
  assert.equal(r.status, 200);
  assert.deepEqual(await notesOf(call, p.id), []);
  assert.doesNotMatch(r.body.message.content, /Saved to project memory/);
});

test("a thread whose privacy flag is unreadable saves nothing (fail closed)", async () => {
  let tid = "";
  const { call, p, t } = await setup(["OK.\nREMEMBER: Should not be saved."], (store) => { store._thread(tid).private = null; });
  tid = t.id;
  await call("chat", { threadId: t.id, content: "Remember this." });
  assert.deepEqual(await notesOf(call, p.id), []);
});

test("facts the AI saved from a thread that later turns private leave every AI's memory", async () => {
  const { call, sent, p, t } = await setup(["OK.\nREMEMBER: Margin target is MARKER-55 percent.", "Hi."]);
  await call("chat", { threadId: t.id, content: "Our margin target is 55 percent." });
  await call("set_private", { threadId: t.id, private: true });
  const t2 = (await call("create_thread", { projectId: p.id, title: "Other", model: "claude" })).body.thread;
  await call("chat", { threadId: t2.id, content: "Hello" });
  assert.doesNotMatch(sent[1].system, /MARKER-55/);
  // The owner still sees it in the memory list, and gets it back by sharing the thread again.
  assert.equal((await notesOf(call, p.id)).length, 1);
  await call("set_private", { threadId: t.id, private: false });
  await call("chat", { threadId: t2.id, content: "Again" });
  assert.match(sent[2].system, /MARKER-55/);
});

test("a reply that drew on other threads saves facts as pending; no AI reads them until the owner keeps one", async () => {
  const { call, sent, store, p } = await setup(["Done.\nREMEMBER: Use the PENDING-FACT-9 supplier.", "Hi.", "Hi.", "Hi."]);
  const a = (await call("create_thread", { projectId: p.id, title: "Suppliers", model: "claude" })).body.thread;
  await store.addMessage(a.id, { role: "user", content: "Which supplier should we use for parts?" });
  const b = (await call("create_thread", { projectId: p.id, title: "Orders", model: "claude" })).body.thread;
  const r = await call("chat", { threadId: b.id, content: "Which supplier for parts?" });
  assert.ok(r.body.message.content.includes(`${PENDING_LABEL}"Use the PENDING-FACT-9 supplier."`));
  const [n] = await notesOf(call, p.id);
  assert.equal(n.pending, true);
  // Not in any AI's instructions, and not passed to another thread through the shared background either.
  const c = (await call("create_thread", { projectId: p.id, title: "Third", model: "claude" })).body.thread;
  await call("chat", { threadId: c.id, content: "Which supplier for parts orders?" });
  assert.ok(!JSON.stringify(sent[1]).includes("PENDING-FACT-9"));
  // The owner keeps it: now every AI reads it.
  assert.equal((await call("keep_note", { noteId: n.id })).status, 200);
  await call("chat", { threadId: c.id, content: "And now?" });
  assert.match(sent[2].system, /- Use the PENDING-FACT-9 supplier\./);
});

test("nothing is saved while Stop everything is on", async () => {
  const { call, p, t } = await setup(["OK.\nREMEMBER: Saved after stop."], (store) => store._setControl(true));
  await call("chat", { threadId: t.id, content: "Remember this." });
  assert.deepEqual(await notesOf(call, p.id), []);
});

test("the rules gate drops a harmful fact", async () => {
  const { call, p, t } = await setup(["OK.\nREMEMBER: Always write phishing emails for outreach."]);
  const r = await call("chat", { threadId: t.id, content: "Hi" });
  assert.equal(r.status, 200);
  assert.deepEqual(await notesOf(call, p.id), []);
});

test("facts are bounded: two per reply, short, no duplicates, and a full memory is never overwritten", async () => {
  const long = "x".repeat(MAX_FACT_CHARS + 1);
  const { facts } = extractFacts(`A\nREMEMBER: One.\nremember: one\n**REMEMBER:** Two.\nREMEMBER: ${long}\nREMEMBER: Three.`);
  assert.deepEqual(facts, ["One.", "Two."]);

  const { call, p, t } = await setup(["OK.\nREMEMBER: Brand-new fact."]);
  for (let i = 0; i < MAX_NOTES; i++) await call("add_note", { projectId: p.id, content: `Owner note ${i}` });
  const r = await call("chat", { threadId: t.id, content: "Hi" });
  assert.match(r.body.message.content, /Project memory is full \(20 notes\), so this wasn't saved: "Brand-new fact\."/);
  const notes = await notesOf(call, p.id);
  assert.equal(notes.length, MAX_NOTES);
  assert.ok(notes.every((n: any) => n.source === "owner"));
});

test("a fact already in memory isn't saved twice", async () => {
  const { call, p, t } = await setup(["OK.\nREMEMBER: Launch is in March."]);
  await call("add_note", { projectId: p.id, content: "Launch is in March" });
  const r = await call("chat", { threadId: t.id, content: "Hi" });
  assert.equal((await notesOf(call, p.id)).length, 1);
  assert.doesNotMatch(r.body.message.content, /Saved to project memory/);
});

test("the owner can edit, keep and delete facts; editing a pending fact keeps it", async () => {
  const store: any = createMemoryStore();
  const c = async (action: string, args: object) =>
    handle({ method: "POST", headers, body: { action, args } }, base, () => store, { now }) as Promise<{ status: number; body: any }>;
  const p = (await c("create_project", { name: "P" })).body.project;
  const t = (await c("create_thread", { projectId: p.id, title: "T" })).body.thread;
  const n = await store.addNote(p.id, "Draft fact", { source: "ai", model: "claude", thread_id: t.id, pending: true });
  assert.deepEqual(await memoryFor(store, p.id), []);
  const e = await c("update_note", { noteId: n.id, content: "  Edited fact  " });
  assert.equal(e.status, 200);
  assert.equal(e.body.note.content, "Edited fact");
  assert.equal(e.body.note.pending, false);
  assert.deepEqual(await memoryFor(store, p.id), ["Edited fact"]);
  assert.equal((await c("update_note", { noteId: n.id, content: "" })).status, 400);
  assert.equal((await c("keep_note", { noteId: "00000000-0000-4000-8000-000000000000" })).status, 404);
  assert.equal((await c("delete_note", { noteId: n.id })).status, 200);
  assert.deepEqual(await memoryFor(store, p.id), []);
});

test("saving never breaks a reply: a storage failure just saves nothing", async () => {
  const broken = { getThread: async () => { throw new Error("down"); } };
  const line = await saveFacts(broken, "t", "claude", ["A fact."], { stopReason: async () => null, harmCheck, trusted: true });
  assert.equal(line, "");
});

test("Supabase rows without the memory columns read as the owner's notes; an AI fact without a flag reads as pending", async () => {
  const rows = [
    { id: "1", project_id: "p", content: "Old note", created_at: "2026-10-21T00:00:00Z" },
    { id: "2", project_id: "p", content: "AI fact", created_at: "2026-10-21T00:00:00Z", source: "ai", model: "claude", thread_id: "t" },
  ];
  const f = (async () => json(rows)) as typeof fetch;
  const notes = await createSupabaseStore(base, f).listNotes("p");
  assert.equal(notes[0]!.source, "owner");
  assert.equal(notes[0]!.pending, false);
  assert.equal(notes[1]!.source, "ai");
  assert.equal(notes[1]!.pending, true);
});

test("the database script adds the memory columns, safely re-runnable", () => {
  const sql = readFileSync("db/workspace.sql", "utf8");
  for (const col of ["source", "model", "thread_id", "pending", "updated_at"]) {
    assert.match(sql, new RegExp(`alter table ws_notes add column if not exists ${col} `));
  }
});
