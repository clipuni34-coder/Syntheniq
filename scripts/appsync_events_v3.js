#!/usr/bin/env node
/**
 * appsync_events_v3.js
 *
 * Final AppSync Events API HTTP investigation:
 * The correct AWS AppSync Events API PutEvents format requires:
 * - JSON object payload (NOT stringified)
 * - Authorization: Bearer <JWT>
 *
 * Format:
 * POST /event
 * {
 *   "events": [
 *     {
 *       "payload": { ...json object... },
 *       "channel": "/channel/name",
 *       "type": "pubsub"
 *     }
 *   ]
 * }
 *
 * This might allow us to query or publish to channels that deliver result data.
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
  ];
  
  console.log('=== AppSync Events API — Correct Format Tests ===\n');

  // Test 1: GET on /event with proper query string (ListChannels)
  console.log('--- Test 1: GET /event?listChannels ---');
  try {
    const res = await httpRequest(HOST, '/event', 'GET', null, {
      Authorization: WS_TOKEN,
    });
    console.log('Status:', res.status);
    console.log('Body:', res.body.substring(0, 500));
  } catch(e) { console.log('Error:', e.message); }

  // Test 2: Publish events with OBJECT payload (not string)
  console.log('\n--- Test 2: PUT events with object payloads ---');
  for (const ch of channels) {
    try {
      const body = JSON.stringify({
        events: [{
          channel: ch,
          payload: {}  // empty object payload
        }]
      });
      const res = await httpRequest(HOST, '/event', 'POST', body, {
        Authorization: WS_TOKEN,
      });
      console.log(`${ch}: ${res.status} - ${res.body.substring(0, 200)}`);
    } catch(e) { console.log(`${ch}: Error ${e.message}`); }
  }

  // Test 3: Try to read events via GET with channel
  console.log('\n--- Test 3: GET /event with channel param ---');
  for (const ch of channels) {
    try {
      const encoded = encodeURIComponent(ch);
      const res = await httpRequest(HOST, `/event?channel=${encoded}`, 'GET', null, {
        Authorization: WS_TOKEN,
      });
      const interesting = res.body.includes('WinGo') || res.body.includes('result') || res.body.includes('number');
      console.log(`${ch}: ${res.status} ${interesting ? '***INTERESTING***' : ''} - ${res.body.substring(0, 200)}`);
    } catch(e) { console.log(`${ch}: Error ${e.message}`); }
  }

  // Test 4: Try GET with query parameter format (AppSync Events GraphQL-style)
  console.log('\n--- Test 4: GET /event with query ---');
  try {
    const q = `?query=${encodeURIComponent('query { listChannels { items { channel } } }')}`;
    const res = await httpRequest(HOST, `/event${q}`, 'GET', null, {
      Authorization: WS_TOKEN,
      'x-api-key': WS_TOKEN,
    });
    console.log('Status:', res.status);
    console.log('Body:', res.body.substring(0, 500));
  } catch(e) { console.log('Error:', e.message); }

  // Test 5: Try HEAD on /event
  console.log('\n--- Test 5: HEAD /event ---');
  try {
    const res = await httpRequest(HOST, '/event', 'HEAD', null, {
      Authorization: WS_TOKEN,
    });
    console.log('Status:', res.status);
    console.log('Headers:', JSON.stringify(res.headers));
  } catch(e) { console.log('Error:', e.message); }

  // Test 6: Try OPTIONS
  console.log('\n--- Test 6: OPTIONS /event ---');
  try {
    const res = await httpRequest(HOST, '/event', 'OPTIONS', null, {
      Authorization: WS_TOKEN,
    });
    console.log('Status:', res.status);
    console.log('Allowed:', res.headers['allow'] || res.headers['access-control-allow-methods'] || '(none)');
  } catch(e) { console.log('Error:', e.message); }

  process.exit(0);
})();
