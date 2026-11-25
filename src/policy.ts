/**
 * Authority tiers. The engine enforces these in code; a model's instructions cannot change them.
 *
 * GREEN  — reversible, internal: read code, search the web, comment on a task.
 * YELLOW — visible but reviewable: open a pull request, create a sub-task. Allowed only when enabled in config.
 * RED    — irreversible, spends money, or reaches outside: merge, delete, deploy, purchase, send email,
 *          change credentials or release flags. Never executed; the engine asks the owner instead.
 */
export type Tier = "green" | "yellow" | "red";

export const TOOL_TIERS: Record<string, Tier> = {
  "github.read_file": "green",
  "github.list_tree": "green",
  "github.search_issues": "green",
  "firecrawl.search": "green",
  "firecrawl.scrape": "green",
  "linear.comment": "green",
  "vercel.list_deployments": "green",
  "vercel.deployment_status": "green",
  "linear.create_subtask": "yellow",
  "github.open_pull_request": "yellow",
};

/** Words that mark a requested action as owner-only no matter which tool is asked for. */
export const RED_PATTERNS: readonly RegExp[] = [
  /\bmerge\b/i,
  /\bforce[- ]?push\b/i,
  /\bdelete\b|\bdrop table\b|\btruncate\b/i,
  /\bdeploy\b|\bpublish to production\b/i,
  /\bpurchase\b|\bbuy\b|\bupgrade (?:the )?plan\b|\bsubscribe\b/i,
  /\bsend (?:an? )?email\b|\bemail (?:the )?(?:client|customer)\b/i,
  /\b(?:rotate|revoke|change) (?:the )?(?:secret|credential|api key|token)\b/i,
  /\blimited_live_ready\b|\brelease gate\b/i,
];

/**
 * Harm rules: requests and replies that hurt people, are violent, clearly illegal or clearly unethical. Refused in
 * code, every time, whatever a model says. Models reached through OpenRouter come from different makers with
 * different training, so none of them is trusted to police itself: these checks run around the model, on the
 * owner's request, on every tool call and on every reply, and a match is refused and logged, never sent on.
 *
 * Each rule names a clear intent (an action aimed at a person, or a recognised crime). They are a keyword net for
 * obvious cases, not a judge of subtle ones; phrases like "kill the process" or "anti-money laundering rules" pass.
 * api/_lib/workspace-rules.js holds the website's copy; test/rules-gate.test.ts keeps the two identical.
 */
export interface HarmRule { id: string; reason: string; re: RegExp }
const W = "[^.?!\\n]"; // stays inside one sentence
export const HARM_RULES: readonly HarmRule[] = Object.freeze([
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
export function harmCheck(text: string): HarmRule | null {
  return HARM_RULES.find((r) => r.re.test(text)) ?? null;
}

/** Every string inside a value (tool inputs are nested objects), joined. */
export function textOf(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => textOf(x, out));
  else if (v && typeof v === "object") Object.values(v).forEach((x) => textOf(x, out));
  return out;
}

export interface PolicyContext {
  allowPullRequests: boolean;
  allowedRepos: string[];
}

export type Decision = { allow: true; tier: Tier } | { allow: false; tier: Tier; reason: string };

export function decide(tool: string, input: Record<string, unknown>, ctx: PolicyContext): Decision {
  const tier = TOOL_TIERS[tool];
  if (!tier) return { allow: false, tier: "red", reason: `Unknown tool "${tool}" is blocked` };

  const text = JSON.stringify(input);
  // Only free-text intent fields are scanned; a file path containing "delete" is fine.
  const intent = [input["title"], input["body"], input["message"], input["intent"]].filter((v) => typeof v === "string").join(" ");
  // Harm rules apply to every string in the input, not only the intent fields.
  const harm = harmCheck(textOf(input).join("\n"));
  if (harm) return { allow: false, tier: "red", reason: `Refused by the rules gate: ${harm.reason}` };
  const red = RED_PATTERNS.find((re) => re.test(intent));
  if (red) return { allow: false, tier: "red", reason: `Owner approval required: request matches "${red.source}"` };

  if (tool.startsWith("github.")) {
    const repo = input["repo"];
    if (typeof repo !== "string" || !ctx.allowedRepos.includes(repo)) {
      return { allow: false, tier, reason: `Repo ${String(repo)} is not in ACP_GITHUB_REPOS` };
    }
  }
  if (tool === "github.open_pull_request" && !ctx.allowPullRequests) {
    return { allow: false, tier, reason: "Opening pull requests is disabled (ACP_ALLOW_PULL_REQUESTS=false)" };
  }
  if (text.length > 200_000) return { allow: false, tier, reason: "Tool input too large" };
  return { allow: true, tier };
}
