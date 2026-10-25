#!/usr/bin/env node
/**
 * test_win_the_lottery.js
 *
 * Tests the GetWinTheLotteryResult endpoint discovered in the JS bundle.
 * This endpoint takes an issueNumber parameter and returns the result for that specific issue.
 * 
 * If this endpoint returns the result BEFORE the round closes (i.e., publishes early),
 * it could be faster than polling the history list.
 */

'use strict';
const https = require('https');
const fs = require('fs');
const crypto = require('crypto');

const login = JSON.parse(fs.readFileSync('/tmp/fb999_login_response.json', 'utf8'));
const JWT = login.data?.token;

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
    const req = https.request({ hostname, path, method: 'GET', timeout: 5000,
      headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15' } },
      res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d })); });
    req.on('error', reject); req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

function httpPost(hostname, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const h = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15',
      ...headers
    };
    h['Content-Length'] = Buffer.byteLength(body);
    const req = https.request({ hostname, path, method: 'POST', headers: h, timeout: 5000 }, res => {
      let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    req.on('error', reject); req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(body); req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
  console.log('=== Testing GetWinTheLotteryResult endpoint ===\n');

  // Get current config
  const cfg = JSON.parse((await httpGet('draw.ar-lottery06.com', '/WinGo/WinGo_30S.json')).body);
  const curEnd = new Date(cfg.current.endTime).getTime();
  const msToClose = curEnd - Date.now();
  const curIssue = cfg.current.issueNumber;

  console.log('Current issue:', curIssue);
  console.log('msToClose:', msToClose);

  const waitMs = Math.max(0, msToClose - 5000);
  if (waitMs > 0) {
    console.log('Waiting', Math.round(waitMs/1000), 's until 5s before close...\n');
    await sleep(waitMs);
  }

  const closeTime = curEnd;
  let detected = false;

  console.log('=== Polling GetWinTheLotteryResult and GetLastFiveIssueNumberResult ===\n');

  for (let i = 0; i < 100; i++) {
    const elapsed = Date.now() - closeTime;

    // Test GetWinTheLotteryResult with current issue number
    try {
      const body = JSON.stringify(signParams({ TypeId: 30, IssueNumber: curIssue }));
      const res = await httpPost('fb999api.com', '/api/webapi/GetWinTheLotteryResult', body,
        { Authorization: `Bearer ${JWT}` });

      if (res.status === 200) {
        const json = JSON.parse(res.body);
        if (json.code === 0 && json.data) {
          const data = json.data;
          // Check if result is available
          if (data.number !== undefined || data.result !== undefined) {
            const num = data.number || (data.result ? data.result.number : '?');
            const color = data.color || (data.result ? data.result.color : '?');
            const status = data.status || 'unknown';
            
            if (!detected) {
              console.log(`[${elapsed}ms] GetWinTheLotteryResult response:`);
              console.log(`  Issue: ${curIssue}`);
              console.log(`  Number: ${num}`);
              console.log(`  Color: ${color}`);
              console.log(`  Status: ${status}`);
              console.log(`  Full data:`, JSON.stringify(data).substring(0, 400));
              detected = true;
            }
          } else if (!detected) {
            // Log non-result responses every 10 iterations
            if (i % 10 === 0) {
              console.log(`[${elapsed}ms] GetWinTheLotteryResult: code=${json.code} data=${JSON.stringify(json.data || {}).substring(0, 100)}`);
            }
          }
        } else {
          if (i % 10 === 0) console.log(`[${elapsed}ms] GetWinTheLotteryResult: code=${json.code} msg=${json.msg || ''}`);
        }
      } else {
        if (i % 10 === 0) console.log(`[${elapsed}ms] GetWinTheLotteryResult: HTTP ${res.status}`);
      }
    } catch(e) {
      if (i % 20 === 0) console.log(`[${elapsed}ms] Error: ${e.message}`);
    }
    
    await sleep(50);
  }

  if (!detected) console.log('\nNo result found via GetWinTheLotteryResult');
})();
