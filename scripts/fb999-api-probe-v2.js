#!/usr/bin/env node
/**
 * fb999-api-probe-v2.js
 *
 * Uses fresh Cognito JWT tokens to probe fb999 API endpoints with correct URL structure.
 * Based on analysis of useWinGo3-17EyT1aS.js and wingo-DOjOMifY.js chunks.
 *
 * Usage: node scripts/fb999-api-probe-v2.js
 */

'use strict';

const https = require('https');
const fs = require('fs');
const crypto = require('crypto');

// Load fresh tokens
let tokens;
try {
  tokens = JSON.parse(fs.readFileSync('/tmp/viralclips_tokens.json', 'utf8'));
  console.log('Loaded fresh tokens');
} catch (e) {
  console.error('No tokens found. Run the auth script first.');
  process.exit(1);
}

const token = tokens.id_token || tokens.access_token;

// Decode JWT to verify
console.log('\nJWT Payload:');
try {
  const parts = token.split('.');
  const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
  console.log(`  sub: ${payload.sub}`);
  console.log(`  email: ${payload.email}`);
  console.log(`  token_use: ${payload.token_use}`);
  console.log(`  exp: ${new Date(payload.exp * 1000).toISOString()}`);
  console.log(`  current time: ${new Date().toISOString()}`);
  if (payload.exp * 1000 < Date.now()) {
    console.log('  WARNING: Token is EXPIRED!');
  } else {
    console.log('  Token is valid.');
  }
} catch (e) {
  console.log('Could not decode JWT:', e.message);
}

// API request helper - tries different URL patterns
async function makeRequest(options) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          statusText: res.statusText,
          headers: res.headers,
          body: data,
          url: `${options.hostname ? 'https://' + options.hostname : ''}${options.path || ''}`,
        });
      });
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

const headers = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7',
  'Referer': 'https://fb999.com/',
  'Origin': 'https://fb999.com',
  'Authorization': `Bearer ${token}`,
};

// Based on the code analysis, the API uses paths like:
// - /Lottery/WinGoBet (no /api prefix)
// - /Energy/GetPanel
// - /api/* (possibly different structure)

const endpointsToTest = [
  // Direct paths (as seen in the JS bundles)
  { method: 'GET', hostname: 'fb999api.com', path: '/Lottery/GetLotteryIssue?gameCode=WinGo_30S&token=' + token },
  { method: 'GET', hostname: 'fb999api.com', path: '/Lottery/GetCurrentIssue?gameCode=WinGo_30S&token=' + token },
  { method: 'GET', hostname: 'fb999api.com', path: '/Lottery/GetIssue?gameCode=WinGo_30S&token=' + token },
  { method: 'GET', hostname: 'fb999api.com', path: '/Lottery/CheckStatus?token=' + token },
  { method: 'GET', hostname: 'fb999api.com', path: '/Lottery/GetLotteryInfo?token=' + token },
  { method: 'GET', hostname: 'fb999api.com', path: '/Lottery/GetHistory?lottery=WinGo&gameCode=WinGo_30S&token=' + token },
  { method: 'GET', hostname: 'fb999api.com', path: '/Lottery/GetPeriod?gameCode=WinGo_30S&token=' + token },
  { method: 'GET', hostname: 'fb999api.com', path: '/Lottery/GetLastIssue?gameCode=WinGo_30S&token=' + token },
  { method: 'GET', hostname: 'fb999api.com', path: '/Lottery/GetLastPeriod?gameCode=WinGo_30S&token=' + token },
  
  // Try without token in query
  { method: 'GET', hostname: 'fb999api.com', path: '/Lottery/GetLotteryIssue?gameCode=WinGo_30S', headers: { ...headers, 'Authorization': `Bearer ${token}` } },
  
  // Try API prefix paths
  { method: 'GET', hostname: 'fb999api.com', path: '/api/Lottery/GetLotteryIssue?gameCode=WinGo_30S&token=' + token },
  { method: 'GET', hostname: 'fb999api.com', path: '/api/lottery/getLotteryIssue?gameCode=WinGo_30S&token=' + token },
  { method: 'GET', hostname: 'fb999api.com', path: '/api/lottery/getIssue?gameCode=WinGo_30S&token=' + token },
  
  // Try with different base URLs
  { method: 'GET', hostname: 'fb999api.com', path: '/v1/Lottery/GetLotteryIssue?gameCode=WinGo_30S&token=' + token },
  
  // Try getting user info
  { method: 'GET', hostname: 'fb999api.com', path: '/Member/GetUserInfo?token=' + token },
  { method: 'GET', hostname: 'fb999api.com', path: '/Member/GetUser?token=' + token },
  { method: 'GET', hostname: 'fb999api.com', path: '/User/GetUserInfo?token=' + token },
  { method: 'GET', hostname: 'fb999api.com', path: '/User/GetUser?token=' + token },
  
  // Try auth token validation
  { method: 'GET', hostname: 'fb999api.com', path: '/Auth/GetUserByToken?token=' + token },
  { method: 'GET', hostname: 'fb999api.com', path: '/Auth/CheckToken?token=' + token },
  { method: 'GET', hostname: 'fb999api.com', path: '/Auth/UserInfo?token=' + token },
  
  // Just hit root to see if API responds
  { method: 'GET', hostname: 'fb999api.com', path: '/' },
  
  // Try the main fb999.com API
  { method: 'GET', hostname: 'fb999.com', path: '/api/lottery/getLotteryIssue?gameCode=WinGo_30S&token=' + token },
  
  // Try with different content types
  { method: 'POST', hostname: 'fb999api.com', path: '/Lottery/GetLotteryIssue', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ gameCode: 'WinGo_30S', token: token }) },
  { method: 'POST', hostname: 'fb999api.com', path: '/api/Lottery/GetLotteryIssue', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ gameCode: 'WinGo_30S', token: token }) },
];

