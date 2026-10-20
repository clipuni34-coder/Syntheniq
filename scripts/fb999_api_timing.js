#!/usr/bin/env node
/**
 * fb999_api_timing.js
 *
 * Timed experiment: poll the authenticated result endpoints in a tight loop
 * and record EXACTLY when each new result number first appears, relative to
 * the WinGo_30S countdown end (endTime from GetGameIssue TypeId=30).
 *
 * Goal: determine whether any endpoint publishes a result 15-25s BEFORE
 * the 30s countdown ends, and the earliest one.
 *
 * Usage: node scripts/fb999_api_timing.js [secondsToRun]  (default 40)
 */

'use strict';

const https = require('https');
const fs = require('fs');
const crypto = require('crypto');

// --- Load JWT ---
let TOKEN;
try {
  const login = JSON.parse(fs.readFileSync('/tmp/fb999_login_response.json', 'utf8'));
  TOKEN = login.data && login.data.token;
} catch (e) {
  console.error('Cannot read /tmp/fb999_login_response.json:', e.message);
  process.exit(1);
}
if (!TOKEN) {
  console.error('No token');
  process.exit(1);
}

// --- Signing (same proven signParams) ---
function randomHex() { return crypto.randomBytes(16).toString('hex'); }
function md5Hex(str) { return crypto.createHash('md5').update(str).digest('hex').toUpperCase().slice(0, 32); }
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

