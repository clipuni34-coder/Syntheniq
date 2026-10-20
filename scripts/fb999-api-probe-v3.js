#!/usr/bin/env node
/**
 * fb999-api-probe-v3.js
 *
 * Probes fb999 API with tenant-specific routes based on window.CONFIG:
 * - Tenant: ar004
 * - Merchant ID: 6666004
 * - API URL: https://fb999api.com
 *
 * Usage: node scripts/fb999-api-probe-v3.js
 */

'use strict';

const https = require('https');
const fs = require('fs');

// Load tokens
let tokens;
try {
  tokens = JSON.parse(fs.readFileSync('/tmp/viralclips_tokens.json', 'utf8'));
  console.log('Loaded tokens');
} catch (e) {
  console.error('No tokens found.');
  process.exit(1);
}

const token = tokens.id_token || tokens.access_token;

// Decode JWT
try {
  const parts = token.split('.');
  const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
  console.log(`JWT sub: ${payload.sub}`);
  console.log(`JWT email: ${payload.email}`);
  console.log(`JWT exp: ${new Date(payload.exp * 1000).toISOString()}`);
  console.log(`Current time: ${new Date().toISOString()}`);
  console.log(`Token valid: ${payload.exp * 1000 > Date.now() ? 'YES' : 'NO'}`);
} catch (e) {
  console.log('Could not decode JWT:', e.message);
}

const headers = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7',
  'Referer': 'https://fb999.com/',
  'Origin': 'https://fb999.com',
  'Authorization': `Bearer ${token}`,
  'tenant': 'ar004',
  'merchantId': '6666004',
};

