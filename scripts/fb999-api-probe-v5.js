#!/usr/bin/env node
/**
 * fb999-api-probe-v5.js
 *
 * Tests additional fb999 API endpoints using the correct JWT from /tmp/fb999_login_response.json
 * 
 * Endpoints tested:
 * - GetLotteryIssue, GetHistoryIssue, GetCurrentIssue, GetLastPeriod, GetLastIssue
 * - GetRecentResult, GetLotteryConfig, GetWinGoConfig, GetLotteryInfo
 * - GetUserInfo, GetMemberInfo, GetAccountInfo, GetUserByToken
 * - GetLotteryList, GetLotteryTypeList, GetPeriod, GetPeriodList
 * - GetResult, GetResultList, GetBetRecord, GetMyBet
 *
 * Usage: node scripts/fb999-api-probe-v5.js
 */

'use strict';

const https = require('https');
const fs = require('fs');
const crypto = require('crypto');

// Load fb999 JWT from login response
let JWT;
try {
  const login = JSON.parse(fs.readFileSync('/tmp/fb999_login_response.json', 'utf8'));
  JWT = login.data?.token;
  console.log('Loaded JWT:', JWT.substring(0, 40) + '...');
  
  // Check validity
  const payload = JSON.parse(Buffer.from(JWT.split('.')[1], 'base64').toString());
  const exp = payload.exp || 0;
  console.log('JWT exp:', new Date(exp * 1000).toISOString());
  console.log('JWT valid:', exp * 1000 > Date.now());
} catch (e) {
  console.error('No JWT found:', e.message);
  process.exit(1);
}

// Signing (same format as fb999 app)
function signParams(params) {
  const u = { ...params, language: 0 };
  u.random = crypto.randomBytes(16).toString('hex');
  const c = JSON.parse(JSON.stringify(u));
  const o = Object.keys(c).filter(k =>
    !(typeof c[k] === 'object' && c[k] !== null && !Array.isArray(c[k])) && !Array.isArray(c[k]));
  o.sort();
  const i = {};
  o.forEach(k => { if (c[k] !== null && c[k] !== "" && c[k] !== undefined) i[k] = c[k] === 0 ? 0 : c[k]; });
  u.signature = crypto.createHash('md5').update(JSON.stringify(i)).digest('hex').toUpperCase().slice(0, 32);
  u.timestamp = Math.floor(Date.now() / 1e3);
  return u;
}

function httpPost(hostname, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const h = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
      'Referer': 'https://h5.ar-lottery06.com/',
      'Origin': 'https://h5.ar-lottery06.com',
      'ar-origin': 'https://h5.ar-lottery06.com',
      ...headers
    };
    h['Content-Length'] = Buffer.byteLength(body);
    
    const req = https.request({
      hostname: hostname,
      path: path,
      method: 'POST',
      headers: h,
      timeout: 8000
    }, (res) => {
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

// Endpoints to test with correct JWT auth
const endpoints = [
  // Core lottery result endpoints
  { name: 'GetLotteryIssue', params: { TypeId: 30 } },
  { name: 'GetCurrentIssue', params: { TypeId: 30 } },
  { name: 'GetLastIssue', params: { TypeId: 30 } },
  { name: 'GetLastPeriod', params: { TypeId: 30 } },
  { name: 'GetRecentResult', params: { TypeId: 30 } },
  { name: 'GetResult', params: { TypeId: 30 } },
  { name: 'GetResultList', params: { TypeId: 30, pageNo: 1, pageSize: 20 } },
  { name: 'GetHistoryIssue', params: { TypeId: 30, pageNo: 1, pageSize: 10 } },
  { name: 'GetLotteryConfig', params: { TypeId: 30 } },
  { name: 'GetWinGoConfig', params: { TypeId: 30 } },
  
  // User-related (to check what endpoints work)
  { name: 'GetUserInfo', params: {} },
  { name: 'GetMemberInfo', params: {} },
  { name: 'GetUserByToken', params: {} },
];

console.log('\n=== Probing fb999 API Endpoints with Correct JWT ===\n');

(async () => {
  const results = {};
  
  for (const endpoint of endpoints) {
    try {
      const body = JSON.stringify(signParams(endpoint.params));
      console.log(`[${endpoint.name}] POST /api/webapi/${endpoint.name}`);
      const res = await httpPost('fb999api.com', `/api/webapi/${endpoint.name}`, body, {
        Authorization: `Bearer ${JWT}`
      });
      console.log(`  Status: ${res.status}`);
      
      const bodyText = res.body ? res.body.substring(0, 600) : '(empty)';
      console.log(`  Body: ${bodyText}`);
      
      try {
        const json = JSON.parse(res.body);
        results[endpoint.name] = {
          status: res.status,
          code: json.code,
          msg: json.msg,
          data: json.data
        };
        if (json.code === 0) console.log('  *** SUCCESS ***');
      } catch(e) {
        results[endpoint.name] = { status: res.status, body: res.body.substring(0, 300) };
      }
    } catch (e) {
      console.log(`  Error: ${e.message}`);
      results[endpoint.name] = { error: e.message };
    }
    console.log('');
  }
  
  console.log('\n=== SUMMARY ===');
  for (const [name, r] of Object.entries(results)) {
    if (r.code === 0) {
      console.log(`${name}: SUCCESS (code 0)`);
      if (r.data) console.log(`  data:`, JSON.stringify(r.data).substring(0, 200));
    } else if (r.status) {
      console.log(`${name}: HTTP ${r.status}, code ${r.code || 'n/a'}`);
    }
  }
  
  fs.writeFileSync('/tmp/fb999_api_probe_v5.json', JSON.stringify(results, null, 2));
  console.log('\nSaved: /tmp/fb999_api_probe_v5.json');
})();
