// Rules gate for the workspace (website side). Every message the owner sends, every tool call an AI makes and
// every reply an AI writes passes through here before it is sent on, run or saved.
//
// Why in code: the workspace reaches models from several makers through OpenRouter, each with its own training
// and its own idea of what to refuse. None of them is trusted to police itself. These rules run AROUND the model,
// so the same lines hold whichever model answers, and a model cannot talk its way past them.
//
// HARM_RULES is the website's copy of HARM_RULES in src/policy.ts (the engine's red-tier policy); the website
// functions don't load the engine's TypeScript. test/rules-gate.test.ts keeps the two identical.

const W = "[^.?!\\n]"; // stays inside one sentence
export const HARM_RULES = Object.freeze([
  { id: "violence", reason: "Hurting or killing people",
    re: new RegExp(`\\b(?:how (?:do i|to|can i|would i)|help me|ways? to|plan to|i (?:want|need|am going) to|going to)\\b${W}{0,40}\\b(?:kill|murder|hurt|injure|poison|stab|kidnap|torture|assault|strangle)\\b${W}{0,30}\\b(?:someone|somebody|a person|people|him|her|them|my (?:wife|husband|boss|neighbou?r|partner|ex|coworker|co-worker|family)|an? (?:child|kid|man|woman|person))\\b`, "i") },
  { id: "mass_harm", reason: "Weapons or attacks meant to harm many people",
    re: new RegExp(`\\b(?:make|build|assemble|synthesi[sz]e|manufacture|produce|3d[- ]print)\\b${W}{0,30}\\b(?:bombs?|explosives?|ieds?|nerve agents?|sarin|ricin|anthrax|bioweapons?|chemical weapons?|ghost guns?|untraceable (?:guns?|firearms?))\\b|\\b(?:plan|carry out|commit|organi[sz]e)\\b${W}{0,30}\\b(?:mass shooting|school shooting|terror(?:ist)? attack|massacre|bombing)\\b`, "i") },
  { id: "intrusion", reason: "Breaking into systems or accounts that aren't ours, or writing malware",
    re: new RegExp(`\\b(?:hack|break) into\\b${W}{0,40}\\b(?:someone|somebody|his|her|their|my (?:ex|wife|husband|boss|partner)|an? (?:account|email|phone|computer))\\b|\\b(?:write|create|build|deploy|make)\\b${W}{0,20}\\b(?:ransomware|malware|keyloggers?|credential stealers?|botnets?)\\b`, "i") },
  { id: "fraud", reason: "Fraud, forgery or deceiving people",
    re: new RegExp(`\\b(?:write|create|make|draft|build|send)\\b${W}{0,20}\\bphishing\\b|\\b(?:how (?:do i|to|can i)|help me)\\b${W}{0,30}\\b(?:launder (?:money|cash)|commit fraud|forge (?:a |an )?(?:signature|document|check|cheque|id|passport|invoice)|evade (?:taxes|tax)|steal (?:someone'?s |an? )?identit(?:y|ies))\\b|\\b(?:write|create|make|post|generate|fabricate)\\b${W}{0,20}\\bfake (?:reviews?|testimonials?|invoices?)\\b`, "i") },
  { id: "stalking", reason: "Stalking, threatening or blackmailing people",
    re: new RegExp(`\\b(?:secretly|covertly)\\s+(?:track|follow|monitor|record|watch)\\b|\\b(?:stalk|doxx?)\\b${W}{0,20}\\b(?:someone|somebody|him|her|them|my|an? )|\\b(?:write|send|draft)\\b${W}{0,30}\\b(?:death threats?|threatening (?:messages?|letters?|emails?))\\b|\\b(?:blackmail|extort)\\b${W}{0,20}\\b(?:someone|somebody|him|her|them|my|an? |a client|a customer)`, "i") },
  { id: "discrimination", reason: "Unlawful discrimination against people",
    re: new RegExp(`\\b(?:reject|exclude|refuse|screen out|not hire|avoid hiring|fire|deny)\\b${W}{0,40}\\b(?:because (?:of )?(?:their|they'?re|they are|he'?s|she'?s|he is|she is)|based on)\\b${W}{0,20}\\b(?:race|religion|gender|sex|pregnan\\w*|disabilit\\w*|age|national origin|ethnicity|skin colou?r)\\b`, "i") },
  { id: "drugs", reason: "Making illegal drugs",
    re: new RegExp(`\\b(?:make|cook|synthesi[sz]e|produce)\\b${W}{0,20}\\b(?:meth(?:amphetamine)?|fentanyl|heroin|crack cocaine)\\b`, "i") },
  { id: "child_safety", reason: "Sexual content involving minors",
    re: new RegExp(`\\b(?:child|children|minors?|underage|kids?|teen(?:ager)?s?)\\s+(?:porn\\w*|nudes?|sexual (?:images?|photos?|pictures?|videos?|content|stories))\\b|\\b(?:sexual|nude|naked|porn\\w*|explicit)\\s+(?:images?|photos?|pictures?|videos?|content|stories)\\s+(?:of|with|involving)\\s+(?:an? )?(?:child|children|minors?|underage|kids?|teen(?:ager)?s?)\\b`, "i") },
]);

/** The first harm rule the text breaks, or null. */
export function harmCheck(text) {
  return HARM_RULES.find((r) => r.re.test(String(text))) ?? null;
}

/** Every string inside a value, joined, so nested tool arguments are checked too. */
export function textOf(v, out = []) {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => textOf(x, out));
  else if (v && typeof v === "object") Object.values(v).forEach((x) => textOf(x, out));
  return out;
}

// Refusals are saved in the thread as messages starting with this marker, so the owner sees what was refused and
// why. They are never sent back to a model as history.
export const REFUSAL_MARK = "[Rules gate: refused]";
export const STOP_MARK = "[Stopped by the owner]";

export function refusalText(where, rule) {
  const what = where === "request" ? "Your message was not sent to any AI."
    : where === "reply" ? "The AI's reply was withheld and not shown."
    : `A tool call (${where}) was blocked and not run.`;
  return `${REFUSAL_MARK}\n${what}\nReason: ${rule.reason}.\nThe workspace's own rules refused it; no AI decided this.`;
}

// One line in the server log for each refusal: where and which rule, never the text itself.
export function logRefusal(where, rule) {
  console.warn(JSON.stringify({ event: "rules_gate_refusal", where, rule: rule.id }));
}
