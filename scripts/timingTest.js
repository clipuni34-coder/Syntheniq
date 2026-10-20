/**
 * Quick test: Validate Cognito token + compare API vs draw server timing
 */
const https = require('https');
const fs = require('fs');
const crypto = require('crypto');

const tokens = JSON.parse(fs.readFileSync('/tmp/viralclips_tokens.json', 'utf8'));

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

async function main() {
  console.log('=== Quick timing test ===\n');

  // 1. Validate token
  const ACCESS_TOKEN = tokens.access_token;
  console.log('Testing API with Cognito token...');

  const apiRes = await httpRequest('fb999api.com', '/api/webapi/GetLastFiveIssueNumberResult', 'POST',
    JSON.stringify(signParams({ TypeId: 30 })), { 'Authorization': `Bearer ${ACCESS_TOKEN}` });
  console.log('API status:', apiRes.status);
  console.log('API response:', apiRes.body.substring(0, 300));

  if (apiRes.status !== 200) {
    console.log('API auth failed — token may be expired');
    return;
  }

  const apiJson = JSON.parse(apiRes.body);
  if (apiJson.code !== 0) {
    console.log('API returned error:', apiJson.code, apiJson.msg);
    return;
  }

  // 2. Get draw server data
  const config = JSON.parse((await httpRequest('draw.ar-lottery06.com', '/WinGo/WinGo_30S.json')).body);
  const drawRes = await httpRequest('draw.ar-lottery06.com', '/WinGo/WinGo_30S/GetHistoryIssuePage.json?pageNo=1&pageSize=10');
  const drawList = JSON.parse(drawRes.body).data?.list || [];

  console.log('\nConfig:');
  console.log('  Current issue:', config.current.issueNumber);
  console.log('  End time:', new Date(config.current.endTime).toISOString());
  console.log('  Next issue:', config.next.issueNumber);
  console.log('  Time to close:', ((config.current.endTime - Date.now())/1000).toFixed(1), 's');

  console.log('\nDraw server history:');
  drawList.slice(0, 5).forEach((r, i) => console.log(`  ${i+1}. ${r.issueNumber} → ${r.number} (${r.color})`));

  const apiNums = apiJson.data.number.split(',');
  console.log('\nAPI last 5:', apiNums.join(', '));

  // 3. Check if current issue result is already available
  const currentResult = drawList.find(r => r.issueNumber === config.current.issueNumber);
  console.log('\nCurrent issue result already in history?', currentResult ? `Yes: ${currentResult.number}` : 'No');

  // 4. Poll for next issue result
  const nextIssue = config.next.issueNumber;
  const nextEndTime = config.next.endTime;
  console.log(`\nPolling for ${nextIssue} result...`);
  console.log(`Close time: ${new Date(nextEndTime).toISOString()}`);
  console.log(`Polld for ${Math.max(3000, (nextEndTime - Date.now() + 3000))}ms\n`);

  let lastApiNums = apiNums.join('');
  let detected = false;
  const deadline = nextEndTime + 5000;

  while (Date.now() < deadline && !detected) {
    // Poll draw server
    try {
      const res = await httpRequest('draw.ar-lottery06.com',
        '/WinGo/WinGo_30S/GetHistoryIssuePage.json?pageNo=1&pageSize=10');
      const list = JSON.parse(res.body).data?.list || [];
      if (list.length > 0 && list[0].issueNumber === nextIssue) {
        const ms = Date.now() - nextEndTime;
        console.log(`[DRAW] ${list[0].issueNumber} → ${list[0].number} (${list[0].color}) — ${ms}ms from close`);
        detected = true;
        break;
      }
    } catch(e) {}

    // Poll API
    try {
      const apiRes2 = await httpRequest('fb999api.com', '/api/webapi/GetLastFiveIssueNumberResult', 'POST',
        JSON.stringify(signParams({ TypeId: 30 })), { 'Authorization': `Bearer ${ACCESS_TOKEN}` });
      if (apiRes2.status === 200) {
        const j = JSON.parse(apiRes2.body);
        if (j.code === 0 && j.data?.number) {
          const nums = j.data.number.split(',');
          if (nums.join('') !== lastApiNums) {
            const ms = Date.now() - nextEndTime;
            console.log(`[API] Numbers changed: ${nums.join(',')} — ${ms}ms from close`);
            lastApiNums = nums.join('');
          }
        }
      }
    } catch(e) {}

    await new Promise(r => setTimeout(r, 100));
  }

  if (!detected) {
    console.log('No result detected within polling window');
  }
  console.log('\nDone.');
}

main().catch(e => console.error('Error:', e.message));
