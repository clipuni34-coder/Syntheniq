#!/usr/bin/env node
/**
 * appsync_events_http.js
 *
 * AWS AppSync Events API investigation:
 * The AppSync Events API has a hidden HTTP endpoint at /event that accepts POST requests.
 * 
 * The endpoint format is:
 * POST https://pro-v3-payplatform.admin-broadcast.com/event
 * Headers: 
 *   x-amz-user-agent: app
 *   Authorization: <JWT token>
 *   content-type: application/json
 * Body: { "events": [...] }
 *
 * Let's try querying the AppSync Events API for events on the WinGo channels,
 * which might reveal the internal event format and result-pushing mechanism.
 */

'use strict';
const https = require('https');
const fs = require('fs');
const crypto = require('crypto');

const login = JSON.parse(fs.readFileSync('/tmp/fb999_login_response.json', 'utf8'));
const ACCESS_JWT = login.data?.token;
const WS_TOKEN = new URL(login.data?.webSocketUrl).searchParams.get('Token');

console.log('Access JWT:', ACCESS_JWT.substring(0, 40) + '...');
console.log('WS Token (RS256):', WS_TOKEN.substring(0, 40) + '...');

function httpRequest(hostname, path, method, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const h = {
      'Content-Type': 'application/json',
      'Accept': '*/*',
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15',
      'Origin': 'https://h5.ar-lottery06.com',
      'Referer': 'https://h5.ar-lottery06.com/',
      ...headers
    };
    if (body) h['Content-Length'] = Buffer.byteLength(body);
    
    const req = https.request({
      hostname,
      path,
      method,
      headers: h,
      timeout: 10000,
      rejectUnauthorized: false
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    if (body) req.write(body);
    req.end();
  });
}

(async () => {
  const HOST = 'pro-v3-payplatform.admin-broadcast.com';
  
  // Test 1: Try to query events via AppSync Events API
  // The AppSync Events API /event endpoint may support GET queries
  console.log('\n=== Test 1: GET /event (query mode) ===');
  try {
    const res = await httpRequest(HOST, '/event?channel=/WebApi/1004/lottery/WinGo_30S', 'GET', null, {
      Authorization: WS_TOKEN,
    });
    console.log('Status:', res.status);
    console.log('Body:', res.body.substring(0, 500));
  } catch(e) { console.log('Error:', e.message); }

  // Test 2: POST to /event with events query format
  console.log('\n=== Test 2: POST /event (subscribe-style query) ===');
  try {
    const body = JSON.stringify({
      type: 'subscribe',
      channel: '/WebApi/1004/lottery/WinGo_30S'
    });
    const res = await httpRequest(HOST, '/event', 'POST', body, {
      Authorization: WS_TOKEN,
    });
    console.log('Status:', res.status);
    console.log('Body:', res.body.substring(0, 500));
  } catch(e) { console.log('Error:', e.message); }

  // Test 3: Try AppSync Events API query format with "events" param
  console.log('\n=== Test 3: POST /event with events array ===');
  try {
    const body = JSON.stringify({
      events: [{
        channel: '/WebApi/1004/lottery/WinGo_30S',
        type: 'subscribe'
      }]
    });
    const res = await httpRequest(HOST, '/event', 'POST', body, {
      Authorization: WS_TOKEN,
    });
    console.log('Status:', res.status);
    console.log('Body:', res.body.substring(0, 500));
  } catch(e) { console.log('Error:', e.message); }

  // Test 4: Try with channel filter in query params
  console.log('\n=== Test 4: GET /event with channel filter ===');
  try {
    const res = await httpRequest(HOST, '/event?channel=/WebApi/1004/lottery/WinGo_30S&limit=10', 'GET', null, {
      Authorization: WS_TOKEN,
    });
    console.log('Status:', res.status);
    console.log('Body:', res.body.substring(0, 500));
  } catch(e) { console.log('Error:', e.message); }

  // Test 5: Try the AppSync Events API with ListEventRequests format
  console.log('\n=== Test 5: AppSync Events ListEventRequests ===');
  try {
    const body = JSON.stringify({
      query: `mutation { publish(events: [{channel:"/WebApi/1004/lottery/WinGo_30S",payload:"{}"}]) { response { status } } }`
    });
    const res = await httpRequest(HOST, '/event', 'POST', body, {
      Authorization: WS_TOKEN,
    });
    console.log('Status:', res.status);
    console.log('Body:', res.body.substring(0, 500));
  } catch(e) { console.log('Error:', e.message); }

  // Test 6: Try with different channel patterns
  console.log('\n=== Test 6: Channel pattern variations ===');
  const channels = [
    '/WebApi/1004/lottery/WinGo',
    '/WebApi/1004/game/WinGo_30S',
    '/Lottery/WinGo_30S',
    '/WebApi/1004/lottery/WinGo_30S',
    '/WebApi/1004/lottery/WinGo_30S/result',
    '/WebApi/1004/lottery/WinGo_30S/openResult',
  ];
  
  for (const ch of channels) {
    try {
      const res = await httpRequest(HOST, `/event?channel=${encodeURIComponent(ch)}&limit=5`, 'GET', null, {
        Authorization: WS_TOKEN,
      });
      const interesting = res.body && (res.body.includes('WinGo') || res.body.includes('result') || res.body.includes('number'));
      console.log(`${ch}: ${res.status} ${interesting ? '*** INTERESTING ***' : ''} - ${res.body.substring(0, 100)}`);
    } catch(e) { console.log(`${ch}: ERROR - ${e.message}`); }
  }

  process.exit(0);
})();
