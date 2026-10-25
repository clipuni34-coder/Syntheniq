#!/usr/bin/env node
/**
 * fb999_multi_probe.js
 *
 * Tries multiple fb999 API endpoints and h5.ar-lottery01.com paths
 * to find any that might return results earlier or with a different data format.
 *
 * Tests:
 *  1. 10 different API endpoint names on fb999api.com
 *     (GetLastFiveIssueNumberResult, GetGameIssue, GetLotteryResult7Day,
 *      GetWinTheLotteryResult, + 6 other variants)
 *  2. 5 different h5.ar-lottery01.com paths
 *
 * Usage: node scripts/fb999_multi_probe.js
 */

'use strict';

const https = require('https');
const fs = require('fs');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// 0. Load JWT token from login response
// ---------------------------------------------------------------------------
let TOKEN, LOTTERY_TOKEN;
try {
  const login = JSON.parse(fs.readFileSync('/tmp/fb999_login_response.json', 'utf8'));
  TOKEN = login.data && login.data.token;
  // Extract lottery token from lotteryLoginUrl
  const url = login.data && login.data.lotteryLoginUrl;
  if (url) {
    const m = url.match(/[?&]Token=([^&]+)/);
    if (m) LOTTERY_TOKEN = m[1];
  }
} catch (e) {
  console.error('Cannot read /tmp/fb999_login_response.json:', e.message);
  process.exit(1);
}
if (!TOKEN) { console.error('No token found'); process.exit(1); }

// Decode JWT for sanity
try {
  const parts = TOKEN.split('.');
  const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  const valid = payload.exp * 1000 > Date.now();
  console.log('=== Token Info ===');
  console.log('  UserId:', payload.UserId || payload.userId || '(n/a)');
  console.log('  TokenType:', payload.TokenType || '(n/a)');
  console.log('  exp:', payload.exp ? new Date(payload.exp * 1000).toISOString() : '(none)');
  console.log('  Token valid:', valid ? 'YES' : 'NO');
  if (!valid) console.log('  WARNING: Token expired, requests may fail.');
  console.log('  Lottery Token available:', LOTTERY_TOKEN ? 'YES' : 'NO');
} catch(e) {
  console.log('Could not decode JWT:', e.message);
}
console.log('Game: WinGo_30S (TypeId=30)\n');

// ---------------------------------------------------------------------------
// 1. Signing helpers (proven from winGoApiSearch.js / fb999_api_final.js)
// ---------------------------------------------------------------------------
function randomHex() { return crypto.randomBytes(16).toString('hex'); }
function md5Hex(s) { return crypto.createHash('md5').update(s).digest('hex').toUpperCase().slice(0, 32); }
function signParams(params) {
  const u = { ...params, language: 0 };
  u.random = randomHex();
  const c = JSON.parse(JSON.stringify(u));
  const o = Object.keys(c).filter(k =>
    !(typeof c[k] === 'object' && c[k] !== null && !Array.isArray(c[k])) && !Array.isArray(c[k])
  );
  o.sort();
  const i = {};
  for (const k of o) {
    const v = c[k];
    if (v !== null && v !== '' && v !== undefined) i[k] = v === 0 ? 0 : v;
  }
  u.signature = md5Hex(JSON.stringify(i));
  u.timestamp = Math.floor(Date.now() / 1e3);
  return u;
}

