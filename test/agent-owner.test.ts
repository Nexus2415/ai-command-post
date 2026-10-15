import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { AGENTS, agentFor } from "../src/agents.ts";
// @ts-ignore plain-JS module served by Vercel
import { MATCH, agentFor as jsAgentFor } from "../api/lib/agent-owner.js";

test("api/lib/agent-owner.js matches src/agents.ts exactly", () => {
  assert.deepEqual(Object.keys(MATCH), Object.keys(AGENTS));
  for (const [k, a] of Object.entries(AGENTS)) assert.equal(String((MATCH as Record<string, RegExp>)[k]), String(a.match), k);
  const items = [
    { title: "[Claude] x" }, { title: "[ChatGPT] x" }, { title: "[Question] x", labels: ["gemini"] },
    { title: "[Perplexity] x", assignee: "Claude" }, { title: "no prefix", assignee: "OpenAI bot" },
    { title: "[Codex] x" }, { title: "plain" }, { title: "[Sonar] x" },
  ];
  for (const i of items) assert.equal(jsAgentFor(i), agentFor(i), i.title);
});

test("Vercel functions never import TypeScript at runtime", () => {
  for (const dir of ["api", "api/lib"]) {
    for (const f of readdirSync(dir).filter(n => n.endsWith(".js"))) {
      assert.doesNotMatch(readFileSync(`${dir}/${f}`, "utf8"), /from\s+["'][^"']+\.ts["']/, `${dir}/${f}`);
    }
  }
});
