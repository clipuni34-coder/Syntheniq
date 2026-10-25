#!/usr/bin/env node
/**
 * fb999-api-probe-v6.js
 *
 * Tests NEW endpoints discovered in JS bundle:
 * - WinGoGetWinTheLotteryResult (/WinGoGetWinTheLotteryResult)
 * - GetHistoryIssue (/GetHistoryIssue)
 * - GetTrxWinTheLotteryResult
 * - GetLastFiveIssueNumberResult (known working, as baseline)
 * - GetLotteryResult7Day (known, as baseline)
 *
 * These are tested during a live round transition to check timing.
 */

'use strict';
const https = require('https');
const fs = require('fs');
const crypto = require('crypto');

// Load JWT from login response
let JWT;
try {
  const login = JSON.parse(fs.readFileSync('/tmp/fb999_login_response.json', 'utf8'));
  JWT = login.data?.token;
  if (!JWT) throw new Error('No token in login response');
} catch (e) {
  console.error('No JWT found:', e.message);
  process.exit(1);
}

// Sign params (fb999 format)
function signParams(params) {
  const u = { ...params, language: 0 };
  u.random = crypto.randomBytes(16).toString('hex');
  const c = JSON.parse(JSON.stringify(u));
  const o = Object.keys(c).filter(k =>
    !(typeof c[k] === 'object' && c[k] !== null && !Array.isArray(c[k])) && !Array.isArray(c[k]));
  o.sort();
  const i = {};
  o.forEach(k => { if (c[k] !== null && c[k] !== "" && c[k] !== undefined) i[k] = c[k] === 0 ? 0 : c[k]; });
  u.signature = crypto.createHash('md5').update(JSON.stringify(i)).digest('hex').toUpperCase().slice(0, 32);
  u.timestamp = Math.floor(Date.now() / 1e3);
  return u;
}

function httpGet(hostname, path) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path, method: 'GET', timeout: 5000 }, res => {
      let data = ''; res.on('data', c => data += c); res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject); req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

function httpPost(hostname, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const h = { 'Content-Type': 'application/json', 'Accept': 'application/json', timeout: 5000, ...headers };
    h['Content-Length'] = Buffer.byteLength(body);
    const req = https.request({ hostname, path, method: 'POST', headers: h, timeout: 5000 }, res => {
      let data = ''; res.on('data', c => data += c); res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject); req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(body); req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
  console.log('=== Probing NEW API endpoints during round transition ===\n');

  // Get current config
  const cfg = JSON.parse((await httpGet('draw.ar-lottery06.com', '/WinGo/WinGo_30S.json')).body);
  const curEnd = new Date(cfg.current.endTime).getTime();
  const msToClose = curEnd - Date.now();
  const closeTime = curEnd;

  console.log('Current issue:', cfg.current.issueNumber);
  console.log('msToClose:', msToClose, 'ms');
  console.log('Waiting until 5s before close...\n');

  const waitMs = Math.max(0, msToClose - 5000);
  await sleep(waitMs);

  // Define new endpoints to test
  const endpoints = [
    { name: 'WinGoGetWinTheLotteryResult', params: { TypeId: 30 } },
    { name: 'GetHistoryIssue', params: { TypeId: 30, pageNo: 1, pageSize: 10 } },
    { name: 'GetTrxWinTheLotteryResult', params: { TypeId: 30 } },
    { name: 'GetLastFiveIssueNumberResult', params: { TypeId: 30 } },
    { name: 'GetWinTheLotteryResult', params: { TypeId: 30 } },
  ];

  let lastIssue = '';
  const detected = [];

  console.log('=== High-freq polling new endpoints @ 50ms ===\n');

  for (let i = 0; i < 80; i++) {
    for (const ep of endpoints) {
      try {
        const body = JSON.stringify(signParams(ep.params));
        const res = await httpPost('fb999api.com', `/api/webapi/${ep.name}`, body,
          { Authorization: `Bearer ${JWT}`, Referer: 'https://h5.ar-lottery06.com/', Origin: 'https://h5.ar-lottery06.com' });

        if (res.status === 200) {
          const json = JSON.parse(res.body);
          const elapsed = Date.now() - closeTime;

          // Check for new result
          if (ep.name === 'GetLastFiveIssueNumberResult') {
            const nums = json.data?.number || '';
            if (nums && nums !== lastIssue) {
              const firstNum = nums.split(',')[0];
              console.log(`[${Math.round(elapsed)}ms] ${ep.name}: ${nums} (first=${firstNum})`);
              detected.push({ endpoint: ep.name, time: elapsed, value: nums, firstNum, full: json });
              lastIssue = nums;
            }
          } else if (json.code === 0 && json.data) {
            const dataStr = JSON.stringify(json.data).substring(0, 200);
            if (dataStr.includes(cfg.current.issueNumber)) {
              console.log(`[${Math.round(elapsed)}ms] ${ep.name}: ${dataStr}`);
              detected.push({ endpoint: ep.name, time: elapsed, data: json.data });
            }
          } else if (json.code !== 0) {
            // Only log non-7 codes (7 = param error, we've seen that)
            if (json.code !== 7) console.log(`[${Math.round(elapsed)}ms] ${ep.name}: code=${json.code} msg=${json.msg}`);
          }
        }
      } catch (e) {
        // Skip errors
      }
    }
    await sleep(50);
  }

  console.log('\n=== RESULTS ===');
  detected.forEach(d => {
    console.log(`${d.endpoint} @ ${d.time}ms from close:`, d.value || d.data);
  });

  fs.writeFileSync('/tmp/fb999_new_endpoints.json', JSON.stringify(detected, null, 2));
  console.log('\nSaved: /tmp/fb999_new_endpoints.json');
})();
