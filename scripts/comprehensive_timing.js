#!/usr/bin/env node
/**
 * Comprehensive Timing Analysis Script
 * Polls all four key endpoints simultaneously and logs exact timestamps
 * for each phase of the result publication pipeline.
 */
'use strict';

const https = require('https');
const crypto = require('crypto');
const fs = require('fs');

// === Load tokens ===
const cognitoTokens = JSON.parse(fs.readFileSync('/tmp/viralclips_tokens.json', 'utf8'));
const ACCESS_TOKEN = cognitoTokens.access_token;
const fb999Login = JSON.parse(fs.readFileSync('/tmp/fb999_login_response.json', 'utf8'));
const FB999_JWT = fb999Login.data && fb999Login.data.token;

const runSecs = parseInt(process.argv[2] || 75, 10);

// === Signing for fb999 API ===
function randomHex() { return crypto.randomBytes(16).toString('hex'); }
function md5Hex(str) { return crypto.createHash('md5').update(str).digest('hex').toUpperCase().slice(0, 32); }
function signParams(params) {
  const u = { ...params, language: 0 };
  u.random = randomHex();
  const c = JSON.parse(JSON.stringify(u));
  const o = Object.keys(c).filter(k =>
    !(typeof c[k] === 'object' && c[k] !== null && !Array.isArray(c[k])) && !Array.isArray(c[k]));
  o.sort();
  const i = {};
  o.forEach(k => { if (c[k] !== null && c[k] !== "" && c[k] !== undefined) i[k] = c[k] === 0 ? 0 : c[k]; });
  u.signature = md5Hex(JSON.stringify(i));
  u.timestamp = Math.floor(Date.now() / 1e3);
  return u;
}

