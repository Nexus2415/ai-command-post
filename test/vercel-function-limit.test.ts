import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// Vercel Hobby allows at most 12 serverless functions per deployment. Every
// .js/.ts file under api/ becomes a function unless it (or a folder on its
// path) starts with "_" or ".", so shared helpers live in api/_lib.
function functions(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (name.startsWith("_") || name.startsWith(".")) return [];
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return functions(path);
    return /\.(js|mjs|cjs|ts)$/.test(name) ? [path] : [];
  });
}

test("api/ stays within Vercel Hobby's 12-function limit", () => {
  const found = functions("api");
  assert.ok(found.length <= 12, `${found.length} functions: ${found.join(", ")}`);
});
