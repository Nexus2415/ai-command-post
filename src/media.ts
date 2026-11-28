// Local video and audio extraction (ARN-147), for a computer that has FFmpeg: the owner's own machine or a GitHub
// Actions runner. It is ChatGPT's tested recipe from ARN-147 turned into code, not a new framework:
//   ffprobe -protocol_whitelist file -show_format -show_streams -of json
//   ffmpeg -nostdin -protocol_whitelist file -ss <s> -i <file> -map 0:v:0 -frames:v 1 -vf scale=640:640:force_original_aspect_ratio=decrease
//   ffmpeg ... -map 0:a:0 -ac 1 -ar 16000   (16 kHz mono WAV, the format speech-to-text models take)
// Bounds: a local file only (no URLs), up to 150 MB, 300 s and 4K. Frames every 12 s, or closer so a short clip
// still gets 9 (same rule as dashboard/media-reader.js; a test keeps them identical).
//
// Hardening (ChatGPT review of #145): the input must be a regular file, not a symlink; only plain container formats
// are opened (no playlists or concat lists that could pull in other local files); output goes to a NEW or EMPTY
// folder, nothing is ever overwritten (-n), every output must be newly written and non-empty before it is hashed;
// and the whole job has one deadline. This is the owner's standalone tool: an automated worker must give it a fresh
// private folder of its own and must not hand it untrusted paths.
//
// It writes frames, the sound track and evidence.json, which records SHA-256 of the source and of every output, the
// REQUESTED frame times (not the decoded frame's exact time), coverage gaps, and that transcription and any reading
// of meaning were not performed. It calls no AI, sends nothing anywhere and approves nothing.
//
// Usage: node src/media.ts <video-or-audio-file> <output-folder>

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const MEDIA_LIMITS = Object.freeze({ maxBytes: 150_000_000, maxSeconds: 300, maxSide: 3840, intervalSeconds: 12, minFrames: 9, maxFrames: 27, jobSeconds: 300 });
// Container formats FFmpeg may open. Playlist and list formats (hls, concat, image2 patterns, ...) are left out on purpose.
export const FORMATS = "mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,mp3,wav,ogg,flac,aac";
const EXTENSIONS = new Set([".mp4", ".m4v", ".mov", ".webm", ".mkv", ".mp3", ".wav", ".m4a", ".aac", ".ogg", ".opus", ".flac"]);

export class MediaRefusal extends Error {}

/** Requested frame times: every 12 s from 0, or closer so a short clip gets 9 frames; at most 27, within 300 s. */
export function sampleTimes(duration: number): number[] {
  if (!(duration > 0) || !Number.isFinite(duration)) return [];
  const d = Math.min(duration, MEDIA_LIMITS.maxSeconds);
  const step = Math.min(MEDIA_LIMITS.intervalSeconds, Math.max(0.25, d / MEDIA_LIMITS.minFrames));
  const out: number[] = [];
  for (let i = 0; ; i++) {
    const t = Math.round(i * step * 1000) / 1000;
    if (t >= d || out.length >= MEDIA_LIMITS.maxFrames) break;
    out.push(t);
  }
  return out;
}

export type Run = (cmd: string, args: string[]) => Promise<{ stdout: string }>;
const run: Run = (cmd, args) => new Promise((ok, no) => {
  // No shell: arguments go to the program as they are, so a file name can't become a command.
  execFile(cmd, args, { timeout: 120_000, maxBuffer: 8_000_000, windowsHide: true }, (err, stdout, stderr) =>
    err ? no(new Error(`${cmd} failed: ${String(stderr || err.message).trim().split("\n").slice(-3).join(" ")}`)) : ok({ stdout: String(stdout) }));
});

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

export interface Probe { duration: number; width: number; height: number; hasVideo: boolean; hasAudio: boolean; format: string }

/** Reads ffprobe's JSON. Anything missing or odd counts as absent rather than guessed. */
export function parseProbe(json: string): Probe {
  let data: any;
  try { data = JSON.parse(json); } catch { throw new MediaRefusal("ffprobe didn't return readable details for this file."); }
  const streams: any[] = Array.isArray(data?.streams) ? data.streams : [];
  const v = streams.find((s) => s?.codec_type === "video" && s?.disposition?.attached_pic !== 1);
  const a = streams.find((s) => s?.codec_type === "audio");
  const duration = Number(data?.format?.duration ?? v?.duration ?? a?.duration);
  return {
    duration: Number.isFinite(duration) && duration > 0 ? duration : 0,
    width: Number(v?.width) || 0, height: Number(v?.height) || 0,
    hasVideo: Boolean(v), hasAudio: Boolean(a), format: String(data?.format?.format_name ?? "unknown"),
  };
}

export interface Evidence {
  source: { name: string; bytes: number; sha256: string; format: string; duration: number; width: number; height: number };
  frames: { index: number; requestedSeconds: number; file: string; sha256: string }[];
  audio: null | { file: string; sha256: string; sampleRate: 16000; channels: 1 };
  coverage: string[];
  transcription: "not_performed";
  semantic: "not_performed";
  authority: "none";
  extractedAt: string;
}

/** Checks a path before FFmpeg sees it. Returns its size. */
export async function check(path: string): Promise<number> {
  if (/^[a-z][a-z0-9+.-]*:/i.test(path) && !/^[a-z]:[\\/]/i.test(path)) throw new MediaRefusal("Only a file on this computer can be read, not a link.");
  if (!EXTENSIONS.has(extname(path).toLowerCase())) throw new MediaRefusal(`${basename(path)} isn't a video or audio file type this reads (${[...EXTENSIONS].join(", ")}).`);
  let s;
  try { s = await lstat(path); } catch { throw new MediaRefusal(`${basename(path)} wasn't found.`); }
  if (s.isSymbolicLink()) throw new MediaRefusal(`${basename(path)} is a shortcut (symlink); give the real file.`);
  if (!s.isFile()) throw new MediaRefusal(`${basename(path)} isn't a file.`);
  if (!s.size) throw new MediaRefusal(`${basename(path)} is empty.`);
  if (s.size > MEDIA_LIMITS.maxBytes) throw new MediaRefusal(`${basename(path)} is over ${MEDIA_LIMITS.maxBytes / 1e6} MB.`);
  return s.size;
}

