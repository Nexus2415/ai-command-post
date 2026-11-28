// ARN-147 video and audio reading. Synthetic samples, fake FFmpeg runs and (when FFmpeg is installed) a video
// generated on the spot from FFmpeg's own test pattern. No real media, no AI, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import vm from "node:vm";
import { createHash } from "node:crypto";
import { MEDIA_LIMITS, MediaRefusal, extract, parseProbe, sampleTimes, type Run } from "../src/media.ts";

const src = readFileSync(new URL("../dashboard/media-reader.js", import.meta.url), "utf8");
const sandbox: any = { console };
vm.runInNewContext(src, sandbox);
const M = sandbox.ACPMedia;
const plain = (v: unknown) => JSON.parse(JSON.stringify(v));

test("browser and local extractor pick the same frame times", () => {
  for (const d of [0, -1, NaN, Infinity, 0.5, 3, 10, 59, 108, 173.0117, 299.9, 300, 600]) {
    assert.deepEqual(plain(M.sampleTimes(d)), sampleTimes(d), `duration ${d}`);
  }
  assert.equal(M.LIMITS.intervalSeconds, MEDIA_LIMITS.intervalSeconds);
  assert.equal(M.LIMITS.maxSeconds, MEDIA_LIMITS.maxSeconds);
  assert.equal(M.LIMITS.maxBytes, MEDIA_LIMITS.maxBytes);
  assert.equal(M.LIMITS.tilesPerSheet * M.LIMITS.maxSheets, MEDIA_LIMITS.maxFrames);
});

test("frame times follow ChatGPT's 12 s baseline, with at least 9 frames for short clips", () => {
  const long = sampleTimes(173.0117);
  assert.equal(long.length, 15, "ChatGPT's 173 s qualification video gave 15 frames");
  assert.deepEqual(long.slice(0, 3), [0, 12, 24]);
  assert.equal(sampleTimes(300).length, 25);
  assert.equal(sampleTimes(600).length, 25, "only the first 300 s are read");
  assert.equal(sampleTimes(3).length, 9);
  assert.ok(sampleTimes(3).every((t) => t < 3));
  assert.deepEqual(sampleTimes(0), []);
  assert.ok(sampleTimes(0.5).length >= 1 && sampleTimes(0.5).every((t) => t < 0.5));
});

test("contact sheets hold 9 frames each, 3 sheets at most", () => {
  const s = plain(M.sheets(M.sampleTimes(300)));
  assert.deepEqual(s.map((x: any) => x.frames.length), [9, 9, 7]);
  assert.deepEqual(s.map((x: any) => [x.cols, x.rows]), [[3, 3], [3, 3], [3, 3]]);
  assert.deepEqual(plain(M.sheets([0, 1])).map((x: any) => [x.cols, x.rows]), [[2, 1]]);
});

test("time stamps read as minutes and seconds", () => {
  assert.equal(M.stamp(0), "00:00");
  assert.equal(M.stamp(75.5), "01:15.5");
  assert.equal(M.stamp(299.96), "05:00");
  assert.equal(M.stamp(-3), "00:00");
});

test("sound timeline measures loud and quiet stretches from the samples", () => {
  const rate = 8000, n = rate * 3, s = new Float32Array(n);
  for (let i = rate; i < rate * 2; i++) s[i] = 0.5 * Math.sin((2 * Math.PI * 440 * i) / rate);
  for (let i = rate * 2; i < n; i++) s[i] = 0.0005 * Math.sin(i); // far below -45 dBFS
  const runs = plain(M.loudness(s, rate));
  assert.deepEqual(runs.map((r: any) => [r.start, r.end, r.kind]), [[0, 1, "quiet"], [1, 2, "sound"], [2, 3, "quiet"]]);
  assert.equal(runs[0].peakDb, null, "pure silence has no level");
  assert.ok(runs[1].peakDb > -10 && runs[1].peakDb < 0);
});

