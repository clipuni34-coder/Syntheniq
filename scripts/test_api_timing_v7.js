#!/usr/bin/env node
/**
 * test_api_timing_v7.js
 *
 * CRITICAL TEST: Verify if GetLastFiveIssueNumberResult returns results BEFORE close
 * This contradicts earlier findings where it was 28s late.
 * 
 * Theory: The API returns a rolling 5-item list. When a new result is published
 * by the draw server ~1.3s before close, the API list shifts and the new result
 * appears in position [0]. This could be a faster detection path than history polling!
 *
 * This script does side-by-side comparison:
 * - Draw server history endpoint (known ~1.3s early)
 * - API GetLastFiveIssueNumberResult (potentially early too?)
 * - API GetGameIssue (detects round close)
 *
 * All polled simultaneously @ 20ms interval around round transition.
 */

'use strict';
const https = require('https');
const fs = require('fs');
const crypto = require('crypto');

// Load JWT
let JWT;
try {
  const login = JSON.parse(fs.readFileSync('/tmp/fb999_login_response.json', 'utf8'));
  JWT = login.data?.token;
  if (!JWT) throw new Error('No token');
} catch (e) {
  console.error('No JWT:', e.message);
  process.exit(1);
}

function signParams(params) {
  const u = { ...params, language: 0 };
  u.random = crypto.randomBytes(16).toString('hex');
  const c = JSON.parse(JSON.stringify(u));
  const o = Object.keys(c).filter(k => !(typeof c[k] === 'object' && c[k] !== null && !Array.isArray(c[k])) && !Array.isArray(c[k]));
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
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
      'Referer': 'https://h5.ar-lottery06.com/',
      'Origin': 'https://h5.ar-lottery06.com',
      'ar-origin': 'https://h5.ar-lottery06.com',
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
  console.log('=== Side-by-Side Timing Test: Draw Server vs API ===\n');

  // Get config
  const cfg = JSON.parse((await httpGet('draw.ar-lottery06.com', '/WinGo/WinGo_30S.json')).body);
  const curEnd = new Date(cfg.current.endTime).getTime();
  const msToClose = curEnd - Date.now();
  const closeTime = curEnd;
  const curIssue = cfg.current.issueNumber;

  console.log('Current issue:', curIssue);
  console.log('Close time:', new Date(curEnd).toISOString());
  console.log('msToClose:', msToClose, 'ms');

  // Get baseline
  const baselineHist = JSON.parse((await httpGet('draw.ar-lottery06.com',
    '/WinGo/WinGo_30S/GetHistoryIssuePage.json?pageNo=1&pageSize=5')).body);
  const baselineApi = JSON.parse((await httpPost('fb999api.com', '/api/webapi/GetLastFiveIssueNumberResult',
    JSON.stringify(signParams({ TypeId: 30 })), { Authorization: `Bearer ${JWT}` })).body);

  const baselineHistIssue = baselineHist.data?.list?.[0]?.issueNumber;
  const baselineApiNums = baselineApi.data?.number || '';
  console.log('Baseline draw history[0]:', baselineHistIssue);
  console.log('Baseline API lastFive:', baselineApiNums);

  // Wait until 5s before close
  const waitMs = Math.max(0, msToClose - 5000);
  if (waitMs > 0) {
    console.log('\nWaiting', Math.round(waitMs/1000), 's until 5s-before-close...\n');
    await sleep(waitMs);
  }

  console.log('=== Starting simultaneous 20ms polling ===\n');

  let lastHistIssue = baselineHistIssue;
  let lastApiNums = baselineApiNums;

  const detections = [];

  for (let i = 0; i < 150; i++) {
    const elapsed = Date.now() - closeTime;
    const ts = new Date().toISOString();

    // Poll BOTH sources simultaneously (parallel for true concurrency)
    try {
      const [histRes, apiRes] = await Promise.all([
        httpGet('draw.ar-lottery06.com',
          '/WinGo/WinGo_30S/GetHistoryIssuePage.json?pageNo=1&pageSize=5'),
        httpPost('fb999api.com', '/api/webapi/GetLastFiveIssueNumberResult',
          JSON.stringify(signParams({ TypeId: 30 })), { Authorization: `Bearer ${JWT}` })
      ]);
      const hist = JSON.parse(histRes.body);
      const histList = hist.data?.list || [];

      const api = JSON.parse(apiRes.body);
      const apiNums = api.data?.number || '';

      // Check for history change
      const newHistIssue = histList[0]?.issueNumber;
      if (newHistIssue && newHistIssue !== lastHistIssue) {
        console.log(`[${elapsed}ms] DRAW-SERVER NEW RESULT:`);
        console.log(`  Issue: ${newHistIssue} | Number: ${histList[0].number} | Color: ${histList[0].color}`);
        detections.push({ source: 'draw-server', time: elapsed, number: histList[0].number, color: histList[0].color, issue: newHistIssue });
        lastHistIssue = newHistIssue;
      }

      // Check for API LastFive change
      if (apiNums && apiNums !== lastApiNums) {
        const firstNum = apiNums.split(',')[0];
        console.log(`[${elapsed}ms] API LastFive NEW RESULT:`);
        console.log(`  Numbers: ${apiNums} | First: ${firstNum}`);
        detections.push({ source: 'api-lastfive', time: elapsed, number: firstNum, allNums: apiNums });
        lastApiNums = apiNums;
      }
    } catch (e) {
      // Continue on error
    }

    await sleep(20);
  }

  // Analysis
  console.log('\n=== DETECTION SUMMARY ===');
  const drawDetect = detections.filter(d => d.source === 'draw-server')[0];
  const apiDetect = detections.filter(d => d.source === 'api-lastfive')[0];

  console.log('Draw server first detection:', drawDetect ? `${drawDetect.time}ms, num=${drawDetect.number}` : 'NONE');
  console.log('API first detection:', apiDetect ? `${apiDetect.time}ms, num=${apiDetect.number}` : 'NONE');

  if (drawDetect && apiDetect) {
    const delta = apiDetect.time - drawDetect.time;
    console.log(`API vs DrawServer delta: ${delta}ms`);
  }

  fs.writeFileSync('/tmp/wingo_timing_analysis.json', JSON.stringify({
    drawServer: drawDetect,
    apiLastFive: apiDetect,
    allDetections: detections
  }, null, 2));
  console.log('\nSaved: /tmp/wingo_timing_analysis.json');
})();