// ---------------------------------------------------------------------------
// 2. HTTP helpers
// ---------------------------------------------------------------------------
function httpsReq(hostname, path, method = 'GET', body = null, headers = {}, port = 443) {
  return new Promise((resolve, reject) => {
    const mergedHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7',
      'Referer': 'https://fb999.com/',
      'Origin': 'https://fb999.com',
      ...headers,
    };
    if (body) {
      mergedHeaders['Content-Type'] = 'application/json;charset=UTF-8';
      mergedHeaders['Content-Length'] = Buffer.byteLength(body);
    }
    const req = https.request({ hostname, port, path, method, headers: mergedHeaders }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    });
    req.setTimeout(12000);
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function postApi(hostname, path, params) {
  const body = JSON.stringify(signParams(params));
  try {
    const res = await httpsReq(hostname, path, 'POST', body, { Authorization: `Bearer ${TOKEN}` });
    let parsed = null;
    try { parsed = JSON.parse(res.body); } catch(e) {}
    return { status: res.status, body: res.body, parsed, requestBody: signParams(params) };
  } catch(e) {
    return { status: 0, body: '', parsed: null, error: e.message, requestBody: signParams(params) };
  }
}

async function getReq(hostname, path, headers = {}) {
  try {
    const res = await httpsReq(hostname, path, 'GET', null, headers);
    let parsed = null;
    try { parsed = JSON.parse(res.body); } catch(e) {}
    return { status: res.status, body: res.body, parsed };
  } catch(e) {
    return { status: 0, body: '', parsed: null, error: e.message };
  }
}

function tryParse(str) {
  try { return JSON.parse(str); } catch(e) { return null; }
}

// ---------------------------------------------------------------------------
// 3. Define the 10 fb999api.com endpoints
// ---------------------------------------------------------------------------
const API_ENDPOINTS = [
  { name: 'GetLastFiveIssueNumberResult', path: '/api/webapi/GetLastFiveIssueNumberResult', params: { TypeId: 30 } },
  { name: 'GetGameIssue',                path: '/api/webapi/GetGameIssue',                params: { TypeId: 30 } },
  { name: 'GetLotteryResult7Day',        path: '/api/webapi/GetLotteryResult7Day',        params: { TypeId: 30 } },
  { name: 'GetWinTheLotteryResult',      path: '/api/webapi/GetWinTheLotteryResult',      params: { TypeId: 30 } },
  { name: 'GetLotteryIssue',             path: '/api/webapi/GetLotteryIssue',             params: { TypeId: 30 } },
  { name: 'GetHistoryIssue',             path: '/api/webapi/GetHistoryIssue',             params: { TypeId: 30, page: 1, pageSize: 10 } },
  { name: 'GetCurrentIssue',             path: '/api/webapi/GetCurrentIssue',             params: { TypeId: 30 } },
  { name: 'GetLotteryList',              path: '/api/webapi/GetLotteryList',              params: { TypeId: 30 } },
  { name: 'GetLotteryConfig',            path: '/api/webapi/GetLotteryConfig',            params: { TypeId: 30 } },
  { name: 'GetUserInfo',                 path: '/api/webapi/GetUserInfo',                 params: {} },
];

// ---------------------------------------------------------------------------
// 4. Define the 5 h5.ar-lottery01.com paths
// ---------------------------------------------------------------------------
const H5_PATHS = [
  { label: 'Root with Lottery Token',    path: '/?Token=' + (LOTTERY_TOKEN || 'NO_TOKEN') },
  { label: 'GetGameIssue API',           path: '/api/Lottery/GetGameIssue?gameCode=WinGo_30S' },
  { label: 'getLotteryIssue API',        path: '/api/lottery/getLotteryIssue?gameCode=WinGo_30S' },
  { label: 'getHistoryIssue API',        path: '/api/lottery/getHistoryIssue?lottery=WinGo&gameCode=WinGo_30S&pageNo=1&pageSize=10' },
  { label: 'getCurrentIssue API',        path: '/api/lottery/getCurrentIssue?gameCode=WinGo_30S' },
];

// ---------------------------------------------------------------------------
// 5. Run probes
// ---------------------------------------------------------------------------
(async () => {
  console.log('=== FB999 Multi-Endpoint Probe ===\n');

  // ---- Part 1: fb999api.com endpoints ----
  console.log('=' .repeat(60));
  console.log('PART 1: fb999api.com — 10 API Endpoints');
  console.log('=' .repeat(60));

  const apiResults = [];
  for (const ep of API_ENDPOINTS) {
    console.log(`\n--- [${ep.name}] POST ${ep.path} ---`);
    console.log(`  Params: ${JSON.stringify(ep.params)}`);
    const res = await postApi('fb999api.com', ep.path, ep.params);
    if (res.error) {
      console.log(`  Network error: ${res.error}`);
      apiResults.push({ name: ep.name, error: res.error });
      continue;
    }
    console.log(`  HTTP Status: ${res.status}`);
    console.log(`  Response: ${res.body ? res.body.substring(0, 600) : '(empty)'}`);

    if (res.parsed) {
      const code = res.parsed.code;
      const msg = res.parsed.msg;
      console.log(`  code: ${code}, msg: ${msg}`);
      if (code === 0 || code === '0') {
        console.log(`  *** SUCCESS (code=0) ***`);
        console.log(`  Data: ${JSON.stringify(res.parsed.data || res.parsed).substring(0, 800)}`);
        // Save
        const fn = `/tmp/fb999_probe_${ep.name}_${Date.now()}.json`;
        fs.writeFileSync(fn, JSON.stringify({ endpoint: ep.name, path: ep.path, params: ep.params, response: res.parsed, requestBody: res.requestBody }, null, 2));
        console.log(`  Saved: ${fn}`);
        apiResults.push({ name: ep.name, code: code, data: res.parsed.data, success: true });
      } else {
        apiResults.push({ name: ep.name, code: code, msg: msg, success: false });
      }
    } else {
      apiResults.push({ name: ep.name, status: res.status, success: false, body: res.body?.substring(0, 200) });
    }
  }

  // ---- Part 2: h5.ar-lottery01.com paths ----
  console.log('\n\n' + '=' .repeat(60));
  console.log('PART 2: h5.ar-lottery01.com — 5 Paths');
  console.log('=' .repeat(60));

  const h5Results = [];
  for (const endpoint of H5_PATHS) {
    console.log(`\n--- [${endpoint.label}] GET ${endpoint.path} ---`);

    // Try with Lottery Token cookie + Bearer
    const h5Headers = {
      Cookie: `Token=${LOTTERY_TOKEN || ''}`,
    };

    const res = await getReq('h5.ar-lottery01.com', endpoint.path, h5Headers);
    if (res.error) {
      console.log(`  Network error: ${res.error}`);
      h5Results.push({ label: endpoint.label, error: res.error });
      continue;
    }
    console.log(`  HTTP Status: ${res.status}`);
    console.log(`  Response: ${res.body ? res.body.substring(0, 600) : '(empty)'}`);

    if (res.parsed) {
      const code = res.parsed.code;
      const msg = res.parsed.msg;
      console.log(`  code: ${code}, msg: ${msg}`);
      if (code === 0 || code === '0') {
        console.log(`  *** SUCCESS (code=0) ***`);
        console.log(`  Data: ${JSON.stringify(res.parsed.data || res.parsed).substring(0, 800)}`);
        const fn = `/tmp/h5_probe_${endpoint.label.replace(/\s+/g, '_')}_${Date.now()}.json`;
        fs.writeFileSync(fn, JSON.stringify({ label: endpoint.label, path: endpoint.path, status: res.status, response: res.parsed }, null, 2));
        console.log(`  Saved: ${fn}`);
        h5Results.push({ label: endpoint.label, code: code, data: res.parsed.data, success: true });
      } else {
        h5Results.push({ label: endpoint.label, code: code, msg: msg, success: false });
      }
    } else {
      // Check if it's HTML
      if (res.body && res.body.includes('<')) {
        console.log(`  (HTML response — likely SPA shell, ${res.body.length} bytes)`);
      }
      h5Results.push({ label: endpoint.label, status: res.status, success: false, bodyPreview: res.body?.substring(0, 200) });
    }
  }

  // ---- Summary ----
  console.log('\n\n' + '=' .repeat(60));
  console.log('SUMMARY: Endpoints returning code=0 (success)');
  console.log('=' .repeat(60));

  console.log('\nfb999api.com:');
  let anyApiSuccess = false;
  for (const r of apiResults) {
    if (r.success) {
      anyApiSuccess = true;
      console.log(`  ${r.name}: code=0 ✓`);
      if (r.data) {
        const ds = JSON.stringify(r.data);
        if (ds.length <= 500) console.log(`    data: ${ds}`);
        else console.log(`    data (truncated): ${ds.substring(0, 500)}...`);
      }
    } else {
      console.log(`  ${r.name}: code=${r.code ?? 'n/a'} ${r.msg ? `(${r.msg})` : ''} ${r.error ? `(${r.error})` : ''}`);
    }
  }

  console.log('\nh5.ar-lottery01.com:');
  let anyH5Success = false;
  for (const r of h5Results) {
    if (r.success) {
      anyH5Success = true;
      console.log(`  ${r.label}: code=0 ✓`);
      if (r.data) {
        const ds = JSON.stringify(r.data);
        if (ds.length <= 500) console.log(`    data: ${ds}`);
        else console.log(`    data (truncated): ${ds.substring(0, 500)}...`);
      }
    } else {
      console.log(`  ${r.label}: code=${r.code ?? 'n/a'} status=${r.status ?? 'n/a'} ${r.error ? `(${r.error})` : ''}`);
    }
  }

  if (!anyApiSuccess && !anyH5Success) {
    console.log('\n(no endpoints returned code=0)');
  }

  // Persist full summary
  const summaryPath = '/tmp/fb999_multi_probe_summary.json';
  fs.writeFileSync(summaryPath, JSON.stringify({
    tokenValid: (() => { try { const p = JSON.parse(Buffer.from(TOKEN.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString()); return p.exp * 1000 > Date.now(); } catch(e) { return false; } })(),
    apiResults, h5Results,
  }, null, 2));
  console.log(`\nFull summary saved to: ${summaryPath}`);
  console.log('\n=== Done ===');
})().catch((e) => { console.error('Fatal:', e.message); process.exit(1); });
