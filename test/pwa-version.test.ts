import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import handler, { versionOf } from "../api/version.js";

const call = (method: string) => {
  const h: Record<string, string> = {};
  let status = 0, body: any;
  const res: any = { setHeader: (k: string, v: string) => { h[k] = v; }, status(s: number) { status = s; return res; }, json(b: unknown) { body = b; return res; } };
  (handler as any)({ method }, res);
  return { h, status, body };
};

test("version is a short commit id or dev, never cached, no other data", () => {
  assert.equal(versionOf({ VERCEL_GIT_COMMIT_SHA: "510a907700ab8ab25f99027e0ca55f33621b31bf" }), "510a907700ab");
  assert.equal(versionOf({}), "dev");
  assert.equal(versionOf({ VERCEL_GIT_COMMIT_SHA: "<script>" }), "dev");
  const r = call("GET");
  assert.equal(r.status, 200);
  assert.equal(r.h["Cache-Control"], "no-store");
  assert.deepEqual(Object.keys(r.body), ["version"]);
  assert.equal(call("POST").status, 405);
});

test("update notice: old page sees new deployment once; no loop; quiet offline", () => {
  const ctx: any = {};
  vm.runInNewContext(readFileSync("dashboard/version.js", "utf8"), ctx);
  const { shouldNotice } = ctx.ACPVersion;
  assert.equal(shouldNotice("aaa", "bbb", null), true);
  assert.equal(shouldNotice("bbb", "bbb", null), false);
  assert.equal(shouldNotice("aaa", "bbb", "bbb"), false);
  assert.equal(shouldNotice(null, "bbb", null), false);
  assert.equal(shouldNotice("aaa", null, null), false);
});

test("version script never reloads by itself, caches no API data, stores no secrets", () => {
  const src = readFileSync("dashboard/version.js", "utf8");
  const reloads = src.match(/location\.reload\(\)/g) ?? [];
  assert.equal(reloads.length, 1, "the only reload is inside refresh(), which a click calls");
  assert.match(src, /cache: "no-store", credentials: "omit"/);
  assert.doesNotMatch(src, /localStorage|caches\.|indexedDB|\.clear\(\)|password/);
});
