#!/usr/bin/env node
/**
 * fb999_api_test.js
 *
 * Test authenticated FB999 API endpoints to find early result availability.
 * JWT token read from /tmp/fb999_login_response.json (data.token field).
 *
 * Goal: get WinGo_30S results 15-25s before countdown ends.
 *
 * Signing (from winGoApiSearch.js / proven in winGoFinalSystem.js & findAndUseToken.js):
 *   random = crypto.randomBytes(16).toString('hex')       (32-char hex)
 *   language = 0
 *   signature = MD5(JSON.stringify(sorted params)).toUpperCase().slice(0,32)
 *   timestamp = unix seconds
 *   Final body fields: signature, random, language, timestamp + TypeId
 *   (NOT sign/nonce)
 *
 * Usage: node scripts/fb999_api_test.js
 */

'use strict';

const https = require('https');
const fs = require('fs');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// 0. Load JWT token from the fresh login response
// ---------------------------------------------------------------------------
let TOKEN;
try {
  const login = JSON.parse(fs.readFileSync('/tmp/fb999_login_response.json', 'utf8'));
  TOKEN = login.data && login.data.token;
} catch (e) {
  console.error('Cannot read /tmp/fb999_login_response.json:', e.message);
  process.exit(1);
}

if (!TOKEN) {
  console.error('No token found in /tmp/fb999_login_response.json (data.token)');
  process.exit(1);
}

// Decode JWT for sanity / expiry
let jwtPayload = null;
try {
  const parts = TOKEN.split('.');
  jwtPayload = JSON.parse(
    Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
  );
  const expOk = jwtPayload.exp * 1000 > Date.now();
  console.log('=== JWT Token Info ===');
  console.log('  UserId:', jwtPayload.UserId || jwtPayload.userId || '(n/a)');
  console.log('  UserName:', jwtPayload.UserName || '(n/a)');
  console.log('  exp:', jwtPayload.exp ? new Date(jwtPayload.exp * 1000).toISOString() : '(none)');
  console.log('  Token valid (not expired):', expOk ? 'YES' : 'NO');
} catch (e) {
  console.log('Could not decode JWT:', e.message);
}

const USER_ID = 364070;
console.log('Target UserId:', USER_ID);
console.log('Game: WinGo_30S\n');

// ---------------------------------------------------------------------------
// 1. Signing helpers (mirrors the proven signParams from the codebase)
// ---------------------------------------------------------------------------
function randomHex() {
  return crypto.randomBytes(16).toString('hex');
}

function md5Hex(str) {
  return crypto.createHash('md5').update(str).digest('hex').toUpperCase().slice(0, 32);
}

/**
 * signParams — replicate the "PROVEN working" signParams:
 *   1. Start with { ...params, language: 0 }
 *   2. Add random
 *   3. Take only primitive keys, sort alphabetically
 *   4. Drop null / "" / undefined, coerce 0 -> 0 (keeps numeric 0)
 *   5. signature = MD5(JSON.stringify(sorted filtered obj))  -> upper, slice 32
 *   6. Add signature + timestamp
 */
function signParams(params) {
  const u = { ...params, language: 0 };
  u.random = randomHex();

  const c = JSON.parse(JSON.stringify(u));
  // keep primitive (non-array, non-plain-object) keys
  const keys = Object.keys(c).filter((k) => !(typeof c[k] === 'object' && c[k] !== null && !Array.isArray(c[k])) && !Array.isArray(c[k]));
  keys.sort();

  const signedObj = {};
  for (const k of keys) {
    const v = c[k];
    if (v !== null && v !== '' && v !== undefined) {
      signedObj[k] = v === 0 ? 0 : v;
    }
  }

  u.signature = md5Hex(JSON.stringify(signedObj));
  u.timestamp = Math.floor(Date.now() / 1e3);
  return u;
}