/** Creates the output folder, or accepts an existing one only if it is a real, empty folder. */
export async function freshFolder(dir: string): Promise<void> {
  let s;
  try { s = await lstat(dir); } catch { await mkdir(dir, { recursive: true }); return; }
  if (s.isSymbolicLink() || !s.isDirectory()) throw new MediaRefusal("The output folder must be a real folder, not a file or shortcut.");
  if ((await readdir(dir)).length) throw new MediaRefusal("The output folder must be new or empty; nothing is overwritten.");
}

/** Hash of a file this run just wrote: it must be a regular, non-empty file. */
async function fresh(path: string): Promise<string> {
  const s = await lstat(path);
  if (!s.isFile() || s.isSymbolicLink() || !s.size) throw new Error("no output");
  return sha(await readFile(path));
}

export async function extract(input: string, outDir: string, opts: { run?: Run; now?: () => Date; clock?: () => number } = {}): Promise<Evidence> {
  const clock = opts.clock ?? Date.now, until = clock() + MEDIA_LIMITS.jobSeconds * 1000;
  const base = opts.run ?? run;
  const exec: Run = (cmd, args) => {
    if (clock() > until) return Promise.reject(new MediaRefusal(`The job ran past its ${MEDIA_LIMITS.jobSeconds} s limit and was stopped.`));
    return base(cmd, args);
  };
  if (/^[a-z][a-z0-9+.-]*:/i.test(input) && !/^[a-z]:[\\/]/i.test(input)) throw new MediaRefusal("Only a file on this computer can be read, not a link.");
  const path = resolve(input);
  const bytes = await check(path);
  const probe = parseProbe((await exec("ffprobe", ["-v", "error", "-protocol_whitelist", "file", "-format_whitelist", FORMATS, "-show_format", "-show_streams", "-of", "json", path])).stdout);
  if (!probe.duration) throw new MediaRefusal("The file's length couldn't be read.");
  if (probe.duration > MEDIA_LIMITS.maxSeconds) throw new MediaRefusal(`The file is ${Math.round(probe.duration)} s long; up to ${MEDIA_LIMITS.maxSeconds} s works.`);
  if (Math.max(probe.width, probe.height) > MEDIA_LIMITS.maxSide) throw new MediaRefusal(`The picture is ${probe.width}×${probe.height}; up to 4K works.`);
  if (!probe.hasVideo && !probe.hasAudio) throw new MediaRefusal("The file has no picture or sound.");
  await freshFolder(outDir);
  const ev: Evidence = {
    source: { name: basename(path), bytes, sha256: sha(await readFile(path)), format: probe.format, duration: probe.duration, width: probe.width, height: probe.height },
    frames: [], audio: null, coverage: [], transcription: "not_performed", semantic: "not_performed", authority: "none",
    extractedAt: (opts.now ?? (() => new Date()))().toISOString(),
  };
  if (probe.hasVideo) {
    const times = sampleTimes(probe.duration);
    for (const [i, t] of times.entries()) {
      const file = `frame-${String(i + 1).padStart(3, "0")}.jpg`;
      try {
        await exec("ffmpeg", ["-nostdin", "-v", "error", "-n", "-protocol_whitelist", "file", "-format_whitelist", FORMATS, "-ss", String(t), "-i", path, "-map", "0:v:0", "-frames:v", "1", "-vf", "scale=640:640:force_original_aspect_ratio=decrease", join(outDir, file)]);
        ev.frames.push({ index: i + 1, requestedSeconds: t, file, sha256: await fresh(join(outDir, file)) });
      } catch (e) {
        if (e instanceof MediaRefusal) throw e;
        ev.coverage.push(`Frame at ${t} s could not be extracted.`);
      }
    }
    const step = times.length > 1 ? (times[1] ?? 0) - (times[0] ?? 0) : probe.duration;
    ev.coverage.push(`Frames are snapshots at the requested times; up to ${step} s between frames was not seen.`);
  } else ev.coverage.push("No picture: sound only.");
  if (probe.hasAudio) {
    await exec("ffmpeg", ["-nostdin", "-v", "error", "-n", "-protocol_whitelist", "file", "-format_whitelist", FORMATS, "-i", path, "-map", "0:a:0", "-ac", "1", "-ar", "16000", join(outDir, "audio.wav")]);
    try {
      ev.audio = { file: "audio.wav", sha256: await fresh(join(outDir, "audio.wav")), sampleRate: 16000, channels: 1 };
    } catch { ev.coverage.push("The sound track could not be extracted."); }
  } else ev.coverage.push("No sound track.");
  ev.coverage.push("Speech was not transcribed and nothing was interpreted.");
  await writeFile(join(outDir, "evidence.json"), JSON.stringify(ev, null, 2) + "\n");
  return ev;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [input, out] = process.argv.slice(2);
  if (!input || !out) { console.error("Usage: node src/media.ts <video-or-audio-file> <output-folder>"); process.exit(2); }
  extract(input, out).then((ev) => {
    console.log(`${ev.frames.length} frames, ${ev.audio ? "sound track saved" : "no sound"}; evidence in ${join(out, "evidence.json")}`);
  }, (e) => { console.error(e instanceof MediaRefusal ? `Refused: ${e.message}` : e.message); process.exit(1); });
}
