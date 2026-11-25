import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { handle } from "../api/workspace.js";
import { createMemoryStore } from "../api/_lib/workspace-store.js";
import { CATALOG } from "../api/_lib/workspace-catalog.js";
import { checkHttpTool } from "../api/_lib/workspace-connectors.js";

// Plugin catalog: ready-made look-up tools. Memory store and fake network only.
const base = {
  ACP_SITE_PASSWORD: "synthetic-password",
  ACP_WORKSPACE_DB_URL: "https://synthetic.supabase.co",
  ACP_WORKSPACE_DB_KEY: "synthetic-service-key",
};
const headers = { "x-acp-password": base.ACP_SITE_PASSWORD, origin: "https://acp.example", host: "acp.example" };
function harness() {
  const store = createMemoryStore();
  const net = (async () => { throw new Error("no network in tests"); }) as unknown as typeof fetch;
  const call = (action: string, args: object = {}) =>
    handle({ method: "POST", headers, body: { action, args } }, base, () => store, { fetch: net, net, now: () => new Date("2026-11-25T12:00:00Z") });
  return { call };
}

test("every catalog entry passes the same checks as a tool the owner builds: read-only, public https, no key", () => {
  const ids = new Set(), names = new Set();
  for (const c of CATALOG) {
    const { spec, problems } = checkHttpTool({ ...c.spec, projectId: null }, base);
    assert.deepEqual(problems, [], c.id);
    assert.equal(spec!.method, "GET");
    assert.equal(spec!.tokenVar, null);
    assert.ok(c.spec.url.startsWith("https://"));
    assert.ok(!ids.has(c.id) && !names.has(c.spec.name));
    ids.add(c.id); names.add(c.spec.name);
  }
  assert.ok(CATALOG.length >= 5);
});

test("adding from the catalog uses the server's copy, needs the review code, and shows as added", async () => {
  const { call } = harness();
  const listed = (await call("catalog")).body as any;
  assert.equal(listed.entries.find((e: any) => e.id === "weather").added, false);
  // The page can't change what the entry does: only the project scope is taken from it.
  const preview = await call("connector_preview", { catalogId: "weather", spec: { projectId: null, url: "https://evil.example.org/x" } });
  assert.equal(preview.status, 200);
  assert.equal((preview.body as any).spec.url, CATALOG.find((c) => c.id === "weather")!.spec.url);
  assert.equal((await call("connector_save", { catalogId: "weather", spec: { projectId: null }, confirm: "0".repeat(32) })).status, 409);
  assert.equal((await call("connector_save", { catalogId: "weather", spec: { projectId: null }, confirm: (preview.body as any).confirm })).status, 200);
  assert.equal(((await call("catalog")).body as any).entries.find((e: any) => e.id === "weather").added, true);
  // Adding it twice is refused by the usual name check.
  assert.equal((await call("connector_preview", { catalogId: "weather", spec: {} })).status, 422);
  assert.equal((await call("connector_preview", { catalogId: "nope" })).status, 400);
});

test("the Tools page shows the catalog, rendered without HTML parsing", () => {
  const html = readFileSync(new URL("../dashboard/tools.html", import.meta.url), "utf8");
  const js = readFileSync(new URL("../dashboard/tools.js", import.meta.url), "utf8");
  assert.match(html, /id="catList"/);
  assert.match(js, /post\("catalog"\)/);
  assert.match(js, /catalogId/);
  assert.doesNotMatch(js, /innerHTML|outerHTML|insertAdjacentHTML/);
});
