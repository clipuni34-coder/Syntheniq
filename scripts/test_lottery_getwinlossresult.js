#!/usr/bin/env node
/**
 * test_lottery_getwinlossresult.js
 *
 * The bundle analysis revealed the REAL result endpoint:
 * - POST https://h5.ar-lottery06.com/api/Lottery/GetWinLossResult
 * - Auth: ar_token from localStorage
 * - Parameter: { issueNumber: <number> }
 *
 * This is different from the dead-code GetWinTheLotteryResult endpoint.
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

function httpGet(hostname, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path, method: 'GET', timeout: 5000,
      headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15', ...headers } },
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
  console.log('=== Testing /api/Lottery/GetWinLossResult on h5.ar-lottery06.com ===\n');

  // Get current config
  const cfg = JSON.parse((await httpGet('draw.ar-lottery06.com', '/WinGo/WinGo_30S.json')).body);
  const curEnd = new Date(cfg.current.endTime).getTime();
  const msToClose = curEnd - Date.now();
  const curIssue = cfg.current.issueNumber;
  const prevIssue = cfg.previous.issueNumber;

  console.log('Current issue:', curIssue);
  console.log('Previous issue:', prevIssue);
  console.log('msToClose:', msToClose);

  // First, test with previous issue (should have a result)
  console.log('\n=== Test 1: GetWinLossResult with PREVIOUS issue (should return result) ===');
  try {
    const body1 = JSON.stringify({ issueNumber: prevIssue });
    const res1 = await httpPost('h5.ar-lottery06.com', '/api/Lottery/GetWinLossResult', body1,
      { Authorization: `Bearer ${JWT}`, 'ar_token': JWT, Cookie: `ar_token=${JWT}` });
    console.log('Status:', res1.status);
    console.log('Body:', res1.body.substring(0, 500));
  } catch(e) { console.log('Error:', e.message); }

  // Test with current issue (may not have result yet)
  console.log('\n=== Test 2: GetWinLossResult with CURRENT issue ===');
  try {
    const body2 = JSON.stringify({ issueNumber: curIssue });
    const res2 = await httpPost('h5.ar-lottery06.com', '/api/Lottery/GetWinLossResult', body2,
      { Authorization: `Bearer ${JWT}`, 'ar_token': JWT, Cookie: `ar_token=${JWT}` });
    console.log('Status:', res2.status);
    console.log('Body:', res2.body.substring(0, 500));
  } catch(e) { console.log('Error:', e.message); }

  // Test with signed params
  console.log('\n=== Test 3: Signed GetWinLossResult with PREVIOUS issue ===');
  try {
    const signed = signParams({ issueNumber: prevIssue, TypeId: 30 });
    const body3 = JSON.stringify(signed);
    console.log('Signed body:', body3);
    const res3 = await httpPost('h5.ar-lottery06.com', '/api/Lottery/GetWinLossResult', body3,
      { Authorization: `Bearer ${JWT}`, 'ar_token': JWT, Cookie: `ar_token=${JWT}` });
    console.log('Status:', res3.status);
    console.log('Body:', res3.body.substring(0, 500));
  } catch(e) { console.log('Error:', e.message); }

  // Wait until close and poll current issue
  const waitMs = Math.max(0, msToClose - 3000);
  if (waitMs > 0) {
    console.log(`\n=== Waiting ${Math.round(waitMs/1000)}s until 3s before close, then polling ===`);
    await sleep(waitMs);
  }

  const closeTime = curEnd;
  console.log('\n=== Polling GetWinLossResult for CURRENT issue ===\n');

  for (let i = 0; i < 80; i++) {
    const elapsed = Date.now() - closeTime;
    try {
      const body = JSON.stringify({ issueNumber: curIssue });
      const res = await httpPost('h5.ar-lottery06.com', '/api/Lottery/GetWinLossResult', body,
        { Authorization: `Bearer ${JWT}`, 'ar_token': JWT, Cookie: `ar_token=${JWT}` });

      if (res.status === 200) {
        try {
          const json = JSON.parse(res.body);
          if (json.code === 0 && json.data) {
            const data = json.data;
            if (data.number !== undefined || data.result) {
              console.log(`[${elapsed}ms] *** RESULT FOUND ***`);
              console.log('  Data:', JSON.stringify(data).substring(0, 400));
              break;
            }
          } else if (json.code !== 0) {
            if (i % 10 === 0) console.log(`[${elapsed}ms] code=${json.code} msg=${json.msg || ''}`);
          }
        } catch(e) {
          if (i % 10 === 0) console.log(`[${elapsed}ms] Non-JSON response:`, res.body.substring(0, 100));
        }
      } else {
        if (i % 10 === 0) console.log(`[${elapsed}ms] Status: ${res.status}`);
      }
    } catch(e) {
      if (i % 20 === 0) console.log(`[${elapsed}ms] Error: ${e.message}`);
    }
    await sleep(50);
  }
})();
