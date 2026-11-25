// Images and PDFs in a thread (2026-11-25). The owner uploads a file to a thread (stored in ws_files, never in
// browser storage), then sends it with a message. The message only carries a short marker naming the file; the
// file itself goes to the AI, in each provider's own format, while it is among the thread's newest MAX_IN_CONTEXT
// files. Text files still travel inside the message as before (api/workspace.js userMessage).
//
// Cost: an image is about IMAGE_TOKENS input tokens and a PDF about PDF_TOKENS_PER_PAGE per page, every time it is
// sent. Those figures go into every estimate, so the spend caps see them before any call is made.

export const FILE_KINDS = Object.freeze({
  "image/png": { kind: "image", magic: (b) => b.length > 8 && b[0] === 0x89 && b.toString("latin1", 1, 4) === "PNG" },
  "image/jpeg": { kind: "image", magic: (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  "image/gif": { kind: "image", magic: (b) => b.length > 6 && /^GIF8[79]a$/.test(b.toString("latin1", 0, 6)) },
  "image/webp": { kind: "image", magic: (b) => b.length > 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP" },
  "application/pdf": { kind: "pdf", magic: (b) => b.length > 5 && b.toString("latin1", 0, 5) === "%PDF-" },
});
// The page shrinks photos before uploading, so 1.5 MB is plenty for an image; PDFs may be up to 3 MB (Vercel takes
// request bodies up to 4.5 MB, and base64 adds a third).
export const MAX_IMAGE_BYTES = 1_500_000;
export const MAX_PDF_BYTES = 3_000_000;
export const MAX_PDF_PAGES = 30;
// The largest upload request, as JSON text: base64 of the biggest file plus room for the name and fields.
export const MAX_UPLOAD_BODY = Math.ceil(MAX_PDF_BYTES / 3) * 4 + 4_096;
export const MAX_FILES_PER_MESSAGE = 3;
export const MAX_FILES_PER_THREAD = 30;
// How many of the thread's newest files go to the AI with each reply (older ones stay named in the conversation).
export const MAX_IN_CONTEXT = 3;
// Token figures for estimates: high on purpose, so the caps are never under-counted.
export const IMAGE_TOKENS = 1_600;
export const PDF_TOKENS_PER_PAGE = 2_000;

export class FileProblem extends Error {}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
export const cleanName = (v) => {
  const name = typeof v === "string" ? v.trim() : "";
  return name && name.length <= 120 && !/[\u0000-\u001f<>#]/.test(name) ? name : null;
};

// Page count from the PDF's own page objects. A PDF that hides them in compressed object streams is counted by
// size instead (one page per 30 KB, at least one), which errs high.
export function pdfPages(buf) {
  const s = buf.toString("latin1");
  const n = (s.match(/\/Type\s*\/Page(?![a-zA-Z])/g) || []).length;
  return n || Math.max(1, Math.ceil(buf.length / 30_000));
}

/** Checks an upload. Returns { name, mime, kind, bytes, pages, data } or throws FileProblem. */
export function checkUpload(args) {
  const name = cleanName(args?.name);
  if (!name) throw new FileProblem("The file needs a plain name of up to 120 characters.");
  const type = FILE_KINDS[args.mime];
  if (!type) throw new FileProblem("Only images (PNG, JPEG, GIF, WebP) and PDFs can be uploaded. Text files go in the message.");
  const data = typeof args.data === "string" ? args.data : "";
  if (!data || data.length % 4 !== 0 || !BASE64.test(data)) throw new FileProblem(`${name} didn't arrive in one piece. Try again.`);
  const buf = Buffer.from(data, "base64");
  const max = type.kind === "pdf" ? MAX_PDF_BYTES : MAX_IMAGE_BYTES;
  if (!buf.length || buf.length > max) throw new FileProblem(`${name} is too big: up to ${max / 1_000_000} MB for ${type.kind === "pdf" ? "a PDF" : "an image"}.`);
  if (!type.magic(buf)) throw new FileProblem(`${name} isn't really a ${args.mime === "application/pdf" ? "PDF" : "picture of that type"}.`);
  const pages = type.kind === "pdf" ? pdfPages(buf) : 0;
  if (pages > MAX_PDF_PAGES) throw new FileProblem(`${name} has about ${pages} pages; up to ${MAX_PDF_PAGES} work. Split it, or attach the pages you need.`);
  return { name, mime: args.mime, kind: type.kind, bytes: buf.length, pages, data };
}

// The marker a message carries for each file. It names the file for the owner and every AI, and its id lets the
// server find the file again. The page shows it as a chip.
export const marker = (f) => `<<<attached ${FILE_KINDS[f.mime]?.kind === "pdf" ? `PDF, ${f.pages} page${f.pages === 1 ? "" : "s"}` : "image"}: ${f.name} #${f.id}>>>`;
export const MARKER = /<<<attached (?:image|PDF, \d+ pages?): [^\n<>#]{1,120} #([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})>>>/gi;
export const fileIdsIn = (text) => [...String(text).matchAll(MARKER)].map((m) => m[1].toLowerCase());

/** Markers for the files picked for one message, after checking each belongs to the thread. */
export async function markersFor(store, threadId, ids) {
  if (ids === undefined) return "";
  if (!Array.isArray(ids) || ids.length > MAX_FILES_PER_MESSAGE || new Set(ids).size !== ids.length) {
    throw new FileProblem(`Attach at most ${MAX_FILES_PER_MESSAGE} images or PDFs.`);
  }
  if (!ids.length) return "";
  if (!ids.every((id) => typeof id === "string" && /^[0-9a-f-]{36}$/i.test(id))) throw new FileProblem("Unknown file.");
  const rows = await store.fileInfo(threadId, ids);
  if (rows.length !== ids.length) throw new FileProblem("A file isn't in this thread any more. Upload it again.");
  return ids.map((id) => marker(rows.find((r) => r.id === id))).join("\n");
}

/**
 * The thread's newest files (up to MAX_IN_CONTEXT) attached to the turns that name them, for a model that can read
 * them. Turns are copied, never changed. A model that can't read files gets a short note instead.
 */
export async function withFiles(store, threadId, turns, canRead = true) {
  const wanted = [];
  for (let i = turns.length - 1; i >= 0 && wanted.length < MAX_IN_CONTEXT; i--) {
    if (turns[i].role !== "user") continue;
    for (const id of fileIdsIn(turns[i].content).reverse()) if (!wanted.includes(id) && wanted.length < MAX_IN_CONTEXT) wanted.push(id);
  }
  if (!wanted.length) return turns;
  if (!canRead) {
    return turns.map((t, i) => (i === turns.length - 1 && t.role === "user" && fileIdsIn(t.content).length
      ? { ...t, content: `${t.content}\n\n(You can't open attached files; say so if the question needs them.)` } : t));
  }
  let rows;
  try { rows = await store.getFiles(threadId, wanted); } catch { rows = []; }
  return turns.map((t) => {
    if (t.role !== "user") return t;
    const files = fileIdsIn(t.content).map((id) => rows.find((r) => r.id === id)).filter(Boolean)
      .map((r) => ({ name: r.name, mime: r.mime, data: r.data, pages: r.pages ?? 0 }));
    return files.length ? { ...t, files } : t;
  });
}

// Input tokens a turn's files add, for estimates.
export const fileTokens = (files = []) =>
  files.reduce((n, f) => n + (FILE_KINDS[f.mime]?.kind === "pdf" ? Math.max(1, f.pages || 1) * PDF_TOKENS_PER_PAGE : IMAGE_TOKENS), 0);

// One turn with files, in a provider's own message format. Anthropic: image and document blocks. OpenAI-style
// (ChatGPT, OpenRouter): image_url parts and file parts.
export function toAnthropic(turn) {
  return {
    role: turn.role,
    content: [
      ...turn.files.map((f) => ({
        type: FILE_KINDS[f.mime]?.kind === "pdf" ? "document" : "image",
        source: { type: "base64", media_type: f.mime, data: f.data },
      })),
      { type: "text", text: turn.content },
    ],
  };
}
export function toOpenAi(turn) {
  return {
    role: turn.role,
    content: [
      { type: "text", text: turn.content },
      ...turn.files.map((f) => (FILE_KINDS[f.mime]?.kind === "pdf"
        ? { type: "file", file: { filename: f.name, file_data: `data:application/pdf;base64,${f.data}` } }
        : { type: "image_url", image_url: { url: `data:${f.mime};base64,${f.data}` } })),
    ],
  };
}
export const hasPdf = (convo) => convo.some((m) => Array.isArray(m.files) && m.files.some((f) => f.mime === "application/pdf"));
// A conversation as text only, for size estimates: file contents are left out (fileTokens counts them).
export const withoutFileData = (convo) => JSON.stringify(convo, (k, v) => (k === "files" ? undefined : v));
