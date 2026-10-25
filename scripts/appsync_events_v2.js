#!/usr/bin/env node
/**
 * appsync_events_v2.js
 *
 * AppSync Events API v2 — try correct AWS AppSync Events API HTTP format.
 * 
 * AWS AppSync Events API supports two HTTP operations:
 * 1. PutEvents — POST to publish events
 * 2. ListChannels — GET/list channels (newer API)
 *
 * The correct format for /event:
 * POST https://<api-id>.api.graphql.<region>.amazonaws.com/event
 * Content-Type: application/json
 * Authorization: <JWT/API key>
 * 
 * Body for PutEvents:
 * { "events": [ { "payload": {...}, "channel": "..." } ] }
 * 
 * GET for ListChannels:
 * GET /?query={listChannels{...}}
 */

'use strict';
const https = require('https');
const fs = require('fs');

const login = JSON.parse(fs.readFileSync('/tmp/fb999_login_response.json', 'utf8'));
const WS_TOKEN = new URL(login.data?.webSocketUrl).searchParams.get('Token');
const ACCESS_JWT = login.data?.token;

console.log('WS Token:', WS_TOKEN.substring(0, 40) + '...');
console.log('Access JWT:', ACCESS_JWT.substring(0, 40) + '...');

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
  
  // Test 1: Correct PutEvents format with proper serialization
  console.log('\n=== Test 1: PUT events (correct format) ===');
  try {
    const payload = JSON.stringify([]);
    const body = JSON.stringify({
      events: [{
        channel: '/WebApi/1004/lottery/WinGo_30S',
        payload: payload,
        type: 'pubsub'
      }]
    });
    const res = await httpRequest(HOST, '/event', 'POST', body, {
      Authorization: WS_TOKEN,
    });
    console.log('Status:', res.status);
    console.log('Body:', res.body.substring(0, 500));
  } catch(e) { console.log('Error:', e.message); }

  // Test 2: Try with x-amz-content-sha256 signed format (AWS style)
  console.log('\n=== Test 2: AWS SigV4 style headers ===');
  try {
    const body = JSON.stringify({
      query: 'subscription { subscribe(channelName: "/WebApi/1004/lottery/WinGo_30S") { data topic } }'
    });
    const res = await httpRequest(HOST, '/event/graphql', 'POST', body, {
      Authorization: WS_TOKEN,
    });
    console.log('Status:', res.status);
    console.log('Body:', res.body.substring(0, 500));
  } catch(e) { console.log('Error:', e.message); }

  // Test 3: ListChannels via AppSync Events API
  console.log('\n=== Test 3: ListChannels ===');
  try {
    const body = JSON.stringify({
      channels: ['/WebApi/1004/lottery/WinGo_30S'],
      maxEventsPerChannel: 10,
      nextToken: null
    });
    const res = await httpRequest(HOST, '/event', 'POST', body, {
      Authorization: WS_TOKEN,
    });
    console.log('Status:', res.status);
    console.log('Body:', res.body.substring(0, 800));
  } catch(e) { console.log('Error:', e.message); }

  // Test 4: Try AppSync Events subscribe via POST body
  console.log('\n=== Test 4: Subscribe via POST ===');
  try {
    const body = JSON.stringify({
      "operation": "subscribe",
      "channels": ["/WebApi/1004/lottery/WinGo_30S"],
      "payload": {}
    });
    const res = await httpRequest(HOST, '/event', 'POST', body, {
      Authorization: WS_TOKEN,
      'amz-Target': 'AWSSubscriptionServiceLambda.AddEvent',
    });
    console.log('Status:', res.status);
    console.log('Body:', res.body.substring(0, 500));
  } catch(e) { console.log('Error:', e.message); }

  // Test 5: Try with different body formats
  console.log('\n=== Test 5: Various event formats ===');
  const formats = [
    { events: [{ payload: '{}', channel: '/WebApi/1004/lottery/WinGo_30S' }] },
    { event: { channel: '/WebApi/1004/lottery/WinGo_30S', payload: {} } },
    { action: 'subscribe', channel: '/WebApi/1004/lottery/WinGo_30S' },
    { type: 'subscribe', channels: ['/WebApi/1004/lottery/WinGo_30S'] },
  ];
  
  for (const fmt of formats) {
    try {
      const res = await httpRequest(HOST, '/event', 'POST', JSON.stringify(fmt), {
        Authorization: WS_TOKEN,
      });
      const interesting = res.body.includes('WinGo') || res.body.includes('result') || res.body.includes('number') || res.body.includes('errorType');
      console.log(`Status: ${res.status} ${interesting ? '***' : ''} - ${res.body.substring(0, 150)}`);
    } catch(e) { console.log(`Error: ${e.message}`); }
  }

  process.exit(0);
})();
