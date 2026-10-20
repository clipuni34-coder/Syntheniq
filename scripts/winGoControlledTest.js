/**
 * CONTROLLED TEST: Verify if API publishes next round's result before countdown
 * 
 * Polling protocol:
 * 1. Get round start/end times from config
 * 2. Start polling API + draw server at round start (T=0)
 * 3. Record EXACT timestamp when next round's result appears in each
 * 4. Verify results match
 */

const https = require('https');
const fs = require('fs');
const crypto = require('crypto');

const tokens = JSON.parse(fs.readFileSync('/tmp/viralclips_tokens.json', 'utf8'));
const ACCESS_TOKEN = tokens.access_token;

function ne() { return crypto.randomBytes(16).toString('hex'); }
function we(str) { return crypto.createHash('md5').update(str).digest('hex').toUpperCase().slice(0, 32); }
function signParams(params) {
  const u = { ...params, language: 0 };
  u.random = ne();
  const c = JSON.parse(JSON.stringify(u));
  const o = Object.keys(c).filter(key =>
    !(typeof c[key] === 'object' && c[key] !== null && !Array.isArray(c[key])) && !Array.isArray(c[key]));
  o.sort();
  const i = {};
  o.forEach(key => { if (c[key] !== null && c[key] !== "" && c[key] !== undefined) i[key] = c[key] === 0 ? 0 : c[key]; });
  u.signature = we(JSON.stringify(i));
  u.timestamp = Math.floor(Date.now() / 1e3);
  return u;
}