// Also try paths from the code analysis
const pathsFromCode = [
  '/api/lottery/getIssue',
  '/api/lottery/getHistoryIssue',
  '/api/lottery/getLotteryIssue',
  '/api/auth/login',
  '/api/auth/getUserInfo',
  '/api/user/getUserInfo',
  '/api/wingo/getIssue',
  '/api/wingo/getResult',
  '/api/wingo/getHistory',
  '/api/wingo/getConfig',
  '/Lottery/Issue',
  '/Lottery/Result',
  '/Lottery/History',
  '/Lottery/WPConfig',
];

console.log('\n=== Probing API Endpoints ===\n');

(async () => {
  for (const endpoint of endpointsToTest) {
    try {
      console.log(`Testing: ${endpoint.method} ${endpoint.hostname ? endpoint.hostname : 'fb999.com'}${endpoint.path?.substring(0, 80)}...`);
      const result = await makeRequest({
        hostname: endpoint.hostname || 'fb999api.com',
        port: 443,
        path: endpoint.path,
        method: endpoint.method,
        headers: endpoint.headers || headers,
        body: endpoint.body || null,
      });
      console.log(`  Status: ${result.status}`);
      const bodyPreview = result.body ? result.body.substring(0, 300) : '(empty)';
      console.log(`  Body: ${bodyPreview}`);
      if (result.status >= 200 && result.status < 300 && result.body && !bodyPreview.includes('404') && !bodyPreview.includes('not exist')) {
        console.log('  *** SUCCESS! Saving response.');
        const fileName = `/tmp/fb999_result_${Date.now()}_${Math.random().toString(36).substring(7)}.json`;
        fs.writeFileSync(fileName, result.body);
        console.log(`  Saved to: ${fileName}`);
      }
    } catch (e) {
      console.log(`  Error: ${e.message}`);
    }
    console.log('');
  }

  // Also try the paths from code analysis with just the first few
  console.log('\n=== Testing paths from code analysis ===\n');
  for (const p of pathsFromCode.slice(0, 15)) {
    try {
      const urlPath = `${p}?token=${token}&gameCode=WinGo_30S`;
      console.log(`Testing: GET fb999api.com${p}`);
      const result = await makeRequest({
        hostname: 'fb999api.com',
        port: 443,
        path: urlPath,
        method: 'GET',
        headers: { ...headers, 'Authorization': `Bearer ${token}` },
      });
      console.log(`  Status: ${result.status}`);
      const bodyPreview = result.body ? result.body.substring(0, 300) : '(empty)';
      console.log(`  Body: ${bodyPreview}`);
      if (result.status >= 200 && result.status < 300 && result.body && !bodyPreview.includes('404') && !bodyPreview.includes('not exist')) {
        console.log('  *** SUCCESS! Saving response.');
        const fileName = `/tmp/fb999_result_${Date.now()}_${Math.random().toString(36).substring(7)}.json`;
        fs.writeFileSync(fileName, result.body);
        console.log(`  Saved to: ${fileName}`);
      }
    } catch (e) {
      console.log(`  Error: ${e.message}`);
    }
    console.log('');
  }
})();
