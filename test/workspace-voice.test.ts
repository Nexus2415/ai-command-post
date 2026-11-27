import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

// Mobile and voice: static checks only (the browser's speech features can't run in node). Talking fills the question
// box and never sends by itself; nothing is stored in the browser.
const read = (p: string) => readFileSync(new URL(`../dashboard/${p}`, import.meta.url), "utf8");

test("the microphone fills the question box and never sends on its own", () => {
  const js = read("workspace.js");
  const html = read("workspace.html");
  assert.match(html, /id="cMic"[^>]*type="button"|type="button" id="cMic"/);
  assert.match(js, /window\.SpeechRecognition \|\| window\.webkitSpeechRecognition/);
  const voice = js.slice(js.indexOf("const Recognition"));
  assert.doesNotMatch(voice.slice(0, voice.indexOf("function speakButton")), /requestSubmit|post\(/);
  assert.match(js, /new SpeechSynthesisUtterance/);
  assert.doesNotMatch(js, /localStorage|sessionStorage|indexedDB|innerHTML|getUserMedia|MediaRecorder/);
});

test("the workspace can be added to a phone's home screen", () => {
  const html = read("workspace.html");
  const m = JSON.parse(read("manifest.webmanifest"));
  assert.match(html, /<link rel="manifest" href="manifest\.webmanifest">/);
  assert.match(html, /apple-touch-icon" href="icon-180\.png"/);
  assert.equal(m.start_url, "/home.html");
  assert.equal(m.display, "standalone");
  for (const i of m.icons) assert.ok(existsSync(new URL(`../dashboard/${i.src}`, import.meta.url)), i.src);
  assert.match(read("workspace-chat.css"), /@media \(pointer:coarse\)\{input,select,textarea\{font-size:16px\}\}/);
});