function httpsReq(hostname, path, method = 'POST', body = null, headers = {}) {
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
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.setTimeout(10000);
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function postApi(path, params) {
  const body = JSON.stringify(signParams(params));
  try {
    const res = await httpsReq('fb999api.com', path, 'POST', body, { Authorization: `Bearer ${TOKEN}` });
    if (res.status === 200) {
      try { return JSON.parse(res.body); } catch (e) { return { _raw: res.body }; }
    }
    return { _status: res.status, _raw: res.body };
  } catch (e) {
    return { _error: e.message };
  }
}

async function getGameIssue30() {
  const j = await postApi('/api/webapi/GetGameIssue', { TypeId: 30 });
  if (j.code === 0 && j.data) return j.data;
  return null;
}

function msToClose(data) {
  return new Date(data.endTime).getTime() - Date.now();
}

function fmtMs(ms) {
  if (ms > 0) return '+' + Math.round(ms / 1000) + 's';
  return Math.round(ms / 1000) + 's';
}

// --- Main experiment ---
(async () => {
  const runSecs = parseInt(process.argv[2] || '40', 10);
  const start = Date.now();
  const deadline = start + runSecs * 1000;

  console.log('=== FB999 API Timing Experiment ===');
  console.log(`Mode: authenticated (JWT Bearer). Polling result endpoints.`);
  console.log(`Run time: ${runSecs}s\n`);

  // Get current round info
  let issueInfo = await getGameIssue30();
  if (!issueInfo) {
    console.error('Could not fetch initial GetGameIssue(TypeId=30). Aborting.');
    console.log('Response was:', JSON.stringify(issueInfo));
    process.exit(1);
  }
  console.log('Initial round:', issueInfo);
  console.log('  issueNumber:', issueInfo.issueNumber);
  console.log('  endTime:', issueInfo.endTime);
  console.log('  msToClose:', msToClose(issueInfo));
  console.log();

  // Trackers
  const lastFiveSeen = new Set();     // numbers seen in GetLastFiveIssueNumberResult
  let lastFiveLatest = '';            // most recent number string seen
  const lotteryResultSeen = new Set(); // issueNumbers seen in GetWinTheLotteryResult
  const events = [];

  const currentIssue = issueInfo.issueNumber;
  const currentEnd = new Date(issueInfo.endTime).getTime();

  // Poll GetWinTheLotteryResult for the CURRENT (in-progress) issue
  // and for the last-5 to detect new numbers.
  const pollInterval = 200; // ms — fast but controlled load
  let iter = 0;

  console.log(`Polling every ${pollInterval}ms. Current issue: ${currentIssue} (closes in ${Math.round(msToClose(issueInfo) / 1000)}s)\n`);

  while (Date.now() < deadline) {
    iter++;
    const now = Date.now();

    // --- A) GetWinTheLotteryResult for the CURRENT (open) issue ---
    // This is the key test: does it return the result before endTime?
    const wtRes = await postApi('/api/webapi/GetWinTheLotteryResult', { TypeId: 30, IssueNumber: currentIssue });
    const wtStatus = wtRes.code !== undefined ? `code=${wtRes.code}` : (wtRes._error ? 'ERR:' + wtRes._error : 'STATUS:' + wtRes._status);
    const hasResult = wtRes.data && wtRes.data.number !== undefined && wtRes.data.number !== '' && wtRes.data.number !== null;

    if (hasResult) {
      const before = now - currentEnd;
      if (!lotteryResultSeen.has(currentIssue)) {
        lotteryResultSeen.add(currentIssue);
        const when = `${before > 0 ? '+' : ''}${before}ms (${Math.round(before / 1000)}s) ${before > 0 ? 'AFTER' : 'BEFORE'} countdown end`;
        const ev = {
          ts: new Date(now).toISOString(),
          iter,
          endpoint: 'GetWinTheLotteryResult',
          issueNumber: currentIssue,
          number: wtRes.data.number,
          msFromClose: before,
          when,
          data: wtRes.data,
        };
        events.push(ev);
        console.log(`[${new Date(now).toISOString()}][iter ${iter}] GetWinTheLotteryResult CURRENT ISSUE ${currentIssue}`);
        console.log(`  → result number=${wtRes.data.number} | ${when}`);
        console.log(`  full data: ${JSON.stringify(wtRes.data)}`);
      }
    } else {
      // log only occasionally to avoid spam
      if (iter % 5 === 0) {
        console.log(`[iter ${iter}] GetWinTheLotteryResult(${currentIssue}) -> ${wtStatus}, no result yet | ${-Math.round((currentEnd - now) / 1000)}s to close`);
      }
    }

    // --- B) GetLastFiveIssueNumberResult (TypeId=30) — detect new number appended ---
    const lfRes = await postApi('/api/webapi/GetLastFiveIssueNumberResult', { TypeId: 30 });
    if (lfRes.code === 0 && lfRes.data && lfRes.data.number) {
      const nums = lfRes.data.number.split(',');
      const latest = nums[0]; // most recent result is first
      if (latest !== lastFiveLatest && latest !== '') {
        const prevLatest = lastFiveLatest;
        lastFiveLatest = latest;
        const msFromClose = now - currentEnd;
        const when = `${msFromClose > 0 ? '+' : ''}${msFromClose}ms (${Math.round(msFromClose / 1000)}s) ${msFromClose > 0 ? 'AFTER' : 'BEFORE'} countdown end`;
        const ev = {
          ts: new Date(now).toISOString(),
          iter,
          endpoint: 'GetLastFiveIssueNumberResult',
          number: latest,
          allFive: lfRes.data.number,
          msFromClose,
          when,
          data: lfRes.data,
        };
        events.push(ev);
        console.log(`[${new Date(now).toISOString()}][iter ${iter}] GetLastFiveIssueNumberResult NEW number detected`);
        console.log(`  → latest=${latest} (prev=${prevLatest || '(none)'}) | ${when}`);
        console.log(`  full: ${lfRes.data.number}`);
      } else {
        console.log(`[iter ${iter}] GetLastFive -> latest=${latest || '(pending)'} | ${-Math.round((currentEnd - now) / 1000)}s to close`);
      }
    }

    // Sleep
    await new Promise((r) => setTimeout(r, pollInterval));
  }

  // --- Report ---
  console.log('\n\n=== TIMING ANALYSIS ===\n');
  console.log('Events where a result was detected relative to countdown end:');
  if (events.length === 0) {
    console.log('  No new results detected during the run.');
  } else {
    // Group by endpoint
    const byEp = {};
    for (const e of events) {
      if (!byEp[e.endpoint]) byEp[e.endpoint] = [];
      byEp[e.endpoint].push(e);
    }
    for (const [ep, evs] of Object.entries(byEp)) {
      console.log(`\n${ep}:`);
      for (const e of evs) {
        console.log(`  ${e.when} | number=${e.number} | ts=${e.ts}`);
      }
      const earliest = evs.reduce((a, b) => (a.msFromClose < b.msFromClose ? a : b));
      const earliestDesc = earliest.msFromClose < 0
        ? `${Math.round(Math.abs(earliest.msFromClose) / 1000)}s BEFORE countdown end`
        : `${Math.round(earliest.msFromClose / 1000)}s AFTER countdown end`;
      console.log(`  → Earliest detection: ${earliestDesc}`);
    }
  }

  fs.writeFileSync(
    '/tmp/fb999_timing_events.json',
    JSON.stringify(
      {
        start: new Date(start).toISOString(),
        currentIssue,
        currentEnd: new Date(currentEnd).toISOString(),
        pollIntervalMs: pollInterval,
        iterations: iter,
        events,
      },
      null,
      2
    )
  );
  console.log('\nEvents saved to /tmp/fb999_timing_events.json');
})().catch((e) => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
