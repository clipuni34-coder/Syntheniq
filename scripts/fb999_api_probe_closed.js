#!/usr/bin/env node
/**
 * fb999_api_probe_closed.js
 *
 * Fetch a REAL closed issue number from the draw server, then probe
 * GetWinTheLotteryResult and GetLotteryResult7Day with correct params to
 * confirm whether these endpoints ever return a result (and its format),
 * including a pre-close timing check.
 */

'use strict';

const https = require('https');
const fs = require('fs');
const crypto = require('crypto');

let TOKEN;
try {
  const login = JSON.parse(fs.readFileSync('/tmp/fb999_login_response.json', 'utf8'));
  TOKEN = login.data && login.data.token;
} catch (e) { console.error(e.message); process.exit(1); }
if (!TOKEN) { console.error('No token'); process.exit(1); }

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

function httpsReq(hostname, path, method = 'GET', body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const h = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: 'application/json, text/plain, */*',
      ...headers,
    };
    if (body) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(body); }
    const req = https.request({ hostname, path, method, headers: h }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.setTimeout(12000);
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
  } catch (e) { return { _error: e.message }; }
}

function parseServerTime(str) { return str ? new Date(str.replace(' ', 'T')).getTime() : NaN; }

(async () => {
  // 1) Fetch real closed issue numbers from the draw server
  console.log('=== Fetching real WinGo_30S history from draw server ===');
  const hist = await httpsReq('draw.ar-lottery06.com', '/WinGo/WinGo_30S/GetHistoryIssuePage.json?pageNo=1&pageSize=12', 'GET');
  let realIssues = [];
  let realNumbers = [];
  if (hist.status === 200) {
    const j = JSON.parse(hist.body);
    const list = j.data?.list || [];
    realIssues = list.map((x) => x.issueNumber);
    realNumbers = list.map((x) => x.number);
    console.log('Real closed issues (most recent first):', realIssues);
    console.log('Real numbers (most recent first):', realNumbers);
  } else {
    console.log('Draw server fetch failed:', hist.status, hist.body?.substring(0, 200));
  }

  // 2) Fetch current game issue (open)
  const gi = await postApi('/api/webapi/GetGameIssue', { TypeId: 30 });
  console.log('\nGetGameIssue(TypeId=30):', JSON.stringify(gi));
  let currentIssue = gi.data?.issueNumber || '';
  let currentEnd = gi.data ? parseServerTime(gi.data.endTime) : NaN;
  let serverNow = parseServerTime(gi.serviceNowTime || gi.data.serviceTime);
  const offset = serverNow - Date.now();
  console.log('currentIssue:', currentIssue, ' endTime:', gi.data.endTime, ' msToClose:', currentEnd - serverNow);

  const closedIssues = realIssues.length ? realIssues : [String(Number(currentIssue) - 1)];

  // 3) GetWinTheLotteryResult variations
  console.log('\n=== GetWinTheLotteryResult variations ===');
  const wtTests = [];
  for (const iss of closedIssues.slice(0, 4)) {
    wtTests.push({ label: `TypeId=30,IssueNumber=${iss}`, params: { TypeId: 30, IssueNumber: iss } });
  }
  wtTests.push({ label: 'TypeId=1,IssueNumber=<closed>', params: { TypeId: 1, IssueNumber: closedIssues[0] } });
  wtTests.push({ label: 'no TypeId, IssueNumber only', params: { IssueNumber: closedIssues[0] } });
  wtTests.push({ label: 'IssueNumber=last5digits only', params: { TypeId: 30, IssueNumber: String(Number(closedIssues[0]) % 100000) } });

  for (const t of wtTests) {
    const r = await postApi('/api/webapi/GetWinTheLotteryResult', t.params);
    console.log(`  ${t.label} ->`, JSON.stringify(r).substring(0, 300));
  }

  // 4) GetLotteryResult7Day variations
  console.log('\n=== GetLotteryResult7Day variations ===');
  const l7Tests = [
    { TypeId: 30 },
    { TypeId: 30, IssueNumber: closedIssues[0] },
    { TypeId: 1, IssueNumber: closedIssues[0] },
    { lottery: 'WinGo', gameCode: 'WinGo_30S' },
    { lottery: 'WinGo', gameCode: 'WinGo_30S', TypeId: 30 },
    { TypeId: 30, page: 1, pageSize: 20 },
  ];
  for (const t of l7Tests) {
    const r = await postApi('/api/webapi/GetLotteryResult7Day', t);
    console.log(`  ${JSON.stringify(t)} -> code=${r.code} msg=${r.msg || ''} data=${r.data === null ? 'null' : JSON.stringify(r.data)?.substring(0, 200)}`);
  }

  // 5) Tight pre-close timing: poll GetLastFive + GetWinTheLottery(currentIssue)
  console.log('\n=== Pre-close timing (polling 30s around currentEnd) ===');
  console.log(`currentIssue=${currentIssue} currentEnd=${new Date(currentEnd).toISOString()} (server)`);
  const end = Date.now() + 40000;
  let lfLatest = '';
  let wtGot = false;
  const S = () => Date.now() + offset;

  while (Date.now() < end) {
    const now = S();
    const msToClose = currentEnd - now;

    // refresh current issue + end (round may flip)
    const gi2 = await postApi('/api/webapi/GetGameIssue', { TypeId: 30 });
    if (gi2.code === 0 && gi2.data) {
      if (gi2.data.issueNumber !== currentIssue) {
        console.log(`[FLIP] ${currentIssue}->${gi2.data.issueNumber} at ${Math.round(msToClose)}s-to-close of old`);
        currentIssue = gi2.data.issueNumber;
      }
      currentEnd = parseServerTime(gi2.data.endTime);
      serverNow = parseServerTime(gi2.serviceNowTime || gi2.data.serviceTime);
      // offset drifts; use serverNow directly instead
    }

    // LastFive
    const lf = await postApi('/api/webapi/GetLastFiveIssueNumberResult', { TypeId: 30 });
    let lfLatestNow = '';
    if (lf.code === 0 && lf.data && lf.data.number) {
      lfLatestNow = lf.data.number.split(',')[0] || '';
      if (lfLatestNow && lfLatestNow !== lfLatest) {
        lfLatest = lfLatestNow;
        console.log(`[LastFive] NEW=${lfLatestNow} | ${Math.round(msToClose)}s-to-close | last5=${lf.data.number}`);
      }
    }

    // GetWinTheLotteryResult for current (open) issue — is it early-leaked?
    const wt = await postApi('/api/webapi/GetWinTheLotteryResult', { TypeId: 30, IssueNumber: currentIssue });
    if (!wtGot && wt.code === 0 && wt.data && wt.data.number) {
      wtGot = true;
      console.log(`[WinTheLottery] RESULT for ${currentIssue}: number=${wt.data.number} | ${Math.round(msToClose)}s-to-close | data=${JSON.stringify(wt.data)}`);
    }

    await new Promise((r) => setTimeout(r, 250));
  }

  console.log('\nDone.');
})().catch((e) => { console.error('Fatal:', e.message); process.exit(1); });