function httpsReq(hostname, path, method = 'GET', body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const h = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7',
      Referer: 'https://fb999.com/',
      Origin: 'https://fb999.com',
      'ar-origin': 'https://fb999.com',
      ...headers,
    };
    if (body && !h['Content-Type']) h['Content-Type'] = 'application/json;charset=UTF-8';
    if (body) h['Content-Length'] = Buffer.byteLength(body);
    const req = https.request({ hostname, path, method, headers: h }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.setTimeout(10000);
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function postApi(path, params, token = FB999_JWT) {
  const body = JSON.stringify(signParams(params));
  try {
    const res = await httpsReq('fb999api.com', path, 'POST', body, { Authorization: `Bearer ${token}` });
    if (res.status === 200) {
      try { return JSON.parse(res.body); } catch(e) { return { _raw: res.body }; }
    }
    return { _status: res.status, _raw: res.body };
  } catch(e) { return { _error: e.message }; }
}

function parseServerTime(str) {
  if (!str) return NaN;
  return new Date(str.replace(' ', 'T')).getTime();
}

function pad(n) { return n.toString().padStart(2, '0'); }

// === Main ===
(async () => {
  const start = Date.now();
  const deadline = start + runSecs * 1000;
  const results = [];

  console.log('='.repeat(80));
  console.log('COMPREHENSIVE TIMING ANALYSIS — WinGo_30S Result Publication Pipeline');
  console.log('='.repeat(80));
  console.log(`Run duration: ${runSecs}s`);
  console.log(`Start (UTC): ${new Date(start).toISOString()}`);
  console.log(`FB999 JWT: ${FB999_JWT ? FB999_JWT.substring(0, 30) + '...' : '(MISSING)'}`);
  console.log(`Cognito Token: ${ACCESS_TOKEN ? ACCESS_TOKEN.substring(0, 30) + '...' : '(MISSING)'}`);
  console.log();

  // Initial: get draw server config for timing reference
  const cfgRes = await httpsReq('draw.ar-lottery06.com', '/WinGo/WinGo_30S.json', 'GET');
  let drawConfig;
  if (cfgRes.status === 200) {
    drawConfig = JSON.parse(cfgRes.body);
    const drawEndTime = new Date(drawConfig.current.endTime).getTime();
    const drawMsToClose = drawEndTime - Date.now();
    console.log('[Draw Server Config]');
    console.log(`  Current issue: ${drawConfig.current.issueNumber}`);
    console.log(`  Close time (UTC): ${new Date(drawEndTime).toISOString()}`);
    console.log(`  msToClose (draw server time): ${drawMsToClose}ms`);
  }

  // Initial: get API game issue for timing reference (with calibration)
  const gi = await postApi('/api/webapi/GetGameIssue', { TypeId: 30 });
  let serverNow, currentEnd, offset, currentIssue;
  if (gi.code === 0 && gi.data) {
    serverNow = parseServerTime(gi.serviceNowTime || gi.data.serviceTime);
    currentEnd = parseServerTime(gi.data.endTime);
    offset = serverNow - Date.now();
    currentIssue = gi.data.issueNumber;
    console.log('\n[FB999 API Game Issue]');
    console.log(`  Current issue: ${currentIssue}`);
    console.log(`  endTime: ${gi.data.endTime}`);
    console.log(`  serviceNowTime: ${gi.serviceNowTime || gi.data.serviceTime}`);
    console.log(`  Offset (server - container): ${offset}ms (~${Math.round(offset/60000)} min)`);
    console.log(`  msToClose (server): ${currentEnd - serverNow}ms`);
  }
  console.log();

  // Trackers
  let lastFiveLatest = '';
  let drawHistoryLatest = '';
  let gameIssueCurrent = currentIssue;
  let wtResults = new Set();
  const events = [];
  let prevRoundIssue = null;
  let roundFlipDetected = false;

  const POLL_MS = 150;
  let iter = 0;

  console.log('--- Polling Phase: all endpoints at ' + POLL_MS + 'ms interval ---\n');

  while (Date.now() < deadline) {
    iter++;
    const containerNow = Date.now();
    const serverNowTime = containerNow + offset;

    // Refresh game issue (calibrates clock, detects round flips)
    const gi2 = await postApi('/api/webapi/GetGameIssue', { TypeId: 30 });
    if (gi2.code === 0 && gi2.data) {
      const newIssue = gi2.data.issueNumber;
      const newEnd = parseServerTime(gi2.data.endTime);
      const newServerNow = parseServerTime(gi2.serviceNowTime || gi2.data.serviceTime);
      offset = newServerNow - containerNow;
      const msToClose = newEnd - (containerNow + offset);

      if (newIssue !== gameIssueCurrent) {
        const ev = {
          iter,
          ts: new Date(containerNow).toISOString(),
          serverTs: new Date(containerNow + offset).toISOString(),
          endpoint: 'GetGameIssue',
          event: 'ROUND_FLIP',
          prevIssue: gameIssueCurrent,
          newIssue: newIssue,
          prevEnd: new Date(newEnd - 30000).toISOString(),
          newEnd: new Date(newEnd).toISOString(),
          msRelativeToClose: msToClose,
        };
        events.push(ev);
        console.log(`[${new Date(containerNow).toISOString()}][iter ${iter}] *** GetGameIssue ROUND FLIP ***`);
        console.log(`  ${gameIssueCurrent} → ${newIssue}`);
        console.log(`  New close time (server UTC): ${new Date(newEnd).toISOString()}`);
        console.log(`  ms from close: ${msToClose}`);
        gameIssueCurrent = newIssue;
        prevRoundIssue = ev.prevIssue;
        currentEnd = newEnd;
      }
      currentEnd = newEnd;
    }

    // Poll GetLastFiveIssueNumberResult (API)
    const lfRes = await postApi('/api/webapi/GetLastFiveIssueNumberResult', { TypeId: 30 });
    if (lfRes.code === 0 && lfRes.data && lfRes.data.number) {
      const latest = lfRes.data.number.split(',')[0];
      if (latest !== lastFiveLatest && latest !== '') {
        lastFiveLatest = latest;
        const msToClose = currentEnd - (containerNow + offset);
        const closedRoundEnd = (containerNow + offset) >= currentEnd ? currentEnd : currentEnd - 30000;
        const msFromClosedEnd = (containerNow + offset) - closedRoundEnd;
        const ev = {
          iter,
          ts: new Date(containerNow).toISOString(),
          serverTs: new Date(containerNow + offset).toISOString(),
          endpoint: 'GetLastFiveIssueNumberResult',
          event: 'NEW_RESULT',
          number: latest,
          allFive: lfRes.data.number,
          serviceNowTime: lfRes.serviceNowTime,
          currentIssue: gameIssueCurrent,
          msToCloseCurrent: msToClose,
          msFromPreviousClose: msFromClosedEnd,
        };
        events.push(ev);
        const msFromCloseStr = msToClose > 0 ? `${msToClose}ms BEFORE close` : `${Math.abs(msToClose)}ms AFTER close`;
        console.log(`[${new Date(containerNow).toISOString()}][iter ${iter}] GetLastFive NEW RESULT`);
        console.log(`  number=${latest} (last-5: ${lfRes.data.number})`);
        console.log(`  currentIssue=${gameIssueCurrent}`);
        console.log(`  msToClose(current): ${msToClose}ms → ${msFromCloseStr}`);
        console.log(`  msFromPreviousClose: ${msFromClosedEnd}ms`);
      }
    }

    // Poll draw server GetHistoryIssuePage
    try {
      const histRes = await httpsReq('draw.ar-lottery06.com',
        '/WinGo/WinGo_30S/GetHistoryIssuePage.json?pageNo=1&pageSize=10', 'GET');
      if (histRes.status === 200) {
        const list = JSON.parse(histRes.body).data?.list || [];
        if (list.length > 0) {
          const latest = list[0].issueNumber + ':' + list[0].number;
          if (latest !== drawHistoryLatest && latest !== '') {
            drawHistoryLatest = latest;
            const drawEndTime = new Date(drawConfig?.current?.endTime).getTime();
            if (isNaN(drawEndTime) || Math.abs(drawEndTime - Date.now()) > 60000) {
              // Re-fetch config
              const cfg2 = await httpsReq('draw.ar-lottery06.com', '/WinGo/WinGo_30S.json', 'GET');
              if (cfg2.status === 200) drawConfig = JSON.parse(cfg2.body);
            }
            const nextClose = drawConfig ? new Date(drawConfig.next.endTime).getTime() : Date.now();
            const msFromClose = containerNow - nextClose;
            const ev = {
              iter,
              ts: new Date(containerNow).toISOString(),
              endpoint: 'GetHistoryIssuePage',
              event: 'NEW_RESULT',
              issue: list[0].issueNumber,
              number: list[0].number,
              color: list[0].color,
              msFromClose: msFromClose,
            };
            events.push(ev);
            console.log(`[${new Date(containerNow).toISOString()}][iter ${iter}] GetHistoryIssuePage NEW RESULT`);
            console.log(`  issue=${list[0].issueNumber} number=${list[0].number} color=${list[0].color}`);
            console.log(`  msFromClose(negative=before): ${msFromClose}ms`);
          }
        }
      }
    } catch(e) {
      if (iter % 20 === 0) console.log(`[iter ${iter}] Draw server error: ${e.message}`);
    }

    // Poll GetWinTheLotteryResult for the PREVIOUS (just-closed) issue
    if (prevRoundIssue && !wtResults.has(prevRoundIssue)) {
      const wt = await postApi('/api/webapi/GetWinTheLotteryResult', { TypeId: 30, IssueNumber: prevRoundIssue });
      const msToClose = currentEnd - (containerNow + offset);
      if (wt.code === 0 && wt.data && wt.data.number !== undefined && wt.data.number !== '' && wt.data.number !== null) {
        wtResults.add(prevRoundIssue);
        const ev = {
          iter,
          ts: new Date(containerNow).toISOString(),
          endpoint: 'GetWinTheLotteryResult',
          event: 'RESULT_RETURNED',
          issueNumber: prevRoundIssue,
          number: wt.data.number,
          msToCloseCurrent: msToClose,
          data: wt.data,
        };
        events.push(ev);
        console.log(`[${new Date(containerNow).toISOString()}][iter ${iter}] *** GetWinTheLotteryResult DATA ***`);
        console.log(`  issue=${prevRoundIssue} number=${wt.data.number}`);
        console.log(`  msToClose(current round): ${msToClose}`);
        console.log(`  full data: ${JSON.stringify(wt.data)}`);
      } else if (iter % 15 === 0) {
        console.log(`[iter ${iter}] GetWinTheLotteryResult(${prevRoundIssue}) -> code=${wt.code || wt._status} msg=${wt.msg || ''}`);
      }
    }

    await new Promise(r => setTimeout(r, POLL_MS));
  }

  // === Final Analysis ===
  console.log('\n' + '='.repeat(80));
  console.log('FINAL ANALYSIS — All Raw Timestamps and Millisecond Offsets');
  console.log('='.repeat(80));

  const allEvents = JSON.parse(JSON.stringify(events));

  console.log('\n--- Summary by Endpoint ---');
  const byEp = {};
  for (const e of events) {
    if (!byEp[e.endpoint]) byEp[e.endpoint] = [];
    byEp[e.endpoint].push(e);
  }
  for (const [ep, evs] of Object.entries(byEp)) {
    console.log(`\n${ep} (${evs.length} events):`);
    for (const e of evs) {
      console.log(JSON.stringify(e));
    }
  }

  // Key metrics
  console.log('\n--- Key Timing Metrics ---');

  const lastFiveEvents = events.filter(e => e.endpoint === 'GetLastFiveIssueNumberResult');
  console.log(`\nGetLastFiveIssueNumberResult events: ${lastFiveEvents.length}`);
  for (const e of lastFiveEvents) {
    const ms = e.msToCloseCurrent;
    const rel = ms > 0 ? `${ms}ms BEFORE close` : `${Math.abs(ms)}ms AFTER close`;
    console.log(`  ${e.ts} | number=${e.number} | ${rel}`);
  }

  const drawEvents = events.filter(e => e.endpoint === 'GetHistoryIssuePage');
  console.log(`\nGetHistoryIssuePage (draw server) events: ${drawEvents.length}`);
  for (const e of drawEvents) {
    const rel = e.msFromClose < 0 ? `${Math.abs(e.msFromClose)}ms BEFORE close` : `${e.msFromClose}ms AFTER close`;
    console.log(`  ${e.ts} | issue=${e.issue} number=${e.number} ${e.color} | ${rel}`);
  }

  const flipEvents = events.filter(e => e.endpoint === 'GetGameIssue');
  console.log(`\nGetGameIssue round flips: ${flipEvents.length}`);
  for (const e of flipEvents) {
    console.log(`  ${e.ts} | ${e.prevIssue} → ${e.newIssue} | msFromClose: ${e.msRelativeToClose}`);
  }

  const wtEvents = events.filter(e => e.endpoint === 'GetWinTheLotteryResult');
  console.log(`\nGetWinTheLotteryResult events: ${wtEvents.length}`);
  for (const e of wtEvents) {
    console.log(`  ${e.ts} | issue=${e.issueNumber} number=${e.number} | msToClose: ${e.msToCloseCurrent}`);
  }

  // Compute averages
  if (lastFiveEvents.length > 1) {
    // Filter out initial detections (those with msFromPreviousClose > 20000)
    const realLeaks = lastFiveEvents.filter(e => e.msFromPreviousClose < 20000);
    if (realLeaks.length > 0) {
      const avgMs = realLeaks.reduce((s, e) => s + e.msToCloseCurrent, 0) / realLeaks.length;
      console.log(`\nGetLastFive result appearing BEFORE close (avg): ${Math.round(avgMs)}ms before close`);
    }
  }
  if (drawEvents.length > 0) {
    const avgMs = drawEvents.reduce((s, e) => s + e.msFromClose, 0) / drawEvents.length;
    console.log(`GetHistoryIssuePage result before close (avg): ${Math.round(avgMs)}ms`);
  }

  // Save full results
  const output = {
    start: new Date(start).toISOString(),
    end: new Date(Date.now()).toISOString(),
    durationMs: Date.now() - start,
    iterations: iter,
    clockOffsetMs: offset,
    drawServerConfig: drawConfig,
    events: events,
  };

  const outFile = '/tmp/timing_analysis_compressed.json';
  fs.writeFileSync(outFile, JSON.stringify(output, null, 2));
  console.log(`\nFull data saved to ${outFile}`);

})().catch(e => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
