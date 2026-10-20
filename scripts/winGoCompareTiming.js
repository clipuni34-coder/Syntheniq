/**
 * Test: Does GetLastFiveIssueNumberResult (API, TypeId=30) publish
 * results EARLIER than draw.ar-lottery06.com GetHistoryIssuePage?
 *
 * If yes — we have a faster data source.
 * If no — the draw server is our best option.
 *
 * Uses Cognito token (access_token) from /tmp/viralclips_tokens.json
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

async function main() {
  console.log('=== API vs Draw Server — Early Detection Comparison ===\n');
  console.log('Testing if authenticated API (GetLastFiveIssueNumberResult) publishes results earlier...\n');

  // Get current game state to know when the next result should appear
  const config = JSON.parse((await httpRequest('draw.ar-lottery06.com', '/WinGo/WinGo_30S.json')).body);
  const currentEndTime = config.current.endTime;
  const nextIssue = config.next.issueNumber;
  const nextEndTime = config.next.endTime;

  console.log(`Current issue: ${config.current.issueNumber} (closes ${new Date(currentEndTime).toISOString()})`);
  console.log(`Next issue: ${nextIssue}`);
  console.log(`Time to next close: ${(nextEndTime - Date.now())/1000}s`);

  // Get baseline from both sources
  const drawBaseline = JSON.parse((await httpRequest('draw.ar-lottery06.com',
    '/WinGo/WinGo_30S/GetHistoryIssuePage.json?pageNo=1&pageSize=10')).body);
  const drawLatest = drawBaseline.data?.list?.[0]?.issueNumber || '';
  console.log(`Draw server latest: ${drawLatest}`);

  const apiResponse = await httpRequest('fb999api.com', '/api/webapi/GetLastFiveIssueNumberResult', 'POST',
    JSON.stringify(signParams({ TypeId: 30 })), { 'Authorization': `Bearer ${ACCESS_TOKEN}` });
  console.log(`API baseline: ${apiResponse.body.substring(0, 200)}`);

  // Determine which issue number the API returned (last 5 numbers)
  let apiLatestIssue = '';
  let apiNumbers = [];
  if (apiResponse.status === 200) {
    const json = JSON.parse(apiResponse.body);
    if (json.data?.number) {
      apiNumbers = typeof json.data.number === 'string' ? json.data.number.split(',') : json.data.number;
      console.log(`API numbers: ${apiNumbers.join(',')}`);
    }
  }

  // Now poll both endpoints in parallel until the NEXT result appears
  console.log(`\nPolling both endpoints (100ms)...`);
  console.log(`Waiting for issue ${nextIssue} result...\n`);

  let drawDetected = null;
  let apiDetected = null;
  const pollStart = Date.now();
  const pollDeadline = nextEndTime + 5000; // Poll for 5s after close

  while (Date.now() < pollDeadline && !drawDetected) {
    // Poll draw server
    try {
      const res = await httpRequest('draw.ar-lottery06.com',
        '/WinGo/WinGo_30S/GetHistoryIssuePage.json?pageNo=1&pageSize=10');
      if (res.status === 200) {
        const list = JSON.parse(res.body).data?.list || [];
        if (list.length > 0 && list[0].issueNumber === nextIssue) {
          drawDetected = {
            issue: list[0].issueNumber,
            number: list[0].number,
            color: list[0].color,
            msFromClose: Date.now() - nextEndTime,
            timestamp: Date.now(),
            source: 'draw-server',
          };
          console.log(`[DRAW] ${list[0].issueNumber} → ${list[0].number} (${list[0].color}) | ${drawDetected.msFromClose}ms from close`);
        }
      }
    } catch(e) {}

    // Poll API simultaneously
    if (!apiDetected) {
      try {
        const apiRes = await httpRequest('fb999api.com', '/api/webapi/GetLastFiveIssueNumberResult', 'POST',
          JSON.stringify(signParams({ TypeId: 30 })), { 'Authorization': `Bearer ${ACCESS_TOKEN}` });
        if (apiRes.status === 200) {
          const json = JSON.parse(apiRes.body);
          if (json.code === 0 && json.data?.number) {
            const nums = typeof json.data.number === 'string' ? json.data.number.split(',') : json.data.number;
            // Check if the latest number in API matches a new result
            // The API returns last 5 numbers; we need to detect if a NEW number appeared
            // We compare with the baseline
            const newNum = nums[0];
            if (newNum && nums[0] !== apiNumbers[0]) {
              apiDetected = {
                numbers: nums,
                msFromClose: Date.now() - nextEndTime,
                timestamp: Date.now(),
                source: 'api',
              };
              console.log(`[API] New result detected: ${nums.join(',')} | ${apiDetected.msFromClose}ms from close`);
            }
          }
        }
      } catch(e) {}
    }

    await sleep(100);
  }

  // Results
  console.log('\n=== Comparison ===');
  if (drawDetected) {
    console.log(`Draw server: ${drawDetected.number} (${drawDetected.color}) detected ${drawDetected.msFromClose}ms from close`);
  } else {
    console.log(`Draw server: NO result detected within polling window`);
  }
  if (apiDetected) {
    console.log(`API: ${apiDetected.numbers.join(',')} detected ${apiDetected.msFromClose}ms from close`);
  } else {
    console.log(`API: No NEW result detected (result may not have changed in API response format)`);
  }

  if (drawDetected && apiDetected) {
    const diff = drawDetected.msFromClose - apiDetected.msFromClose;
    console.log(`\nAPI is ${Math.abs(diff)}ms ${diff < 0 ? 'EARLIER' : 'LATER'} than draw server`);
  }

  fs.writeFileSync('/tmp/wingo_comparison.json', JSON.stringify({
    drawDetected,
    apiDetected,
    currentIssue: config.current.issueNumber,
    nextIssue: config.next.issueNumber,
    pollDuration: Date.now() - pollStart,
  }, null, 2));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

main().catch(e => console.error('Error:', e.message));