function httpRequest(hostname, path, method = 'GET', body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname, path, method,
      headers: { 'Accept': 'application/json', 'Content-Type': 'application/json', ...headers }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function getAPIResults() {
  const res = await httpRequest('fb999api.com', '/api/webapi/GetLastFiveIssueNumberResult', 'POST',
    JSON.stringify(signParams({ TypeId: 30 })), { 'Authorization': `Bearer ${ACCESS_TOKEN}` });
  if (res.status === 200) {
    const json = JSON.parse(res.body);
    if (json.code === 0 && json.data?.number) {
      const nums = typeof json.data.number === 'string' ? json.data.number.split(',') : json.data.number;
      return nums.map(n => ({ number: n }));
    }
  }
  return null;
}

async function getDrawResults() {
  const res = await httpRequest('draw.ar-lottery06.com', '/WinGo/WinGo_30S/GetHistoryIssuePage.json?pageNo=1&pageSize=10');
  if (res.status === 200) {
    const data = JSON.parse(res.body);
    return data.data?.list || [];
  }
  return [];
}

async function main() {
  console.log('=== CONTROLLED TEST: API vs Draw Server Timing ===\n');

  // Get current round info
  const config = JSON.parse((await httpRequest('draw.ar-lottery06.com', '/WinGo/WinGo_30S.json')).body);
  const nextIssue = config.next.issueNumber;
  const nextStart = config.next.startTime;
  const nextEnd = config.next.endTime;
  const curIssue = config.current.issueNumber;

  console.log(`Current: ${curIssue}`);
  console.log(`Next issue: ${nextIssue}`);
  console.log(`Starts: ${new Date(nextStart).toISOString()} (${((nextStart-Date.now())/1000).toFixed(1)}s from now)`);
  console.log(`Ends: ${new Date(nextEnd).toISOString()} (${((nextEnd-Date.now())/1000).toFixed(1)}s from now)`);

  // Get baseline from both sources
  const apiBase = await getAPIResults();
  const drawBase = await getDrawResults();
  const baseIssue = drawBase[0]?.issueNumber || '';
  console.log(`\nBaseline — API: ${apiBase?.map(r => r.number).join(',') || 'failed'}`);
  console.log(`Baseline — Draw: ${drawBase.slice(0,5).map(r => r.number).join(',')} (latest: ${baseIssue})`);
  console.log(`Next issue we're looking for: ${nextIssue}`);

  // Wait until round starts
  const waitToStart = nextStart - Date.now();
  if (waitToStart > 1000) {
    console.log(`\nWaiting ${waitToStart/1000}s for round ${nextIssue} to start...`);
    await new Promise(r => setTimeout(r, waitToStart + 1000));
  }

  console.log(`\n*** Round ${nextIssue} started! Beginning polling ***\n`);

  // Poll both endpoints every 100ms
  let apiDetected = null;
  let drawDetected = null;
  const pollDeadline = nextEnd + 5000;
  const startTime = Date.now();
  let pollCount = 0;

  while (Date.now() < pollDeadline && !drawDetected) {
    pollCount++;

    // Poll API
    if (!apiDetected) {
      try {
        const apiResults = await getAPIResults();
        if (apiResults && apiBase) {
          // Check if first number changed
          if (apiResults[0].number !== apiBase[0].number) {
            apiDetected = {
              numbers: apiResults.map(r => r.number),
              msFromClose: Date.now() - nextEnd,
              msFromStart: Date.now() - nextStart,
              pollIndex: pollCount,
            };
            console.log(`[${new Date().toLocaleTimeString()}] [API] Numbers changed: ${apiDetected.numbers.join(',')}`);
            console.log(`  ${apiDetected.msFromClose}ms from close = ${apiDetected.msFromStart}ms from start`);
          }
        }
      } catch(e) {}
    }

    // Poll draw server
    try {
      const drawResults = await getDrawResults();
      if (drawResults.length > 0 && drawResults[0].issueNumber === nextIssue) {
        drawDetected = {
          number: drawResults[0].number,
          color: drawResults[0].color,
          msFromClose: Date.now() - nextEnd,
          msFromStart: Date.now() - nextStart,
          pollIndex: pollCount,
        };
        console.log(`[${new Date().toLocaleTimeString()}] [DRAW] ${drawResults[0].issueNumber} → ${drawResults[0].number} (${drawResults[0].color})`);
        console.log(`  ${drawDetected.msFromClose}ms from close = ${drawDetected.msFromStart}ms from start`);
      }
    } catch(e) {}

    await new Promise(r => setTimeout(r, 100));
  }

  // Results
  console.log('\n=== RESULTS ===');
  if (apiDetected) {
    console.log(`API detected: ${apiDetected.numbers.join(',')}`);
    console.log(`  Timing: ${apiDetected.msFromClose}ms from close (negative = BEFORE)`);
    console.log(`  Poll #: ${apiDetected.pollIndex}`);
  }
  if (drawDetected) {
    console.log(`Draw detected: ${drawDetected.number} (${drawDetected.color})`);
    console.log(`  Timing: ${drawDetected.msFromClose}ms from close (negative = BEFORE)`);
    console.log(`  Poll #: ${drawDetected.pollIndex}`);
  }

  if (apiDetected && drawDetected) {
    console.log(`\nAPI is ${Math.abs(apiDetected.msFromClose - drawDetected.msFromClose)}ms ${apiDetected.msFromClose < drawDetected.msFromClose ? 'EARLIER' : 'LATER'} than draw server`);
  }

  // Verify results match
  if (apiDetected && drawDetected) {
    const apiFirstNum = apiDetected.numbers[0];
    const match = apiFirstNum == drawDetected.number;
    console.log(`\nVerification: API first number (${apiFirstNum}) = draw result (${drawDetected.number})? ${match ? '✓ MATCH' : '✗ MISMATCH'}`);
  }

  fs.appendFileSync('/tmp/wingo_controlled_test.txt',
    `[${new Date().toISOString()}] Issue: ${nextIssue} | API: ${apiDetected?.numbers?.join(',') || 'N/A'} (${apiDetected?.msFromClose || '?'}ms) | Draw: ${drawDetected?.number || 'N/A'} (${drawDetected?.msFromClose || '?'}ms)\n`);
}

main().catch(e => console.error('Error:', e.message));