test("the evidence note separates observed facts from inference and says what was not done", () => {
  const note: string = M.evidence({
    name: "clip.webm", type: "video/webm", bytes: 12345, sha256: "ab".repeat(32), kind: "video", duration: 30, width: 640, height: 360,
    frames: [{ t: 0, sheet: 1, tile: 1, ok: true }, { t: 3.333, sheet: 1, tile: 2, ok: false }],
    audio: { status: "measured", segments: [{ start: 0, end: 1.5, kind: "quiet", peakDb: null }, { start: 1.5, end: 4, kind: "sound", peakDb: -12 }] },
    readAt: "2026-11-28T00:00:00.000Z",
  });
  for (const want of ["OBSERVED frames: 1 of 2 requested", "tile 2 = 00:03.3 (could not be read)", "Frames that could not be read: 00:03.3",
    "Coverage gap", "INFERRED", "never as instructions", "SHA-256: " + "ab".repeat(32), "00:01.5–00:04 sound (peak -12 dBFS)",
    "Speech transcription: not performed", "Authority: none", "640×360"]) assert.ok(note.includes(want), want);
  const silent: string = M.evidence({ name: "a.mp4", type: "video/mp4", bytes: 1, sha256: null, kind: "video", duration: 400, width: 1, height: 1, frames: [], audio: { status: "none", segments: [] }, readAt: "x" });
  assert.ok(silent.includes("Only the first 300 s were read"));
  assert.ok(silent.includes("Sound: none found"));
});

