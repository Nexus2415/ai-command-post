import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (file: string) => readFileSync(new URL("../dashboard/" + file, import.meta.url), "utf8");
const pages = [
  { file: "index.html", href: "/", ids: ["stopSwitch", "cIntent", "cText", "cSend", "cEngine", "cList"] },
  { file: "workspace.html", href: "/workspace.html", ids: ["pList", "tList", "nList", "cForm", "cText", "aPanel", "aList", "cPrivacy", "stopSwitch", "menuBtn"] },
  { file: "command.html", href: "/command.html", ids: ["tree", "links", "gRows", "refresh", "fresh"] },
  { file: "tools.html", href: "/tools.html", ids: ["stopSwitch", "connList", "mForm", "mUrl"] },
] as const;
test("shared NEXIA navigation links to the four existing surfaces and marks only the current page", () => {
  for (const page of pages) {
    const html = read(page.file);
    const nav = html.match(/<nav class="nexia-nav"[\s\S]*?<\/nav>/)?.[0];
    assert.ok(nav, page.file);
    for (const dest of pages) assert.ok(nav.includes('href="' + dest.href + '"'), dest.href);
    assert.equal((nav.match(/aria-current="page"/g) || []).length, 1);
    assert.ok(nav.includes('href="' + page.href + '" aria-current="page"'));
    assert.ok(html.indexOf('href="/nexia-shell.css"') > html.lastIndexOf("</style>"));
    assert.match(nav, /Advanced emergency controls are not ready yet/);
    assert.doesNotMatch(nav, /<button/);
  }
});
test("NEXIA retains all existing UI control IDs and no fabricated emergency controls", () => {
  for (const page of pages) {
    const html = read(page.file);
    for (const id of page.ids) assert.equal(html.split('id="' + id + '"').length - 1, 1, page.file + " " + id);
  }
  assert.match(read("index.html"), /Use the existing Stop Everything control/);
  const css = read("nexia-shell.css");
  assert.match(css, /@media\(max-width:420px\)/);
  assert.match(css, /@media\(prefers-reduced-motion:reduce\)/);
  assert.match(css, /\.stopbtn/);
});

test("plain-language descriptions accompany the branded feature names", () => {
  for (const page of pages) {
    const html = read(page.file);
    for (const label of ["Assign work", "Talk to AI", "Track work", "Connect apps"]) assert.ok(html.includes("<small>" + label + "</small>"), label);
  }
  const home = read("index.html");
  assert.match(home, /Assign a task/);
  assert.match(home, /Send a question/);
  const consoleScript = read("console.js");
  assert.match(consoleScript, /does not start AI work or allow changes/);
  assert.match(consoleScript, /cannot confirm that it is on/);
  assert.match(home, /Work already sent to another service may continue/);
});
