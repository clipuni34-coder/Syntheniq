#!/usr/bin/env node
/**
 * appsync_events_v4.js
 *
 * Correct AppSync Events API HTTP format:
 * The payload field MUST be a string (JSON stringified), e.g. "payload":"{}".
 * 
 * This is the PutEvents operation — publishes an event to a channel.
 * We'll try publishing and see if any response echoes back channel activity.
 * 
 * We'll also try the /event/realtime path that's used for WebSocket.
 */

'use strict';
const https = require('https');
const fs = require('fs');

const login = JSON.parse(fs.readFileSync('/tmp/fb999_login_response.json', 'utf8'));
const WS_TOKEN = new URL(login.data?.webSocketUrl).searchParams.get('Token');

function httpRequest(hostname, path, method, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const h = {
      'Content-Type': 'application/json',
      'Accept': '*/*',
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15',
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
  const channels = [
    '/WebApi/1004/lottery/WinGo_30S',
    '/WebApi/1004/lottery/WinGo',
    '/WebApi/1004/userid/364070',
    '/WebApi/1004/lottery/WinGo_30S/result',
  ];

  console.log('=== AppSync Events API — Corrected String Payload Format ===\n');

  // Test 1: POST /event with correct STRING payload format
  console.log('--- Test 1: POST /event with stringified payloads ---');
  for (const ch of channels) {
    try {
      const body = JSON.stringify({
        events: [{
          channel: ch,
          payload: '{}',
        }]
      });
      const res = await httpRequest(HOST, '/event', 'POST', body, {
        Authorization: WS_TOKEN,
      });
      const interesting = res.body.includes('WinGo') || res.body.includes('result') || res.body.includes('number') || res.body.includes('data');
      console.log(`${ch}: ${res.status} ${interesting ? '***INTERESTING***' : ''}`);
      console.log(`  ${res.body.substring(0, 200)}`);
    } catch(e) { console.log(`${ch}: Error ${e.message}`); }
  }

  // Test 2: Try /event/realtime HTTP path
  console.log('\n--- Test 2: POST /event/realtime ---');
  try {
    const body = JSON.stringify({
      events: [{ channel: '/WebApi/1004/lottery/WinGo_30S', payload: '{}' }]
    });
    const res = await httpRequest(HOST, '/event/realtime', 'POST', body, { Authorization: WS_TOKEN });
    console.log(`Status: ${res.status}`);
    console.log(`Body: ${res.body.substring(0, 300)}`);
  } catch(e) { console.log('Error:', e.message); }

  // Test 3: Try with x-amz-target header (AppSync Events specific)
  console.log('\n--- Test 3: POST /event with x-amz-target ---');
  try {
    const body = JSON.stringify({
      events: [{ channel: '/WebApi/1004/lottery/WinGo_30S', payload: '{}' }]
    });
    const res = await httpRequest(HOST, '/event', 'POST', body, {
      Authorization: WS_TOKEN,
      'x-amz-target': 'EventBridge.PutEvents',
      'x-amz-content-sha256': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    });
    console.log(`Status: ${res.status}`);
    console.log(`Body: ${res.body.substring(0, 300)}`);
  } catch(e) { console.log('Error:', e.message); }

  // Test 4: Try with access token (not WS token)
  console.log('\n--- Test 4: POST /event with access JWT ---');
  try {
    const body = JSON.stringify({
      events: [{ channel: '/WebApi/1004/lottery/WinGo_30S', payload: '{}' }]
    });
    const res = await httpRequest(HOST, '/event', 'POST', body, {
      Authorization: `Bearer ${login.data?.token}`,
    });
    console.log(`Status: ${res.status}`);
    console.log(`Body: ${res.body.substring(0, 300)}`);
  } catch(e) { console.log('Error:', e.message); }

  process.exit(0);
})();