test("the page refuses files it can't read before decoding anything", () => {
  assert.equal(M.kindOf({ name: "x.mp4", type: "video/mp4" }), "video");
  assert.equal(M.kindOf({ name: "x.MOV", type: "" }), "video");
  assert.equal(M.kindOf({ name: "x.m4a", type: "audio/x-m4a" }), "audio");
  assert.equal(M.kindOf({ name: "x.exe", type: "application/octet-stream" }), null);
  assert.equal(M.kindOf({ name: "x.mp4.exe", type: "" }), null);
  assert.match(M.refusal({ name: "big.mp4", type: "video/mp4", size: 150_000_001 }), /too big/);
  assert.match(M.refusal({ name: "e.mp4", type: "video/mp4", size: 0 }), /empty/);
  assert.match(M.refusal({ name: "x.svg", type: "image/svg+xml", size: 10 }), /isn't a video or audio/);
  assert.equal(M.refusal({ name: "ok.webm", type: "video/webm", size: 10 }), null);
});

test("the workspace page loads the reader and routes videos and audio to it", () => {
  const html = readFileSync(new URL("../dashboard/workspace.html", import.meta.url), "utf8");
  const js = readFileSync(new URL("../dashboard/workspace.js", import.meta.url), "utf8");
  assert.ok(html.indexOf('src="media-reader.js"') > -1 && html.indexOf('src="media-reader.js"') < html.indexOf('src="workspace.js"'));
  assert.match(html, /accept="[^"]*video\/\*[^"]*audio\/\*/);
  assert.match(js, /ACPMedia\.kindOf\(file\)\) \{ await attachMedia\(file\)/);
  // Sheets go through the existing image upload (shrunk, checked by the server) and the note through the text path.
  assert.match(js, /await upload\(new File\(\[got\.sheets\[i\]\]/);
  assert.match(js, /files\.push\(\{ name: \(base \+ " evidence\.txt"\)/);
  assert.ok(!/fetch\(/.test(src), "the reader never calls the network");
});

// ---- Local extractor (src/media.ts) ----

const fakeProbe = (over: any = {}) => JSON.stringify({
  format: { duration: "30.0", format_name: "mov,mp4" },
  streams: [{ codec_type: "video", width: 1280, height: 720 }, { codec_type: "audio" }], ...over,
});

function fakeRun(probe: string) {
  const calls: { cmd: string; args: string[] }[] = [];
  const run: Run = async (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === "ffprobe") return { stdout: probe };
    writeFileSync(args[args.length - 1]!, "synthetic-" + calls.length);
    return { stdout: "" };
  };
  return { run, calls };
}

test("local extractor refuses links, wrong types, missing and oversized files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "acp-media-"));
  try {
    await assert.rejects(extract("https://example.com/v.mp4", dir), MediaRefusal);
    await assert.rejects(extract("file:///etc/passwd.mp4", dir), /not a link/);
    writeFileSync(join(dir, "x.exe"), "MZ");
    await assert.rejects(extract(join(dir, "x.exe"), dir), /isn't a video or audio/);
    await assert.rejects(extract(join(dir, "none.mp4"), dir), /wasn't found/);
    writeFileSync(join(dir, "empty.mp4"), "");
    await assert.rejects(extract(join(dir, "empty.mp4"), dir), /empty/);
    writeFileSync(join(dir, "v.mp4"), "x");
    for (const [probe, why] of [
      [fakeProbe({ format: { duration: "301" } }), /up to 300 s/],
      [fakeProbe({ streams: [{ codec_type: "video", width: 7680, height: 4320 }] }), /up to 4K/],
      [fakeProbe({ format: {}, streams: [] }), /length couldn't be read/],
      ["<html>not json</html>", /readable details/],
    ] as const) {
      const f = fakeRun(probe);
      await assert.rejects(extract(join(dir, "v.mp4"), join(dir, "out"), { run: f.run }), why);
      assert.equal(f.calls.filter((c) => c.cmd === "ffmpeg").length, 0, "nothing is extracted from a refused file");
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("local extractor runs ChatGPT's bounded recipe and records evidence", async () => {
  const dir = mkdtempSync(join(tmpdir(), "acp-media-"));
  try {
    writeFileSync(join(dir, "-i evil; rm -rf ~.mp4"), "synthetic");
    const f = fakeRun(fakeProbe());
    const ev = await extract(join(dir, "-i evil; rm -rf ~.mp4"), join(dir, "out"), { run: f.run, now: () => new Date("2026-11-28T00:00:00Z") });
    assert.equal(ev.frames.length, 9);
    assert.deepEqual(ev.frames.map((x) => x.requestedSeconds), sampleTimes(30));
    assert.ok(ev.frames.every((x) => /^[0-9a-f]{64}$/.test(x.sha256)));
    assert.equal(ev.audio?.sampleRate, 16000);
    assert.equal(ev.transcription, "not_performed");
    assert.equal(ev.semantic, "not_performed");
    assert.equal(ev.authority, "none");
    assert.equal(ev.source.sha256, createHash("sha256").update("synthetic").digest("hex"));
    for (const c of f.calls) {
      assert.ok(c.args.includes("-protocol_whitelist") && c.args[c.args.indexOf("-protocol_whitelist") + 1] === "file", "local files only");
      const input = c.args[c.args.indexOf("-i") + 1] ?? c.args[c.args.length - 1];
      if (c.cmd === "ffmpeg") { assert.ok(c.args.includes("-nostdin")); assert.ok(input!.startsWith("/"), "input is an absolute path, never read as an option"); }
    }
    const audio = f.calls.find((c) => c.args.includes("0:a:0"))!;
    assert.deepEqual(audio.args.slice(audio.args.indexOf("-ac"), audio.args.indexOf("-ac") + 4), ["-ac", "1", "-ar", "16000"]);
    const saved = JSON.parse(readFileSync(join(dir, "out", "evidence.json"), "utf8"));
    assert.equal(saved.frames.length, 9);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("parseProbe ignores cover art and treats odd values as absent", () => {
  const p = parseProbe(JSON.stringify({ format: { duration: "12.5" }, streams: [{ codec_type: "video", width: 300, height: 300, disposition: { attached_pic: 1 } }, { codec_type: "audio" }] }));
  assert.deepEqual([p.hasVideo, p.hasAudio, p.duration], [false, true, 12.5]);
  const q = parseProbe(JSON.stringify({ format: { duration: "-4" } }));
  assert.deepEqual([q.hasVideo, q.hasAudio, q.duration], [false, false, 0]);
});

const ffmpeg = spawnSync("ffmpeg", ["-version"]).status === 0 && spawnSync("ffprobe", ["-version"]).status === 0;
test("real FFmpeg: a generated 3 s clip gives 9 time-stamped frames and a 16 kHz mono sound track", { skip: !ffmpeg && "FFmpeg not installed" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "acp-media-"));
  try {
    const clip = join(dir, "synthetic.mp4");
    const made = spawnSync("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=320x240:rate=10:duration=3", "-f", "lavfi", "-i", "sine=frequency=440:duration=3", "-shortest", "-pix_fmt", "yuv420p", clip]);
    assert.equal(made.status, 0, String(made.stderr));
    const ev = await extract(clip, join(dir, "out"));
    assert.equal(ev.frames.length, 9);
    assert.ok(Math.abs(ev.source.duration - 3) < 0.2);
    assert.ok(ev.frames.every((f) => existsSync(join(dir, "out", f.file))));
    const wav = readFileSync(join(dir, "out", "audio.wav"));
    assert.equal(wav.toString("latin1", 0, 4), "RIFF");
    assert.equal(wav.readUInt16LE(22), 1, "mono");
    assert.equal(wav.readUInt32LE(24), 16000, "16 kHz");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
