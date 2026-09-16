#!/usr/bin/env node
/** ui-shots.mjs — screenshot the served Syntheniq UI with headless Chrome (CDP).
 *  Shots: passcode screen, project page (clips + meta + variants).
 *  Usage: node tools/ui-shots.mjs <projectId>
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const PORT = 9333;
const BASE = 'http://127.0.0.1:8787';
const projectId = process.argv[2];

const CHROME = fs
  .readdirSync('/home/user/.cache/hyperframes/chrome/chrome-headless-shell', { withFileTypes: true })
  .map((d) => path.join('/home/user/.cache/hyperframes/chrome/chrome-headless-shell', d.name))
  .map((p) => path.join(p, 'chrome-headless-shell-linux64', 'chrome-headless-shell'))
  .filter((p) => fs.existsSync(p))[0];
if (!CHROME) throw new Error('chrome-headless-shell not found');

const libs = '/home/user/tools/chrome-libs/libs';
process.env.LD_LIBRARY_PATH = [libs, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');

const chrome = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`,
  '--headless',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-gpu',
  '--window-size=390,844',
  'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function httpJson(url, opts) {
  const r = await fetch(url, opts);
  return { status: r.status, json: () => r.json(), text: () => r.text() };
}

// wait for devtools
let ver;
for (let i = 0; i < 40; i++) {
  await sleep(250);
  try {
    ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
    break;
  } catch { /* not up */ }
}
if (!ver) { chrome.kill('SIGKILL'); throw new Error('chrome devtools never came up'); }

// new tab
let tab;
for (const method of ['PUT', 'GET']) {
  const r = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method });
  if (r.ok) { tab = await r.json(); break; }
}
if (!tab) throw new Error('could not create tab');

// CDP over WebSocket (Node 22 built-in)
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let msgId = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const send = (method, params = {}) => new Promise((res) => {
  const id = ++msgId;
  pending.set(id, res);
  ws.send(JSON.stringify({ id, method, params }));
});
const events = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  else if (m.method) events.push(m.method);
};

async function shot(file) {
  const { result } = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(file, Buffer.from(result.data, 'base64'));
  console.log('saved', file);
}
async function navigate(url) {
  events.length = 0;
  await send('Page.navigate', { url });
  for (let i = 0; i < 60 && !events.includes('Page.loadEventFired'); i++) await sleep(250);
}

await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await send('Page.enable');
await send('Network.enable');

// 1. passcode screen (no cookie)
await navigate(BASE + '/');
await sleep(2500);
await shot('/tmp/ui-passcode.png');

// 2. auth → token
const authRes = await fetch(BASE + '/v1/auth', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ password: 'syntheniq-2026' }),
});
const setCookie = authRes.headers.get('set-cookie') || '';
const token = (setCookie.match(/syntheniq_token=([^;]+)/) || [])[1];
if (!token) throw new Error('no auth token: ' + (await authRes.text()));

// 3. project page (with cookie)
await send('Network.setCookie', { name: 'syntheniq_token', value: token, domain: '127.0.0.1', path: '/' });
if (projectId) {
  await navigate(`${BASE}/project?id=${projectId}`);
  await sleep(7000); // job fetch + meta fetch + video preload
  await shot('/tmp/ui-project-top.png');
  await send('Runtime.evaluate', { expression: 'window.scrollTo(0, document.querySelector(".clips")?.offsetTop || 0)' });
  await sleep(1500);
  await shot('/tmp/ui-project-clips.png');
  await send('Runtime.evaluate', { expression: 'window.scrollBy(0, 900)' });
  await sleep(1000);
  await shot('/tmp/ui-project-meta.png');
}

ws.close();
chrome.kill('SIGKILL');
console.log('UI screenshots done');
process.exit(0);
