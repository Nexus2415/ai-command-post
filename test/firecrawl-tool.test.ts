// ARN-45 finding: Firecrawl calls spend account credits, so dry-run mode must never reach the API.
// Synthetic only: a fake fetch records requests; nothing reaches Firecrawl.
import assert from "node:assert/strict";
import { test } from "node:test";
import { runTool, type ToolEnv } from "../src/tools.ts";

function rig(dryRun: boolean) {
  const calls: string[] = [];
  const f = (async (url: string) => {
    calls.push(new URL(url).pathname);
    const json = url.endsWith("/v2/search")
      ? { success: true, data: { web: [{ title: "T", url: "https://example.com", description: "d" }] } }
      : { success: true, data: { markdown: "# page" } };
    return new Response(JSON.stringify(json), { status: 200 });
  }) as unknown as typeof fetch;
  const env: ToolEnv = { firecrawlKey: "fc-test", dryRun, f, policy: { allowPullRequests: false, allowedRepos: [] }, comment: async () => {}, requestApproval: async () => {} };
  const run = (tool: string, input: Record<string, unknown>) => runTool({ tool, input }, [tool], env);
  return { calls, run };
}

test("a dry run never calls Firecrawl search or scrape", async () => {
  const { calls, run } = rig(true);
  const s = await run("firecrawl.search", { query: "acme pricing" });
  const p = await run("firecrawl.scrape", { url: "https://example.com/a" });
  assert.match(s.output, /DRY RUN: would search the web for "acme pricing"/);
  assert.match(p.output, /DRY RUN: would fetch https:\/\/example\.com\/a/);
  assert.deepEqual(calls, []);
});

test("a dry run still refuses a non-https scrape before anything else", async () => {
  const { calls, run } = rig(true);
  const r = await run("firecrawl.scrape", { url: "http://example.com" });
  assert.match(r.output, /Only https URLs may be scraped/);
  assert.deepEqual(calls, []);
});

test("outside a dry run the tools call Firecrawl as before", async () => {
  const { calls, run } = rig(false);
  const s = await run("firecrawl.search", { query: "q" });
  const p = await run("firecrawl.scrape", { url: "https://example.com" });
  assert.match(s.output, /https:\/\/example\.com/);
  assert.equal(p.output, "# page");
  assert.deepEqual(calls, ["/v2/search", "/v2/scrape"]);
});
