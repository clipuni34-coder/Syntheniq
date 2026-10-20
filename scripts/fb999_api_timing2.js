#!/usr/bin/env node
/**
 * fb999_api_timing2.js
 *
 * Timed experiment with CORRECT server-time calibration.
 *
 * The FB999 server `serviceNowTime` runs ~1h ahead of the container clock.
 * Fix: treat the server's own `serviceNowTime` (returned in every response)
 * as "now", and parse `endTime` with the SAME function so deltas are correct.
 *
 * For each iteration we refresh the open round via GetGameIssue(TypeId=30),
 * then poll GetLastFiveIssueNumberResult(TypeId=30) and
 * GetWinTheLotteryResult(TypeId=30, IssueNumber=...) to record exactly when
 * a result number first appears relative to the countdown end.
 *
 * Usage: node scripts/fb999_api_timing2.js [secondsToRun]   (default 70)
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
if (!TOKEN) { console.error('No token'); process.exit(1); }

// --- Signing (proven signParams) ---
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

function httpsReq(hostname, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const h = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7',
      Referer: 'https://fb999.com/',
      Origin: 'https://fb999.com',
      'ar-origin': 'https://fb999.com',
      'Content-Type': 'application/json;charset=UTF-8',
      ...headers,
    };
    h['Content-Length'] = Buffer.byteLength(body);
    const req = https.request({ hostname, path, method: 'POST', headers: h }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.setTimeout(12000);
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function postApi(path, params) {
  const body = JSON.stringify(signParams(params));
  try {
    const res = await httpsReq('fb999api.com', path, body, { Authorization: `Bearer ${TOKEN}` });
    if (res.status === 200) {
      try { return JSON.parse(res.body); } catch (e) { return { _raw: res.body, _parseError: true }; }
    }
    return { _status: res.status, _raw: res.body };
  } catch (e) {
    return { _error: e.message };
  }
}

// Parse "2026-10-20 17:54:30" -> epoch using the SAME function for both
// serviceNowTime and endTime, so inter-server-time deltas are correct.
function parseServerTime(str) {
  if (!str) return NaN;
  // Replace space with 'T' so new Date parses in ISO-like form in container local TZ.
  return new Date(str.replace(' ', 'T')).getTime();
}

function fmtDelta(ms) {
  const s = Math.round(ms / 1000);
  return ms > 0 ? `${s}s AFTER close (latency)` : `${Math.abs(s)}s BEFORE close (early!)`;
}

// --- Main experiment ---
(async () => {
  const runSecs = parseInt(process.argv[2] || '70', 10);
  const startWall = Date.now();
  const deadline = startWall + runSecs * 1000;

  console.log('=== FB999 API Timing Experiment v2 (server-time calibrated) ===');
  console.log(`Run time: ${runSecs}s\n`);

  // Initial round + clock calibration
  let gi = await postApi('/api/webapi/GetGameIssue', { TypeId: 30 });
  if (!(gi.code === 0 && gi.data)) {
    console.error('Cannot fetch GetGameIssue. Response:', JSON.stringify(gi));
    process.exit(1);
  }
  let currentIssue = gi.data.issueNumber;
  let currentEnd = parseServerTime(gi.data.endTime);          // server wall-clock epoch (UTC+1)
  // serviceNowTime is a top-level field; data.serviceTime is the per-data copy
  let serverNow = parseServerTime(gi.serviceNowTime || gi.data.serviceTime);  // server "now"
  let offset = serverNow - Date.now();                        // fixed tz/clock drift
  console.log('Clock calibration:');
  console.log('  container now:', new Date(startWall).toISOString());
  console.log('  serverNow (from serviceNowTime):', gi.serviceNowTime || gi.data.serviceTime);
  console.log('  offset (container vs server):', offset, 'ms');
  console.log('  current issue:', currentIssue, ' endTime:', gi.data.endTime);
  console.log('  msToClose (server):', currentEnd - serverNow);
  console.log();

  const S = () => Date.now() + offset;        // server-consistent "now"
  const events = [];
  let lastFiveLatest = '';
  let prevCurrentIssue = currentIssue;
  let iter = 0;

  const POLL_MS = 180;
  console.log(`Polling every ${POLL_MS}ms...\n`);

  while (Date.now() < deadline) {
    iter++;
    // 1) Refresh open-round info each iteration (also recalibrates clock)
    gi = await postApi('/api/webapi/GetGameIssue', { TypeId: 30 });
    if (gi.code === 0 && gi.data) {
      currentIssue = gi.data.issueNumber;
      currentEnd = parseServerTime(gi.data.endTime);
      serverNow = parseServerTime(gi.serviceNowTime || gi.data.serviceTime);
      offset = serverNow - Date.now();      // recalibrate drift each iter
    }

    // 2) GetLastFiveIssueNumberResult(TypeId=30)
    const lf = await postApi('/api/webapi/GetLastFiveIssueNumberResult', { TypeId: 30 });
    let lfLatest = '';
    let lfAll = '';
    if (lf.code === 0 && lf.data && lf.data.number) {
      lfAll = lf.data.number;
      const nums = lfAll.split(',');
      lfLatest = nums[0] || '';
    }

    const now = S();
    const msToClose = currentEnd - now;

    if (lfLatest !== '' && lfLatest !== lastFiveLatest) {
      const prev = lastFiveLatest || '(none)';
      lastFiveLatest = lfLatest;
      // The just-appeared number belongs to the most-recently-closed round.
      // If currentEnd is still in the future (round still open), the number
      // leaked from the PREVIOUSLY-closed round whose end = currentEnd (just flipped) —
      // but simplest: compare to the most recent past currentEnd.
      const closedRoundEnd = now >= currentEnd ? currentEnd : (currentEnd - 30000);
      const msFromClosedEnd = now - closedRoundEnd;
      const ev = {
        iter, ts: new Date(now).toISOString(),
        endpoint: 'GetLastFiveIssueNumberResult',
        newNumber: lfLatest, prevLatest: prev,
        allFive: lfAll,
        currentIssue, currentEnd: new Date(currentEnd).toISOString(),
        msToCloseCurrent: msToClose,
        msFromClosedRoundEnd: msFromClosedEnd,
        note: msFromClosedEnd < 0 ? 'LEAKED BEFORE close' : 'published after close',
      };
      events.push(ev);
      console.log(`[${new Date(now).toISOString()}][iter ${iter}] LAST-FIVE NEW number: ${lfLatest} (was ${prev})`);
      console.log(`  full last-5: ${lfAll}`);
      console.log(`  currentIssue=${currentIssue} currentEnd=${new Date(currentEnd).toISOString()}`);
      console.log(`  msToClose(current round)=${Math.round(msToClose/1000)}s | msFromClosedEnd=${Math.round(msFromClosedEnd/1000)}s → ${fmtDelta(msFromClosedEnd)}`);
    } else {
      if (iter % 10 === 0) {
        console.log(`[iter ${iter}] LastFive latest=${lfLatest || '(empty)'} | ${Math.round(msToClose/1000)}s to close | current=${currentIssue}`);
      }
    }

    // 3) GetWinTheLotteryResult for the current OPEN issue (early leak test) and previous closed issue
    const candidates = [currentIssue];
    // also try the previous issue (decrement last digit) to confirm endpoint returns a real result
    if (prevCurrentIssue !== currentIssue) {
      candidates.push(prevCurrentIssue);
    }
    prevCurrentIssue = currentIssue;

    for (const issueNum of candidates) {
      const wt = await postApi('/api/webapi/GetWinTheLotteryResult', { TypeId: 30, IssueNumber: issueNum });
      const wtStatus = wt.code !== undefined ? `code=${wt.code}` : (wt._error ? 'ERR:' + wt._error : 'STATUS:' + wt._status);
      const hasResult = wt.code === 0 && wt.data && wt.data.number !== undefined && wt.data.number !== '' && wt.data.number !== null;
      const isEmpty = wt.code === 0 && wt.data && (wt.data.number === '' || wt.data.number === null);

      if (hasResult) {
        const key = 'wt_' + issueNum;
        if (!events.some((e) => e._wtkey === key)) {
          const ev = {
            iter, ts: new Date(now).toISOString(),
            endpoint: 'GetWinTheLotteryResult',
            issueNumber: issueNum,
            number: wt.data.number,
            msToCloseCurrent: msToClose,
            msFromClosedEnd: now - (now >= currentEnd ? currentEnd : currentEnd - 30000),
            data: wt.data,
            _wtkey: key,
          };
          events.push(ev);
          console.log(`[${new Date(now).toISOString()}][iter ${iter}] WIN-THE-LOTTERY RESULT for ${issueNum}: ${wt.data.number}`);
          console.log(`  full data: ${JSON.stringify(wt.data)}`);
          console.log(`  msToClose(current round)=${Math.round(msToClose/1000)}s`);
        }
      } else if (!isEmpty && wt.code !== 0) {
        // Non-success codes: print occasional
        if (iter % 8 === 0) {
          console.log(`[iter ${iter}] GetWinTheLotteryResult(${issueNum}) -> ${wtStatus} msg=${wt.msg || wt._raw || ''}`);
        }
      }
    }

    await new Promise((r) => setTimeout(r, POLL_MS));
  }

  // --- Analysis ---
  console.log('\n\n=== ANALYSIS ===\n');
  console.log('Total iterations:', iter);
  console.log('Events captured:', events.length);

  // Group: LastFive new-number events
  const lfEvents = events.filter((e) => e.endpoint === 'GetLastFiveIssueNumberResult');
  const wtEvents = events.filter((e) => e.endpoint === 'GetWinTheLotteryResult');

  console.log('\n--- GetLastFiveIssueNumberResult: new-number appearances ---');
  for (const e of lfEvents) {
    console.log(`  ${e.ts} | number=${e.newNumber} (was ${e.prevLatest}) | ${Math.round(e.msFromClosedRoundEnd / 1000)}s rel closed-round-end | ${e.note}`);
  }
  if (lfEvents.length) {
    const earliest = lfEvents.reduce((a, b) => (a.msFromClosedRoundEnd < b.msFromClosedRoundEnd ? a : b));
    console.log(`  → Earliest LastFive result: ${Math.round(earliest.msFromClosedRoundEnd / 1000)}s relative to closed round end`);
  } else {
    console.log('  (no new numbers detected)');
  }

  console.log('\n--- GetWinTheLotteryResult: per-issue results ---');
  for (const e of wtEvents) {
    console.log(`  ${e.ts} | issue=${e.issueNumber} | number=${e.number} | ${Math.round(e.msToCloseCurrent / 1000)}s to current close`);
  }
  if (wtEvents.length === 0) {
    console.log('  (GetWinTheLotteryResult returned no valid result during the run)');
  }

  // The headline metric the user asked for: results 15-25s BEFORE countdown ends.
  // "before countdown ends" = msToCloseCurrent strongly positive while a FUTURE result is already known.
  const earlyLf = lfEvents.filter((e) => e.msToCloseCurrent > 15000 && e.msToCloseCurrent < 25000);
  const earlyWt = wtEvents.filter((e) => e.msToCloseCurrent > 15000 && e.msToCloseCurrent < 25000);
  console.log('\n--- Endpoint(s) publishing 15-25s before countdown end ---');
  console.log('  GetLastFiveIssueNumberResult early (15-25s before):', earlyLf.length);
  console.log('  GetWinTheLotteryResult early (15-25s before):', earlyWt.length);

  fs.writeFileSync('/tmp/fb999_timing_v2_events.json', JSON.stringify({
    start: new Date(startWall).toISOString(),
    offsetMs: offset,
    iterations: iter,
    events,
  }, null, 2));
  console.log('\nEvents saved to /tmp/fb999_timing_v2_events.json');
})().catch((e) => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
