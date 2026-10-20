#!/usr/bin/env node
/**
 * fb999-api-probe-v5.js
 *
 * Based on intercepted browser traffic analysis:
 * - API: POST https://fb999api.com/api/webapi/<endpoint>
 * - Body: {"language":0,"random":"<md5>","signature":"<hex>","timestamp":<unix>}
 * - Signature appears to be computed differently - need to match browser behavior
 * - Auth is via cookies (id_token, access_token from Cognito)
 *
 * This script:
 * 1. First tries to authenticate with Cognito tokens
 * 2. Then probes WinGo-related endpoints
 *
 * Usage: node scripts/fb999-api-probe-v5.js
 */

'use strict';

const https = require('https');
const fs = require('fs');
const crypto = require('crypto');

// Load tokens
let tokens;
try {
  tokens = JSON.parse(fs.readFileSync('/tmp/viralclips_tokens.json', 'utf8'));
} catch (e) {
  console.error('No tokens found.');
  process.exit(1);
}

// Check token validity
const parts = tokens.id_token.split('.');
const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
console.log(`JWT: ${payload.email}, exp: ${new Date(payload.exp * 1000).toISOString()}`);
console.log(`Token valid: ${payload.exp * 1000 > Date.now() ? 'YES' : 'NO'}`);

if (payload.exp * 1000 < Date.now()) {
  console.log('Tokens expired - need to re-authenticate');
  process.exit(1);
}

const idToken = tokens.id_token;
const accessToken = tokens.access_token;
const cookieStr = `id_token=${idToken}; access_token=${accessToken}; idToken=${idToken}; accessToken=${accessToken}`;

// Create request body with proper signature
// Looking at intercepted traffic: {"language":0,"random":"68b1a653f8e14bf8b0dcf78827e1a7d8","signature":"980814EF2D5389D283884D8858EE35AD","timestamp":1792432179}
// The signature might be MD5 of something specific
function createApiBody(extraData = {}) {
  const timestamp = Math.floor(Date.now() / 1000);
  const random = crypto.randomBytes(16).toString('hex');
  // Try different signature approaches:
  // 1. MD5 of (random + timestamp)
  // 2. MD5 of (JSON.stringify of body without signature)
  // 3. HMAC-MD5 with some key
  const signature = crypto.createHash('md5').update(random + timestamp + JSON.stringify(extraData)).digest('hex').toUpperCase();
  return {
    language: 0,
    random: random,
    signature: signature,
    timestamp: timestamp,
    ...extraData,
  };
}

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

// Endpoints to test
const endpoints = [
  // Authentication related
  { name: 'LoginByCognito', path: '/api/webapi/LoginByCognito', body: { idToken: idToken, token: idToken } },
  { name: 'CognitoLogin', path: '/api/webapi/CognitoLogin', body: { idToken: idToken, token: idToken } },
  { name: 'Login', path: '/api/webapi/Login', body: { idToken: idToken, token: idToken } },
  { name: 'AuthLogin', path: '/api/webapi/AuthLogin', body: { idToken: idToken, token: idToken } },
  { name: 'GetLoginToken', path: '/api/webapi/GetLoginToken', body: { idToken: idToken } },
  { name: 'LoginWithCognito', path: '/api/webapi/LoginWithCognito', body: { idToken: idToken } },
  
  // User info
  { name: 'GetUserInfo', path: '/api/webapi/GetUserInfo', body: { token: idToken } },
  { name: 'GetMemberInfo', path: '/api/webapi/GetMemberInfo', body: { token: idToken } },
  { name: 'GetAccountInfo', path: '/api/webapi/GetAccountInfo', body: { token: idToken } },
  
  // WinGo related
  { name: 'GetLotteryList', path: '/api/webapi/GetLotteryList', body: { token: idToken } },
  { name: 'GetLotteryConfig', path: '/api/webapi/GetLotteryConfig', body: { gameCode: 'WinGo_30S' } },
  { name: 'GetWinGoIssue', path: '/api/webapi/GetWinGoIssue', body: { gameCode: 'WinGo_30S' } },
  { name: 'GetWinGoHistory', path: '/api/webapi/GetWinGoHistory', body: { gameCode: 'WinGo_30S', page: 1, pageSize: 50 } },
  { name: 'GetWingoIssue', path: '/api/webapi/GetWingoIssue', body: { gameCode: 'WinGo_30S' } },
  { name: 'GetWingoResult', path: '/api/webapi/GetWingoResult', body: { gameCode: 'WinGo_30S' } },
  { name: 'GetRecentWinGoResult', path: '/api/webapi/GetRecentWinGoResult', body: { gameCode: 'WinGo_30S' } },
  { name: 'GetLotteryIssue', path: '/api/webapi/GetLotteryIssue', body: { gameCode: 'WinGo_30S' } },
  { name: 'GetLotteryResult', path: '/api/webapi/GetLotteryResult', body: { gameCode: 'WinGo_30S' } },
  
  // Generic
  { name: 'GetHomeSettings', path: '/api/webapi/GetHomeSettings', body: {} },
  { name: 'GetGameList', path: '/api/webapi/GetGameList', body: { token: idToken } },
  { name: 'GetProjectConfig', path: '/api/webapi/GetProjectConfig', body: {} },
];

console.log('\n=== Probing API Endpoints ===\n');

(async () => {
  for (const endpoint of endpoints) {
    try {
      const body = createApiBody(endpoint.body);
      console.log(`[${endpoint.name}] POST ${endpoint.path}`);
      const result = await makeRequest(endpoint.path, body, cookieStr);
      console.log(`  Status: ${result.status}`);

      if (result.status === 200) {
        let parsed = null;
        try {
          parsed = JSON.parse(result.body);
        } catch (e) {
          // Not JSON
        }
        
        if (parsed) {
          const code = parsed.code;
          const msg = parsed.msg;
          console.log(`  code: ${code}, msg: ${msg}`);
          
          if (code === 0 || code === '0') {
            console.log('  *** SUCCESS! ***');
            console.log('  Data: ' + JSON.stringify(parsed.data || parsed).substring(0, 500));
            const fileName = `/tmp/fb999_${endpoint.name}_${Date.now()}.json`;
            fs.writeFileSync(fileName, JSON.stringify(parsed, null, 2));
            console.log(`  Saved: ${fileName}`);
          } else {
            console.log(`  Error msg: ${msg || JSON.stringify(parsed).substring(0, 200)}`);
          }
        } else {
          console.log(`  Response: ${result.body.substring(0, 300)}`);
        }
      } else {
        console.log(`  Non-200: ${result.body.substring(0, 200)}`);
      }
    } catch (e) {
      console.log(`  Network error: ${e.message}`);
    }
    console.log('');
  }
})();