// ---------------------------------------------------------------------------
// 2. HTTP request helper (native https)
// ---------------------------------------------------------------------------
function httpsReq(hostname, path, method = 'POST', body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const finalHeaders = {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7',
      Referer: 'https://fb999.com/',
      Origin: 'https://fb999.com',
      'ar-origin': 'https://fb999.com',
      ...headers,
    };

    if (body && !finalHeaders['Content-Type']) finalHeaders['Content-Type'] = 'application/json;charset=UTF-8';
    if (body) finalHeaders['Content-Length'] = Buffer.byteLength(body);

    const req = https.request(
      { hostname, path, method, headers: finalHeaders },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () =>
          resolve({ status: res.statusCode, statusText: res.statusText, headers: res.headers, body: data })
        );
      }
    );
    req.setTimeout(15000, () => {
      req.destroy(new Error('timeout'));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// 3. Endpoints + TypeId matrix
// ---------------------------------------------------------------------------
const ENDPOINTS = [
  { name: 'GetLastFiveIssueNumberResult', path: '/api/webapi/GetLastFiveIssueNumberResult', extraData: { TypeId: 30 } },
  { name: 'GetGameIssue', path: '/api/webapi/GetGameIssue', extraData: { TypeId: 30 } },
  { name: 'GetLotteryResult7Day', path: '/api/webapi/GetLotteryResult7Day', extraData: { TypeId: 30 } },
  { name: 'GetWinTheLotteryResult', path: '/api/webapi/GetWinTheLotteryResult', extraData: { TypeId: 30 } },
];

const TYPE_IDS = [30, 29, 28, 1];

function nowLabel() {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// 4. Run probes
// ---------------------------------------------------------------------------
(async () => {
  const results = [];

  console.log('=== Probing Authenticated FB999 API Endpoints ===\n');

  for (const ep of ENDPOINTS) {
    console.log('========================================');
    console.log(`Endpoint: ${ep.name}  (${ep.path})`);
    console.log('========================================');

    for (const typeId of TYPE_IDS) {
      const signed = signParams({ TypeId: typeId });
      const bodyStr = JSON.stringify(signed);

      const attemptLabel = `${ep.name} TypeId=${typeId}`;
      console.log(`\n[${nowLabel()}] ${attemptLabel}`);
      console.log('  Body:', bodyStr);

      let res;
      try {
        res = await httpsReq(
          'fb999api.com',
          ep.path,
          'POST',
          bodyStr,
          { Authorization: `Bearer ${TOKEN}` }
        );
      } catch (e) {
        console.log('  Network error:', e.message);
        results.push({ endpoint: ep.name, typeId, error: e.message });
        continue;
      }

      console.log(`  Status: ${res.status}`);
      if (res.status === 200 && res.headers['content-length'] === '0') {
        console.log('  (empty 200 response)');
        results.push({ endpoint: ep.name, typeId, status: res.status, body: '' });
        continue;
      }

      let parsed = null;
      try {
        parsed = JSON.parse(res.body);
      } catch (e) {
        // not json
      }

      console.log('  Response body:', res.body ? res.body.substring(0, 800) : '(empty)');

      if (parsed && parsed.code === 0 && parsed.data) {
        console.log('  *** SUCCESS (code=0, data present) ***');
        console.log('  Data preview:', JSON.stringify(parsed.data).substring(0, 600));
      } else if (parsed) {
        console.log('  code:', parsed.code, 'msg:', parsed.msg);
      }

      // Save full response
      const fname = `/tmp/fb999_${ep.name}_TypeId${typeId}_${Date.now()}.json`;
      try {
        fs.writeFileSync(
          fname,
          JSON.stringify(
            {
              endpoint: ep.name,
              path: ep.path,
              typeId,
              status: res.status,
              body: res.body,
              parsed: parsed,
              requestBody: signed,
            },
            null,
            2
          )
        );
        console.log('  Saved:', fname);
      } catch (e) {
        console.log('  Save failed:', e.message);
      }

      results.push({
        endpoint: ep.name,
        typeId,
        status: res.status,
        code: parsed?.code,
        msg: parsed?.msg,
        data: parsed?.data,
      });
    }
  }

  // ---------------------------------------------------------------------------
  // 5. Summary
  // ---------------------------------------------------------------------------
  console.log('\n\n=== SUMMARY ===\n');
  for (const ep of ENDPOINTS) {
    console.log(`\n--- ${ep.name} ---`);
    for (const r of results.filter((x) => x.endpoint === ep.name)) {
      const tag =
        r.code === 0 && r.data
          ? 'SUCCESS'
          : r.status === 200
          ? `code=${r.code}`
          : `status=${r.status}`;
      console.log(`  TypeId=${r.typeId} -> ${tag}${r.msg ? ' (' + r.msg + ')' : ''}`);
      if (r.data) {
        const dataStr = JSON.stringify(r.data);
        if (dataStr.length <= 400) console.log('    data:', dataStr);
        else console.log('    data (truncated):', dataStr.substring(0, 400) + '...');
        // Show keys discovered
        if (typeof r.data === 'object' && r.data !== null) {
          console.log('    data keys:', Object.keys(r.data).join(', '));
        }
      }
    }
  }

  // Look for any TypeId that returned success across all endpoints
  const successes = results.filter((r) => r.code === 0 && r.data);
  console.log('\n=== Endpoints returning code=0 ===');
  for (const s of successes) {
    console.log(`  ${s.endpoint} TypeId=${s.typeId} -> SUCCESS`);
  }
  if (successes.length === 0) {
    console.log('  (none)');
  }

  // Persist full summary
  fs.writeFileSync('/tmp/fb999_api_test_summary.json', JSON.stringify(results, null, 2));
  console.log('\nFull summary saved to /tmp/fb999_api_test_summary.json');
})().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
