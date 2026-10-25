#!/usr/bin/env node
/**
 * test_getwinlossresult_v2.js
 *
 * Fixed version - use GET instead of POST for h5.ar-lottery06.com/api/Lottery/*
 * 
 * The app's Ge.get() client calls GET endpoints like /api/Lottery/GetGameIssue?gameCode=WinGo_30S
 * So GetWinLossResult likely uses GET too.
 */

'use strict';
const https = require('https');
const fs = require('fs');
const crypto = require('crypto');

const login = JSON.parse(fs.readFileSync('/tmp/fb999_login_response.json', 'utf8'));
const JWT = login.data?.token;
const lotteryLoginUrl = login.data?.lotteryLoginUrl || '';
const LTOKEN = lotteryLoginUrl ? new URL(lotteryLoginUrl).searchParams.get('Token') : JWT;
// h5.ar-lottery06.com authenticates on the lottery session token (lotteryToken),
// NOT the fb999 JWT (whose signature the h5 auth middleware cannot verify).
const AUTH = { Authorization: `Bearer ${LTOKEN || JWT}`, 'ar_token': LTOKEN || JWT, Cookie: `ar_token=${LTOKEN || JWT}` };

function httpGet(hostname, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path, method: 'GET', timeout: 5000,
      headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15', ...headers } },
      res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d })); });
    req.on('error', reject); req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
  console.log('=== Testing /api/Lottery/GetWinLossResult (GET) on h5.ar-lottery06.com ===\n');

  // Get current config
  const cfg = JSON.parse((await httpGet('draw.ar-lottery06.com', '/WinGo/WinGo_30S.json')).body);
  const curEnd = new Date(cfg.current.endTime).getTime();
  const msToClose = curEnd - Date.now();
  const curIssue = cfg.current.issueNumber;
  const prevIssue = cfg.previous.issueNumber;

  console.log('Current issue:', curIssue);
  console.log('Previous issue:', prevIssue);
  console.log('msToClose:', msToClose);

  // Test 1: GET with previous issue (should have result)
  console.log('\n=== Test 1: GET /api/Lottery/GetWinLossResult?issueNumber=' + prevIssue + ' ===');
  try {
    const res = await httpGet('h5.ar-lottery06.com', `/api/Lottery/GetWinLossResult?issueNumber=${prevIssue}`,
   AUTH);
    console.log('Status:', res.status);
    console.log('Body:', res.body.substring(0, 500));
  } catch(e) { console.log('Error:', e.message); }

  // Test 2: GET with signed params format
  console.log('\n=== Test 2: GET with TypeId ===');
  try {
    const res = await httpGet('h5.ar-lottery06.com', `/api/Lottery/GetWinLossResult?issueNumber=${prevIssue}&TypeId=30`,
   AUTH);
    console.log('Status:', res.status);
    console.log('Body:', res.body.substring(0, 500));
  } catch(e) { console.log('Error:', e.message); }

  // Test 3: GET with gameCode param
  console.log('\n=== Test 3: GET with gameCode ===');
  try {
    const res = await httpGet('h5.ar-lottery06.com', `/api/Lottery/GetWinLossResult?gameCode=WinGo_30S&issueNumber=${prevIssue}`,
   AUTH);
    console.log('Status:', res.status);
    console.log('Body:', res.body.substring(0, 500));
  } catch(e) { console.log('Error:', e.message); }

  // Test 4: Try other Lottery endpoints
  console.log('\n=== Test 4: Other Lottery endpoints ===');
  const testUrls = [
    `/api/Lottery/GetGameIssue?gameCode=WinGo_30S`,
    `/api/Lottery/GetWinResult?gameCode=WinGo_30S`,
    `/api/Lottery/GetResult?gameCode=WinGo_30S`,
    `/api/Lottery/GetLastFiveIssueNumberResult?TypeId=30`,
    `/api/Lottery/GetWinLossResult?issueNumber=${prevIssue}&gameCode=WinGo_30S`,
  ];
  for (const url of testUrls) {
    try {
       const res = await httpGet('h5.ar-lottery06.com', url, AUTH);
      console.log(`${url}: ${res.status} - ${res.body.substring(0, 100)}`);
    } catch(e) { console.log(`${url}: Error ${e.message}`); }
  }

  // Wait until close and poll
  const waitMs = Math.max(0, msToClose - 5000);
  if (waitMs > 0) {
    console.log(`\n=== Waiting ${Math.round(waitMs/1000)}s until 5s before close ===`);
    await sleep(waitMs);
  }

  const closeTime = curEnd;
  console.log('\n=== Polling for current issue result ===\n');

  let lastCode = null, lastMsg = null, repeat = 0;
  const flush = () => { if (repeat > 1) console.log(`  ... (prev response repeated ${repeat} time(s))`); };
  for (let i = 0; i < 80; i++) {
    const elapsed = Date.now() - closeTime;
    try {
      const res = await httpGet('h5.ar-lottery06.com',
        `/api/Lottery/GetWinLossResult?issueNumber=${curIssue}&gameCode=WinGo_30S`,
        AUTH);

      if (res.status === 200) {
        try {
          const json = JSON.parse(res.body);
          if (json.code === 0 && json.data) {
            console.log(`[${elapsed}ms] GET result: ${JSON.stringify(json.data).substring(0, 300)}`);
            if (json.data.number !== undefined || json.data.result) {
              console.log(`[${elapsed}ms] *** RESULT DETECTED ***`);
              console.log('  Full:', JSON.stringify(json).substring(0, 500));
              break;
            }
            if (json.code !== lastCode || json.msg !== lastMsg) { flush(); lastCode = json.code; lastMsg = json.msg || ''; repeat = 1; console.log(`[${elapsed}ms] code=${json.code} msg=${json.msg || ''}`); }
            else { repeat++; }
          } else {
            if (json.code !== lastCode || json.msg !== lastMsg) { flush(); lastCode = json.code; lastMsg = json.msg || ''; repeat = 1; console.log(`[${elapsed}ms] code=${json.code} msg=${json.msg || ''}`); }
            else { repeat++; }
          }
        } catch(e) {
          if (i === 0) console.log(`[${elapsed}ms] Non-JSON: ${res.body.substring(0, 80)}`);
        }
      } else {
        console.log(`[${elapsed}ms] Status: ${res.status}`);
      }
    } catch(e) {
      if (i === 0) console.log(`[${elapsed}ms] Error: ${e.message}`);
    }
    await sleep(50);
  }
  flush();
  console.log('Polling complete.');
})();
