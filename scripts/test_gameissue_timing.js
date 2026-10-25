#!/usr/bin/env node
'use strict';
const fs = require('fs');
const https = require('https');
const crypto = require('crypto');

// Load login response
const loginData = JSON.parse(fs.readFileSync('/workspace/app/findings/fb999_login_response.json', 'utf8'));
const token = loginData.data.token;
const username = loginData.data.username || loginData.data.userCode;

// From the login response, the username is in the JWT: UserNam=2349121493739
const userCode = '2349121493739';

console.log('=== Testing GetGameIssue for real-time draw timing ===\n');

function randomHex() {
  return crypto.randomBytes(16).toString('hex');
}

function md5Hex(str) {
  return crypto.createHash('md5').update(str).digest('hex').toUpperCase().slice(0, 32);
}

function parseServerTime(str) {
  if (!str) return NaN;
  return new Date(str.replace(' ', 'T')).getTime();
}

// Proven working signParams: MD5(JSON.stringify(sorted filtered params + language:0 + random))
function signParams(params) {
  const u = { ...params, language: 0 };
  u.random = randomHex();
  const c = JSON.parse(JSON.stringify(u));
  const keys = Object.keys(c).filter(
    (k) => !(typeof c[k] === 'object' && c[k] !== null && !Array.isArray(c[k])) && !Array.isArray(c[k])
  );
  keys.sort();
  const signedObj = {};
  for (const k of keys) {
    const v = c[k];
    if (v !== null && v !== '' && v !== undefined) signedObj[k] = v === 0 ? 0 : v;
  }
  u.signature = md5Hex(JSON.stringify(signedObj));
  u.timestamp = Math.floor(Date.now() / 1e3);
  return u;
}

// Proper HTTP request with Bearer token and browser-like headers
function callApi(endpoint, params) {
  const body = JSON.stringify(signParams(params));
  return new Promise((resolve, reject) => {
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7',
      Referer: 'https://fb999.com/',
      Origin: 'https://fb999.com',
      'ar-origin': 'https://fb999.com',
      'Content-Type': 'application/json;charset=UTF-8',
      'Content-Length': Buffer.byteLength(body),
      Authorization: `Bearer ${token}`,
    };
    const req = https.request({
      hostname: 'fb999api.com',
      path: `/api/webapi/${endpoint}`,
      method: 'POST',
      headers,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.setTimeout(12000);
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Poll GetGameIssue to detect when a new round starts
async function pollGameIssue() {
  const results = [];
  let lastIssue = null;
  let lastEndTime = null;

  for (let i = 0; i < 150; i++) { // 150 polls at 10ms intervals = 1.5s
    try {
      const t_before = Date.now();
      const res = await callApi('GetGameIssue', {
        TypeId: 30,
      });
      const t_after = Date.now();

      let parsed;
      try {
        parsed = JSON.parse(res.body);
      } catch {
        parsed = { raw: res.body };
      }

      const now = new Date().toISOString();
      const issue = parsed.data?.issueNumber;
      const endTime = parsed.data?.endTime;
      const serviceTime = parsed.data?.serviceTime || parsed.serviceNowTime;
      const intervalM = parsed.data?.intervalM;

      if (issue !== lastIssue || endTime !== lastEndTime) {
        lastIssue = issue;
        lastEndTime = endTime;
        const ms = intervalM * 60 * 1000;
        console.log(`[${now}] Issue: ${issue}, ServiceTime: ${serviceTime}, EndTime: ${endTime}, intervalM: ${intervalM}`);
        console.log(`  Response time: ${t_after - t_before}ms, Code: ${parsed.code}`);
        results.push({ now, issue, serviceTime, endTime, intervalM, code: parsed.code });
      }
    } catch (e) {
      process.stderr.write('.');
    }
  }
  return results;
}

(async () => {
  console.log('Polling GetGameIssue for 1.5 seconds...\n');
  const results = await pollGameIssue();
  console.log('\n=== Results ===');
  console.log(`Captured ${results.length} unique issue changes`);

  if (results.length > 0) {
    fs.writeFileSync('/workspace/app/findings/gameissue_poll_results.json', JSON.stringify(results, null, 2));
    console.log('Saved to /workspace/app/findings/gameissue_poll_results.json');
  }

  // Show timing analysis
  console.log('\n=== Timing Analysis ===');
  if (results.length > 1) {
    for (let i = 1; i < results.length; i++) {
      const t1 = parseServerTime(results[i-1].serviceTime);
      const t2 = parseServerTime(results[i].serviceTime);
      console.log(`Update at ${results[i].now}: serviceTime jumped by ${((t2-t1)/1000).toFixed(1)}s`);
    }
  }
})();
