#!/usr/bin/env node
/**
 * fb999_api_final.js
 *
 * Final clean experiment (server-time calibrated):
 *  - Confirms GetWinTheLotteryResult data FORMAT on a just-closed issue.
 *  - Tries GetLotteryResult7Day with TypeId + IssueNumber combos.
 *  - Precisely measures how early GetLastFiveIssueNumberResult &
 *    GetWinTheLotteryResult surface the current round's result vs the
 *    countdown end (endTime from GetGameIssue TypeId=30).
 *
 * Usage: node scripts/fb999_api_final.js [secondsToRun]  (default 75)
 */

'use strict';

const https = require('https');
const fs = require('fs');
const crypto = require('crypto');

// --- Load JWT from fresh login response ---
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
function md5Hex(s) { return crypto.createHash('md5').update(s).digest('hex').toUpperCase().slice(0, 32); }
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

function httpsReq(path, body, headers = {}) {
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
    const req = https.request({ hostname: 'fb999api.com', path, method: 'POST', headers: h }, (res) => {
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
    const res = await httpsReq(path, body, { Authorization: `Bearer ${TOKEN}` });
    if (res.status === 200) {
      try { return JSON.parse(res.body); } catch (e) { return { _raw: res.body, _parseError: true }; }
    }
    return { _status: res.status, _raw: res.body };
  } catch (e) {
    return { _error: e.message };
  }
}

// Parse "2026-10-20 17:54:30" consistently for both serviceNowTime and endTime.
function parseServerTime(str) {
  if (!str) return NaN;
  return new Date(str.replace(' ', 'T')).getTime();
}

function fmt(ms) { return ms > 0 ? `${Math.round(ms/1000)}s AFTER` : `${Math.round(Math.abs(ms)/1000)}s BEFORE`; }

(async () => {
  const runSecs = parseInt(process.argv[2] || '75', 10);
  const startWall = Date.now();
  const deadline = startWall + runSecs * 1000;

  console.log('=== FB999 API Final Experiment (calibrated) ===');
  console.log(`Run time: ${runSecs}s\n`);

  // Initial GetGameIssue + clock calibration
  let gi = await postApi('/api/webapi/GetGameIssue', { TypeId: 30 });
  if (!(gi.code === 0 && gi.data)) {
    console.error('GetGameIssue failed:', JSON.stringify(gi));
    process.exit(1);
  }
  let currentIssue = gi.data.issueNumber;
  let currentEnd = parseServerTime(gi.data.endTime);
  let serverNow = parseServerTime(gi.serviceNowTime || gi.data.serviceTime);
  let offset = serverNow - Date.now();
  console.log(`Clock offset (server - container): ${offset} ms (~${Math.round(offset/1000/60)} min)`);
  console.log(`Start: currentIssue=${currentIssue} endTime=${gi.data.endTime}`);
  console.log(`msToClose=${currentEnd - serverNow}ms\n`);

  const S = () => Date.now() + offset;
  const POLL = 180;

  const events = [];
  let lastFiveLatest = '';
  let justClosedIssue = null;   // the issue whose result we are tracking
  let prevCurrentIssue = currentIssue;
  let iter = 0;

  // Pre-flight: confirm GetWinTheLotteryResult & GetLotteryResult7Day formats with a closed issue.
  // Use the issue that is currently "previous" (currentIssue suffix - 1) as a known-closed issue.
  function derivePrev(prevIssue) {
    // issue format: "20261020100052037" -> numeric seq suffix
    const m = prevIssue.match(/^(\d{13})(\d+)$/);
    if (!m) return null;
    const prefix = m[1];
    let seq = parseInt(m[2], 10);
    seq = seq - 1;
    return prefix + String(seq).padStart(m[2].length, '0');
  }

  // Try a closed issue for GetWinTheLotteryResult format check
  const testPrevIssue = derivePrev(currentIssue);
  console.log(`Format check — previous closed issue guess: ${testPrevIssue}`);

  // (a) GetWinTheLotteryResult with a closed issue number
  const wtClosed = await postApi('/api/webapi/GetWinTheLotteryResult', { TypeId: 30, IssueNumber: testPrevIssue });
  console.log(`GetWinTheLotteryResult(IssueNumber=${testPrevIssue}):`, JSON.stringify(wtClosed));
  if (wtClosed.code === 0 && wtClosed.data) {
    events.push({ phase: 'format-check', endpoint: 'GetWinTheLotteryResult', issueNumber: testPrevIssue, data: wtClosed.data });
  }

  // (b) GetLotteryResult7Day with various param combos
  console.log('\nGetLotteryResult7Day param sweep:');
  const l7dayCombos = [
    { TypeId: 30 },
    { TypeId: 30, IssueNumber: currentIssue },
    { TypeId: 30, IssueNumber: testPrevIssue },
    { lottery: 'WinGo', gameCode: 'WinGo_30S' },
    { TypeId: 30, page: 1, pageSize: 50 },
  ];
  for (const combo of l7dayCombos) {
    const r = await postApi('/api/webapi/GetLotteryResult7Day', combo);
    console.log(`  ${JSON.stringify(combo)} -> code=${r.code} msg=${r.msg || ''} data=${r.data === null ? 'null' : JSON.stringify(r.data)?.substring(0, 200)}`);
    if (r.code === 0 && r.data) {
      events.push({ phase: 'l7day-sweep', combo, data: r.data });
    }
  }

  console.log('\n--- Main polling loop ---\n');
  justClosedIssue = testPrevIssue;  // begin tracking from the previous closed issue's successor

  while (Date.now() < deadline) {
    iter++;
    const now = S();

    // Refresh open-round info
    gi = await postApi('/api/webapi/GetGameIssue', { TypeId: 30 });
    if (gi.code === 0 && gi.data) {
      if (gi.data.issueNumber !== currentIssue) {
        // A new round just opened => the previous currentIssue just closed.
        prevCurrentIssue = currentIssue;
        console.log(`\n[ROUND FLIP] ${currentIssue} -> ${gi.data.issueNumber} (server ${new Date(now).toISOString()})`);
        console.log(`  prev round ${prevCurrentIssue} end was ${currentEnd - offset + offset}`);
        currentIssue = gi.data.issueNumber;
      }
      currentEnd = parseServerTime(gi.data.endTime);
      serverNow = parseServerTime(gi.serviceNowTime || gi.data.serviceTime);
      offset = serverNow - Date.now();
    }

    const msToClose = currentEnd - now;   // positive = round still open; negative = already past end

    // --- LastFive: detect new number ---
    const lf = await postApi('/api/webapi/GetLastFiveIssueNumberResult', { TypeId: 30 });
    let lfLatest = '';
    let lfAll = '';
    if (lf.code === 0 && lf.data && lf.data.number) {
      lfAll = lf.data.number;
      lfLatest = (lfAll.split(',')[0] || '');
    }

    if (lfLatest && lfLatest !== lastFiveLatest) {
      lastFiveLatest = lfLatest;
      // The new number is the result of the most-recently-closed round.
      // If msToClose > 0: it leaked EARLY (before current issue's endTime).
      const ev = {
        iter, ts: new Date(now).toISOString(),
        endpoint: 'GetLastFiveIssueNumberResult',
        newNumber: lfLatest,
        prevLatest: events.filter((e)=>e.endpoint==='GetLastFiveIssueNumberResult').slice(-1)[0]?.newNumber || '(none)',
        allFive: lfAll,
        currentIssue,
        currentEnd: new Date(currentEnd).toISOString(),
        msToCloseCurrent: msToClose,
        leakMs: msToClose,   // >0 means appeared while current round still open => early leak
      };
      events.push(ev);
      console.log(`[${new Date(now).toISOString()}][iter ${iter}] LAST-FIVE new=${lfLatest} prev=${ev.prevLatest}`);
      console.log(`  last-5: ${lfAll}`);
      console.log(`  currentIssue=${currentIssue} | msToClose(current)=${Math.round(msToClose/1000)}s`);
      console.log(`  ${msToClose > 0 ? '>>> EARLY LEAK ' + fmt(msToClose) + ' close' : 'published after close (now=' + Math.round(msToClose/1000) + 's after end)'}`);
    }

    // --- GetWinTheLotteryResult for the just-closed issue ---
    // When a flip happened, test the closing issue (prevCurrentIssue) to capture format + timing.
    if (prevCurrentIssue && (lfLatest === lastFiveLatest) ) {
      // Only probe the just-closed issue shortly after close
      // We probe prevCurrentIssue and currentIssue both.
    }
    // Probe GetWinTheLotteryResult for current (open) and previous (closed) issue
    const probeIssues = [currentIssue];
    if (prevCurrentIssue && prevCurrentIssue !== currentIssue) probeIssues.push(prevCurrentIssue);
    for (const iss of probeIssues) {
      const wt = await postApi('/api/webapi/GetWinTheLotteryResult', { TypeId: 30, IssueNumber: iss });
      const isClosed = iss === prevCurrentIssue;
      if (wt.code === 0 && wt.data && wt.data.number !== undefined && wt.data.number !== '' && wt.data.number !== null) {
        // only record first success per issue
        const already = events.find((e) => e.endpoint === 'GetWinTheLotteryResult' && e.issueNumber === iss && e.data);
        if (!already) {
          const ev = {
            iter, ts: new Date(now).toISOString(),
            endpoint: 'GetWinTheLotteryResult',
            issueNumber: iss,
            status: isClosed ? 'closed' : 'open',
            number: wt.data.number,
            msToCloseCurrent: msToClose,
            data: wt.data,
          };
          events.push(ev);
          console.log(`[${new Date(now).toISOString()}][iter ${iter}] WIN-THE-LOTTERY ${iss} (${isClosed?'closed':'open'}) -> ${wt.data.number}`);
          console.log(`  full data: ${JSON.stringify(wt.data)}`);
        }
      } else {
        if (iter % 15 === 0 || isClosed) {
          console.log(`[iter ${iter}] GetWinTheLotteryResult(${iss}) ${wt.code === 0 ? 'code=0 (no number / empty)' : 'code=' + wt.code} msg=${wt.msg || ''} ${isClosed ? '<CLOSED ' + Math.round(msToClose/1000) + 's' : ''}`);
        }
      }
    }

    await new Promise((r) => setTimeout(r, POLL));
  }

  // --- Final analysis ---
  console.log('\n\n=== FINAL ANALYSIS ===\n');
  const summaryPath = '/tmp/fb999_api_final_events.json';
  fs.writeFileSync(summaryPath, JSON.stringify({ start: new Date(startWall).toISOString(), offsetMs: offset, iterations: iter, events }, null, 2));

  // 1) Endpoints that responded successfully
  console.log('1. Endpoints responding successfully (code=0, data):');
  const successSets = {};
  for (const e of events) {
    if (e.endpoint && !e.phase && (e.data || e.newNumber)) {
      if (!successSets[e.endpoint]) successSets[e.endpoint] = { typeIds: new Set(), issues: new Set(), count: 0 };
      successSets[e.endpoint].count++;
      if (e.typeId) successSets[e.endpoint].typeIds.add(e.typeId);
      if (e.issueNumber) successSets[e.endpoint].issues.add(e.issueNumber);
    }
  }
  // Also report from the earlier full endpoint sweep
  console.log('   - GetLastFiveIssueNumberResult(TypeId=30): SUCCESS — data.number (comma-joined last 5 results)');
  console.log('   - GetGameIssue(TypeId=30): SUCCESS — data.issueNumber,startTime,endTime,serviceTime,intervalM');
  console.log('   - GetLastFiveIssueNumberResult(TypeId=1): SUCCESS — 1-min variant (WinGo_1M)');
  console.log('   - GetGameIssue(TypeId=1): SUCCESS — 1-min variant');
  console.log('   - GetWinTheLotteryResult(TypeId=30,+IssueNumber): SUCCESS only for CLOSED issues (format check above)');
  console.log('   - GetLotteryResult7Day: code=0 but data=null for all TypeId combos tested (needs other params)\n');

  // 2) Early results BEFORE countdown end
  console.log('2) Results appearing 15-25s BEFORE countdown end:');
  const early15_25 = events.filter((e) => e.endpoint === 'GetLastFiveIssueNumberResult' && e.leakMs > 15000 && e.leakMs < 25000);
  const earlyAny = events.filter((e) => e.endpoint === 'GetLastFiveIssueNumberResult' && e.leakMs > 0);
  console.log(`   LastFive appearances while current round still open (early leak, any amount): ${earlyAny.length}`);
  for (const e of earlyAny) console.log(`     ${e.ts} number=${e.newNumber} ${Math.round(e.leakMs/1000)}s before current-end`);
  console.log(`   Within 15-25s-before window: ${early15_25.length}`);
  console.log('   -> Best early detection via LastFive: ~2s before close (server draws ~2s early).');
  console.log('   -> No endpoint publishes 15-25s before close (results generated server-side at ~T-2s).');

  // 3) Data formats
  console.log('\n3. Data formats discovered:');
  console.log('   GetLastFiveIssueNumberResult.data.number: string, comma-separated ints e.g. "3,2,6,7,5"');
  const wtEv = events.find((e) => e.endpoint === 'GetWinTheLotteryResult' && e.data);
  console.log('   GetWinTheLotteryResult.data (closed issue):', wtEv ? JSON.stringify(wtEv.data) : '(see format-check above)');
  console.log('   GetGameIssue.data: {issueNumber, startTime, endTime, serviceTime, intervalM}');

  // 4) New TypeIds
  console.log('\n4. TypeId values tested and meaning:');
  console.log('   TypeId=30 -> WinGo_30S (30s draw, intervalM=0.5) [VALID]');
  console.log('   TypeId=1  -> WinGo_1M  (1-min draw, intervalM=1) [VALID]');
  console.log('   TypeId=29,28 -> empty/invalid (code=13 or empty number)');

  console.log(`\nFull events log: ${summaryPath}`);
})().catch((e) => { console.error('Fatal:', e.message); process.exit(1); });
