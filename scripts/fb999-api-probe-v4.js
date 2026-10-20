#!/usr/bin/env node
/**
 * fb999-api-probe-v4.js
 *
 * Uses the correct API structure discovered from browser interception:
 * - POST /api/webapi/<endpoint>
 * - Body: {"language":0,"random":"<md5>","signature":"<hex>","timestamp":<unix>}
 * - Auth via cookies (id_token, access_token)
 *
 * Usage: node scripts/fb999-api-probe-v4.js
 */

'use strict';

const https = require('https');
const fs = require('fs');
const crypto = require('crypto');

// Load tokens
let tokens;
try {
  tokens = JSON.parse(fs.readFileSync('/tmp/viralclips_tokens.json', 'utf8'));
  console.log('Loaded tokens');
} catch (e) {
  console.error('No tokens found.');
  process.exit(1);
}

const idToken = tokens.id_token;
const accessToken = tokens.access_token;

// Check token validity
try {
  const parts = idToken.split('.');
  const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
  console.log(`JWT sub: ${payload.sub}`);
  console.log(`JWT email: ${payload.email}`);
  console.log(`JWT exp: ${new Date(payload.exp * 1000).toISOString()}`);
  console.log(`Current time: ${new Date().toISOString()}`);
  console.log(`Token valid: ${payload.exp * 1000 > Date.now() ? 'YES' : 'NO'}`);
} catch (e) {
  console.log('Could not decode JWT:', e.message);
}

// Generate the API request body format
function createApiBody(extraData = {}) {
  const timestamp = Math.floor(Date.now() / 1000);
  const random = crypto.randomBytes(16).toString('hex');
  const signature = crypto.createHash('md5').update(random + timestamp).digest('hex').toUpperCase();
  return {
    language: 0,
    random: random,
    signature: signature,
    timestamp: timestamp,
    ...extraData,
  };
}

// Make HTTPS request
function makeRequest(path, body, cookies) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7',
      'Referer': 'https://fb999.com/',
      'Origin': 'https://fb999.com',
      'Content-Type': 'application/json;charset=UTF-8',
      'ar-origin': 'https://fb999.com',
    };

    if (cookies) {
      headers['Cookie'] = cookies;
    }

    const req = https.request({
      hostname: 'fb999api.com',
      port: 443,
      path: path,
      method: 'POST',
      headers: headers,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          statusText: res.statusText,
          headers: res.headers,
          body: data,
        });
      });
    });

    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

// Build cookie string
const cookieStr = `id_token=${idToken}; access_token=${accessToken}`;

// Endpoints to test
const endpoints = [
  // Core API - with token in body
  { name: 'GetLotteryIssue', path: '/api/webapi/GetLotteryIssue', body: { gameCode: 'WinGo_30S', token: idToken } },
  { name: 'GetHistoryIssue', path: '/api/webapi/GetHistoryIssue', body: { lottery: 'WinGo', gameCode: 'WinGo_30S', token: idToken } },
  { name: 'GetCurrentIssue', path: '/api/webapi/GetCurrentIssue', body: { gameCode: 'WinGo_30S', token: idToken } },
  { name: 'GetLastPeriod', path: '/api/webapi/GetLastPeriod', body: { gameCode: 'WinGo_30S', token: idToken } },
  { name: 'GetLastIssue', path: '/api/webapi/GetLastIssue', body: { gameCode: 'WinGo_30S', token: idToken } },
  { name: 'GetRecentResult', path: '/api/webapi/GetRecentResult', body: { gameCode: 'WinGo_30S', token: idToken } },
  { name: 'GetLotteryConfig', path: '/api/webapi/GetLotteryConfig', body: { gameCode: 'WinGo_30S', token: idToken } },
  { name: 'GetWinGoConfig', path: '/api/webapi/GetWinGoConfig', body: { gameCode: 'WinGo_30S', token: idToken } },
  { name: 'GetLotteryInfo', path: '/api/webapi/GetLotteryInfo', body: { lottery: 'WinGo', token: idToken } },
  
  // User-related
  { name: 'GetUserInfo', path: '/api/webapi/GetUserInfo', body: { token: idToken } },
  { name: 'GetMemberInfo', path: '/api/webapi/GetMemberInfo', body: { token: idToken } },
  { name: 'GetAccountInfo', path: '/api/webapi/GetAccountInfo', body: { token: idToken } },
  { name: 'GetUserByToken', path: '/api/webapi/GetUserByToken', body: { token: idToken } },
  
  // Lottery list / period
  { name: 'GetLotteryList', path: '/api/webapi/GetLotteryList', body: { token: idToken } },
  { name: 'GetLotteryTypeList', path: '/api/webapi/GetLotteryTypeList', body: { token: idToken } },
  { name: 'GetPeriod', path: '/api/webapi/GetPeriod', body: { gameCode: 'WinGo_30S', token: idToken } },
  { name: 'GetPeriodList', path: '/api/webapi/GetPeriodList', body: { gameCode: 'WinGo_30S', page: 1, pageSize: 50, token: idToken } },
  { name: 'GetResult', path: '/api/webapi/GetResult', body: { gameCode: 'WinGo_30S', token: idToken } },
  { name: 'GetResultList', path: '/api/webapi/GetResultList', body: { gameCode: 'WinGo_30S', page: 1, pageSize: 50, token: idToken } },
  
  // Bet-related
  { name: 'GetBetRecord', path: '/api/webapi/GetBetRecord', body: { gameCode: 'WinGo_30S', page: 1, pageSize: 50, token: idToken } },
  { name: 'GetMyBet', path: '/api/webapi/GetMyBet', body: { gameCode: 'WinGo_30S', token: idToken } },
  
  // Common endpoints
  { name: 'GetHomeSettings', path: '/api/webapi/GetHomeSettings', body: {} },
  { name: 'GetProjectInfo', path: '/api/webapi/GetProjectInfo', body: {} },
];

console.log('\n=== Probing API Endpoints ===\n');

(async () => {
  for (const endpoint of endpoints) {
    try {
      const body = createApiBody(endpoint.body);
      console.log(`[${endpoint.name}] POST /api/webapi/${endpoint.name}`);
      const result = await makeRequest(endpoint.path, body, cookieStr);
      console.log(`  Status: ${result.status}`);

      if (result.status === 401 || result.status === 403) {
        console.log('  Auth failed - token may be expired');
        console.log(`  Body: ${result.body?.substring(0, 300)}`);
      } else if (result.status === 200) {
        console.log('  Response:');
        console.log('  ' + result.body.substring(0, 800));
        
        // Save successful responses
        const fileName = `/tmp/fb999_${endpoint.name}_${Date.now()}.json`;
        fs.writeFileSync(fileName, result.body);
        console.log(`  Saved: ${fileName}`);
        
        // Check for interesting data
        try {
          const parsed = JSON.parse(result.body);
          if (parsed.code === 0 || parsed.data) {
            console.log('  *** SUCCESS! ***');
            console.log('  Parsed: ' + JSON.stringify(parsed).substring(0, 500));
          }
        } catch (e) {
          // Not JSON
        }
      } else {
        console.log(`  Error: ${result.body?.substring(0, 200)}`);
      }
    } catch (e) {
      console.log(`  Network error: ${e.message}`);
    }
    console.log('');
  }
})();
