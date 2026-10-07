// Offline stand-in for @types/node, used only by tsconfig.offline.json when npm is unreachable.
declare const process: { env: Record<string, string | undefined>; argv: string[]; exit(code?: number): never; on(ev: string, fn: () => void): void };
declare const Buffer: { from(data: string, enc?: string): { toString(enc?: string): string } };
declare module "node:fs" { export function readFileSync(p: string, enc: string): string; export function writeFileSync(p: string, d: string): void; export function mkdirSync(p: string, o?: { recursive?: boolean }): void; }
declare module "node:path" { export function dirname(p: string): string; }
declare module "node:test" { export function test(name: string, fn: () => unknown): void; }
declare module "node:assert/strict" { const assert: { (v: unknown, m?: string): asserts v; equal(a: unknown, b: unknown, m?: string): void; notEqual(a: unknown, b: unknown, m?: string): void; deepEqual(a: unknown, b: unknown, m?: string): void; match(s: string, re: RegExp, m?: string): void; ok(v: unknown, m?: string): asserts v; rejects(fn: () => Promise<unknown>, e?: unknown): Promise<void> }; export default assert; }
