import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

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
  assert.match(js, /new (?:window\.)?SpeechSynthesisUtterance/);
  assert.doesNotMatch(js, /localStorage|sessionStorage|indexedDB|innerHTML|getUserMedia|MediaRecorder/);
});

test("the workspace can be added to a phone's home screen", () => {
  const html = read("workspace.html");
  const m = JSON.parse(read("manifest.webmanifest"));
  assert.match(html, /<link rel="manifest" href="manifest\.webmanifest">/);
  assert.match(html, /apple-touch-icon" href="icon-180\.png"/);
  assert.equal(m.start_url, "/workspace.html");
  assert.equal(m.display, "standalone");
  for (const i of m.icons) assert.ok(existsSync(new URL(`../dashboard/${i.src}`, import.meta.url)), i.src);
  assert.match(read("workspace-chat.css"), /@media \(pointer:coarse\)\{input,select,textarea\{font-size:16px\}\}/);
});


test("read aloud starts one chunk per callback and surfaces errors or silent start", () => {
  const js = read("workspace.js");
  const start = js.indexOf("  let speaking = null;");
  const end = js.indexOf("  syncMic();\n\n  guard", start);
  assert.ok(start >= 0 && end > start);
  const utterances: any[] = [], notes: string[] = [], timers = new Map<number, () => void>();
  let timer = 0, cancels = 0;
  const synth = { speaking:false, pending:false, paused:false, getVoices:()=>[{lang:"en-US",localService:true}],
    cancel:()=>{cancels++;}, resume:()=>{}, speak:(u:any)=>{utterances.push(u);} };
  class Utterance { text: string; constructor(text:string){this.text=text;} }
  const context = {
    window:{speechSynthesis:synth,SpeechSynthesisUtterance:Utterance,addEventListener:()=>{}},
    navigator:{language:"en-US"}, say:(s:string)=>notes.push(s),
    setTimeout:(fn:()=>void)=>{timers.set(++timer,fn);return timer;},
    clearTimeout:(id:number)=>timers.delete(id),
    el:()=>({textContent:"▶ Listen",setAttribute:()=>{},addEventListener(_e:string,fn:()=>void){Object.assign(this,{click:fn});}})
  };
  const button = runInNewContext(js.slice(start,end) + '\nspeakButton({childNodes:[{nodeType:3,textContent:"First. Second."}]});', context);
  button.click();
  assert.equal(cancels,0,"do not cancel an idle engine before first playback");
  assert.equal(utterances.length,1);
  assert.equal(utterances[0].voice.lang,"en-US");
  utterances[0].onstart(); utterances[0].onend();
  assert.equal(utterances.length,2);
  utterances[1].onerror();
  assert.equal(button.textContent,"▶ Listen");
  assert.match(notes.at(-1)!,/Audio could not start/);
  button.click();
  const silent = [...timers.values()].at(-1)!; silent();
  assert.equal(button.textContent,"▶ Listen");
  assert.match(notes.at(-1)!,/Audio could not start/);
  button.click();
  const late = utterances.at(-1); button.click(); late.onend();
  assert.equal(button.textContent,"▶ Listen","late callbacks cannot restart stopped playback");
});