async function makeRequest(opts) {
  return new Promise((resolve, reject) => {
    const req = https.request(opts, (res) => {
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
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

// Based on the tenant pattern (ar004), try these URL structures:
const endpoints = [
  // Tenant-prefixed routes
  { method: 'GET', hostname: 'fb999api.com', path: '/ar004/api/lottery/getLotteryIssue?gameCode=WinGo_30S' },
  { method: 'GET', hostname: 'fb999api.com', path: '/ar004/api/lottery/getHistoryIssue?lottery=WinGo&gameCode=WinGo_30S&page=1&pageSize=50' },
  { method: 'GET', hostname: 'fb999api.com', path: '/ar004/api/lottery/getCurrentIssue?gameCode=WinGo_30S' },
  { method: 'GET', hostname: 'fb999api.com', path: '/ar004/api/user/getUserInfo' },
  { method: 'GET', hostname: 'fb999api.com', path: '/ar004/api/lottery/getUserByToken' },
  { method: 'GET', hostname: 'fb999api.com', path: '/ar004/api/auth/getUserInfo' },
  { method: 'GET', hostname: 'fb999api.com', path: '/ar004/Lottery/GetLotteryIssue?gameCode=WinGo_30S' },
  { method: 'GET', hostname: 'fb999api.com', path: '/ar004/Lottery/GetHistoryIssue?lottery=WinGo&gameCode=WinGo_30S' },
  
  // Try with api prefix and merchant
  { method: 'GET', hostname: 'fb999api.com', path: '/api/ar004/lottery/getLotteryIssue?gameCode=WinGo_30S' },
  { method: 'GET', hostname: 'fb999api.com', path: '/6666004/api/lottery/getLotteryIssue?gameCode=WinGo_30S' },
  
  // Try without /api prefix
  { method: 'GET', hostname: 'fb999api.com', path: '/ar004/lottery/getLotteryIssue?gameCode=WinGo_30S' },
  { method: 'GET', hostname: 'fb999api.com', path: '/ar004/lottery/getHistoryIssue?lottery=WinGo&gameCode=WinGo_30S&page=1&pageSize=50' },
  { method: 'GET', hostname: 'fb999api.com', path: '/ar004/lottery/getCurrentIssue?gameCode=WinGo_30S' },
  { method: 'GET', hostname: 'fb999api.com', path: '/ar004/user/getUserInfo' },
  
  // Try with merchant ID
  { method: 'GET', hostname: 'fb999api.com', path: '/6666004/lottery/getLotteryIssue?gameCode=WinGo_30S' },
  { method: 'GET', hostname: 'fb999api.com', path: '/merchant/6666004/api/lottery/getLotteryIssue?gameCode=WinGo_30S' },
  
  // Try with token as Bearer vs query param
  { method: 'GET', hostname: 'fb999api.com', path: '/ar004/api/lottery/getIssue?gameCode=WinGo_30S' },
  { method: 'GET', hostname: 'fb999api.com', path: '/ar004/api/lottery/getPeriod?gameCode=WinGo_30S' },
  { method: 'GET', hostname: 'fb999api.com', path: '/ar004/api/lottery/getResult?gameCode=WinGo_30S' },
  { method: 'GET', hostname: 'fb999api.com', path: '/ar004/api/lottery/getHistory?lottery=WinGo&gameCode=WinGo_30S&page=1&pageSize=50' },
  
  // Try /saas prefix (since URL has /#/saasLottery/)
  { method: 'GET', hostname: 'fb999api.com', path: '/saas/api/lottery/getLotteryIssue?gameCode=WinGo_30S' },
  { method: 'GET', hostname: 'fb999api.com', path: '/saas/ar004/api/lottery/getLotteryIssue?gameCode=WinGo_30S' },
  
  // Try root paths with different prefixes
  { method: 'GET', hostname: 'fb999api.com', path: '/' },
  { method: 'GET', hostname: 'fb999api.com', path: '/ar004' },
  { method: 'GET', hostname: 'fb999api.com', path: '/api' },
  
  // Try without token in Authorization but with it in query
  { method: 'GET', hostname: 'fb999api.com', path: '/ar004/api/lottery/getLotteryIssue?gameCode=WinGo_30S&token=' + token },
  { method: 'GET', hostname: 'fb999api.com', path: '/ar004/api/lottery/getHistoryIssue?lottery=WinGo&gameCode=WinGo_30S&token=' + token + '&page=1&pageSize=50' },
  { method: 'GET', hostname: 'fb999api.com', path: '/ar004/api/user/getUserInfo?token=' + token },
];

console.log('\n=== Probing API Endpoints with tenant routing ===\n');

(async () => {
  for (const endpoint of endpoints) {
    try {
      const opts = {
        hostname: endpoint.hostname,
        port: 443,
        path: endpoint.path,
        method: endpoint.method,
        headers: { ...headers },
      };
      if (endpoint.method === 'POST') {
        opts.body = JSON.stringify({ gameCode: 'WinGo_30S', token: token });
        opts.headers['Content-Type'] = 'application/json';
      }
      console.log(`[${endpoint.method}] ${endpoint.hostname}${endpoint.path.substring(0, 80)}`);
      const result = await makeRequest(opts);
      console.log(`  Status: ${result.status}`);
      const bodyPreview = result.body ? result.body.substring(0, 400) : '(empty)';
      if (result.status === 200 || (result.status >= 200 && result.status < 300)) {
        if (result.body && result.body.includes('<') && result.body.includes('DOCTYPE')) {
          console.log('  (HTML response - SPA shell)');
        } else {
          console.log(`  Response: ${bodyPreview}`);
          if (!bodyPreview.includes('not exist') && !bodyPreview.includes('404')) {
            const fileName = `/tmp/fb999_success_${Date.now()}_${Math.random().toString(36).substring(7)}.json`;
            fs.writeFileSync(fileName, result.body);
            console.log(`  *** SAVED: ${fileName}`);
          }
        }
      } else {
        console.log(`  Error: ${bodyPreview}`);
      }
    } catch (e) {
      console.log(`  Network error: ${e.message}`);
    }
    console.log('');
  }
})();
