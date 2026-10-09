// ARN-77: actual Chromium DOM, synthetic fetch only; no server/provider credentials.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { spawnSync, spawn } from 'node:child_process';

const browser = process.env['ACP_TEST_CHROMIUM'] || '/usr/bin/chromium';
const available = spawnSync(browser, ['--version']).status === 0;
test('ARN-77 real console DOM: outage, stale refresh, thread recovery and malformed intake', { skip: !available }, async () => {
  const html = readFileSync(new URL('../dashboard/index.html', import.meta.url), 'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '').replace(/<link\b[^>]*>/g, '');
  const source = readFileSync(new URL('../dashboard/console.js', import.meta.url), 'utf8');
  const dir = mkdtempSync(join(tmpdir(), 'arn77-browser-'));
  const harness = async function (consoleSource: string) {
    const $ = (id: string) => document.getElementById(id) as any;
    const check = (ok: any, message: string) => { if (!ok) throw new Error(message); };
    const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 0)); };
    const fixture = { issues: [{ id: 'ARN-77', title: 'Synthetic command', lane: 'active' }], agents: [], fetchedAt: '2026-10-09T00:00:00Z' };
    let outage = true, threadFail = true, intake: any = {}, authenticate = true;
    const keys: string[] = [], writes: string[] = [];
    const originalSet = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) { writes.push(key + ':' + value); return originalSet.call(this, key, value); };
    localStorage.setItem('acp.pw', 'old-password'); writes.length = 0;
    (window as any).prompt = () => 'synthetic-password';
    (window as any).setInterval = () => 0;
    (window as any).fetch = async (path: string, init: any) => {
      const body = JSON.parse(init.body);
      if (authenticate) { authenticate = false; return new Response('{"error":"unauthorized"}', { status: 401 }); }
      if (path === '/api/intake') {
        keys.push(body.idempotencyKey);
        return new Response(typeof intake === 'string' ? intake : JSON.stringify(intake), { status: 200 });
      }
      if (body.action === 'thread') return threadFail ? new Response('{"error":"thread unavailable"}', { status: 502 }) : new Response(JSON.stringify({ issue: { id: 'ARN-77', title: 'Recovered thread' }, comments: [] }));
      return outage ? new Response('{"error":"synthetic outage"}', { status: 502 }) : new Response(JSON.stringify(fixture));
    };
    (0, eval)(consoleSource);
    (window as any).ACPConsole.start(); await flush();
    check($('cUpdated').textContent === 'Not loaded', 'initial outage must be not loaded');
    check($('cOverviewMsg').textContent.includes('synthetic outage'), 'initial outage message');
    check(!$('cList').textContent.includes('No active taskings'), 'outage must not imply empty workload');
    outage = false; $('cRefresh').click(); await flush();
    check($('cList').textContent.includes('Synthetic command'), 'successful overview renders task');
    outage = true; $('cRefresh').click(); await flush();
    check($('cUpdated').textContent.includes('(stale)'), 'failed refresh labels stale');
    check($('cList').textContent.includes('Synthetic command'), 'stale refresh preserves prior tasks');
    check($('cOverviewMsg').textContent.includes('last data received'), 'stale warning visible');
    $('cList').querySelector('button').click(); await flush();
    check($('cDetailBody').textContent.includes('thread unavailable'), 'thread failure visible');
    check(!$('cDetailBody').textContent.includes('Comments (0)'), 'failed thread must not imply empty thread');
    threadFail = false; $('cList').querySelector('button').click(); await flush();
    check($('cDetailTitle').textContent.includes('Recovered thread'), 'thread recovery');
    outage = false; $('cRefresh').click(); await flush();
    check(!$('cUpdated').textContent.includes('stale') && $('cOverviewMsg').hidden, 'overview recovery clears stale warning');
    for (const intent of ['command', 'question']) {
      document.querySelector<HTMLButtonElement>('[data-intent="' + intent + '"]')!.click();
      $('cText').value = 'synthetic ' + intent;
      const start = keys.length;
      for (const invalid of ['', '<html>proxy</html>', '{', {}, null, [], { identifier: 'invalid' }, { identifier: 77 }, { id: 'ARN-77' }]) {
        intake = invalid; $('cSend').click(); await flush();
        check($('cSendMsg').className === 'msg err', 'malformed intake must display error: ' + JSON.stringify(invalid));
        check(!/received|Issue created|completed/i.test($('cSendMsg').textContent.replace('Nothing was confirmed as received.', '')), 'no false receipt/completion');
        check($('cText').value === 'synthetic ' + intent, 'failed receipt keeps draft');
        check(keys.at(-1) === keys[start], 'retry keeps draft key');
      }
      intake = { identifier: 'ARN-77', duplicate: true }; $('cSend').click(); await flush();
      check(keys.at(-1) === keys[start], 'successful retry retains key');
      check($('cSendMsg').textContent.includes('received as ARN-77'), 'valid receipt');
      check($('cText').value === '', 'valid receipt clears draft');
      check(!/completed/i.test($('cSendMsg').textContent), 'receipt is not completion');
    }
    check(!localStorage.getItem('acp.pw') && writes.length === 0, 'password never persisted to either storage');
  };
  const server = createServer((_req, res) => { res.setHeader('content-type', 'text/html'); res.end(html); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as import('node:net').AddressInfo;
  try {
    const child = spawn(browser, ['--headless', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--disable-background-networking', '--remote-debugging-port=0', '--user-data-dir=' + join(dir, 'profile'), 'about:blank'], { env: { ...process.env, XDG_CONFIG_HOME: dir, XDG_CACHE_HOME: dir }, stdio: 'ignore', detached: true });
    let socket: WebSocket | undefined;
    try {
      const portFile = join(dir, 'profile', 'DevToolsActivePort');
      for (let i = 0; i < 100 && !existsSync(portFile); i++) await new Promise(r => setTimeout(r, 50));
      assert.ok(existsSync(portFile), 'Chromium debugging endpoint did not start');
      const port = readFileSync(portFile, 'utf8').split('\n')[0];
      const pages = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json() as any[];
      socket = new WebSocket(pages.find(p => p.type === 'page').webSocketDebuggerUrl);
      await new Promise<void>((resolve, reject) => { socket!.onopen = () => resolve(); socket!.onerror = reject; });
      let seq = 0;
      const rpc = (method: string, params: any = {}) => new Promise<any>((resolve, reject) => {
        const id = ++seq;
        const timer = setTimeout(() => { socket!.removeEventListener('message', handler); reject(new Error('CDP timeout: ' + method)); }, 10000);
        const handler = (ev: MessageEvent) => { const m = JSON.parse(String(ev.data)); if (m.id === id) { clearTimeout(timer); socket!.removeEventListener('message', handler); m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result); } };
        socket!.addEventListener('message', handler); socket!.send(JSON.stringify({ id, method, params }));
      });
      await rpc('Page.enable');
      const loaded = new Promise<void>(resolve => { const handler = (ev: MessageEvent) => { if (JSON.parse(String(ev.data)).method === 'Page.loadEventFired') { socket!.removeEventListener('message', handler); resolve(); } }; socket!.addEventListener('message', handler); });
      await rpc('Page.navigate', { url: 'http://127.0.0.1:' + address.port });
      await Promise.race([loaded, new Promise((_, reject) => setTimeout(() => reject(new Error('page load timeout')), 10000).unref())]);
      const result = await rpc('Runtime.evaluate', { expression: '(' + harness.toString() + ')(' + JSON.stringify(source) + ').then(()=>"PASS").catch(e=>e.message)', awaitPromise: true, returnByValue: true });
      assert.equal(result.result.value, 'PASS', JSON.stringify(result));
    } finally { socket?.close(); if (child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} } }
  } finally { server.close(); rmSync(dir, { recursive: true, force: true }); }
});
