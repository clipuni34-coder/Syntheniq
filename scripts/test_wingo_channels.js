#!/usr/bin/env node
'use strict';
const fs = require('fs');
const jwt = require('jsonwebtoken');

// Load login response to get the WebSocket URL and channels
const loginData = JSON.parse(fs.readFileSync('/workspace/app/findings/fb999_login_response.json', 'utf8'));
const wsUrl = loginData.data.webSocketUrl;
const channels = loginData.data.webSocketChannels;
const wsToken = loginData.data.token; // RS256 JWT for WebSocket

// Decode the RS256 WebSocket JWT (different from the HS256 login JWT)
const wsParts = wsToken.split('.');
console.log('=== WebSocket JWT (RS256) ===');
const wsHeader = JSON.parse(Buffer.from(wsParts[0], 'base64').toString());
const wsPayload = JSON.parse(Buffer.from(wsParts[1], 'base64').toString());
console.log('Header:', JSON.stringify(wsHeader, null, 2));
console.log('Payload:', JSON.stringify(wsPayload, null, 2));

console.log('\n=== WebSocket Config ===');
console.log('URL:', wsUrl);
console.log('Channels:', JSON.stringify(channels, null, 2));

// The web app uses channels: /WebApi/1004/userid/364070
// These are AppSync Events API channels with format: /WebApi/<appId>/<path>/<userId>

// For WinGo results, possible channels to try:
// 1. /WebApi/1004/lottery/30/<userId>
// 2. /WebApi/1004/wingo/30/<userId>
// 3. /WebApi/1004/lottery/<userId>
// 4. /WebApi/1004/wingo/<userId>
// 5. /WebApi/1004/<userId>
// 6. /WebApi/1004/lottery/result/<userId>
// 7. /WebApi/1004/winGo/<userId>
// 8. /WebApi/1004/issue/<userId>
// 9. /WebApi/1004/GameBetting/<userId>
// 10. Various wildcard patterns

const userId = channels[0].match(/userid\/(\d+)/)[1];
console.log('\n=== User ID extracted:', userId, '===');

// Parse the WebSocket URL to get event endpoint
const wsMatch = wsUrl.match(/^wss:\/\/([^/]+)\/event\/realtime\?Token=(.+)$/);
const host = wsMatch[1];
const token = wsMatch[2];
const eventEndpoint = `https://${host}/event`;

console.log('Event API endpoint:', eventEndpoint);
console.log('Token (JWT):', token.substring(0, 50) + '...');

// Now test with AppSync Events HTTP endpoint
// The AppSync Events API has an HTTP endpoint for publishing and querying
// POST /event with JSON body for publish/query

async function tryAppSyncEvents(channel) {
  const payload = JSON.stringify({
    channel: channel
  });

  return new Promise((resolve) => {
    const req = require('https').request({
      hostname: host,
      path: '/event',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'Authorization': token,
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(data); } catch {}
        resolve({ channel, status: res.statusCode, body: parsed || data.substring(0, 300) });
      });
    });
    req.on('error', (e) => {
      resolve({ channel, error: e.message });
    });
    req.write(payload);
    req.end();
  });
}

// Also try the WebSocket protocol with subscribe
async function tryWebSocket(channel) {
  return new Promise((resolve) => {
    const WebSocket = require('ws');
    const url = `${wsUrl}`;
    const ws = new WebSocket(url, {
      headers: {
        'Sec-WebSocket-Protocol': 'aws-appsync-events-ws',
      }
    });

    let messages = [];
    let resolved = false;

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        ws.close();
        resolve({ channel, messages, timedOut: true });
      }
    }, 5000);

    ws.on('open', () => {
      // Send connection_init
      ws.send(JSON.stringify({ type: 'connection_init', payload: { authorization: token } }));
    });

    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      messages.push(msg);
      if (msg.type === 'connection_ack' || msg.type === 'subscribed' || msg.type === 'subscribe_success') {
        // Send subscribe message for our channel
        setTimeout(() => {
          ws.send(JSON.stringify({
            type: 'subscribe',
            id: '1',
            payload: { channel: channel, authorization: token }
          }));
        }, 100);
      }
      if (msg.type === 'data' && msg.id === '1') {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeout);
          ws.close();
          resolve({ channel, messages, data: msg });
        }
      }
    });

    ws.on('error', (e) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        resolve({ channel, error: e.message });
      }
    });
  });
}

(async () => {
  console.log('\n=== Testing AppSync Events HTTP endpoint with various channels ===\n');

  const testChannels = [
    `/WebApi/1004/lottery/${userId}`,
    `/WebApi/1004/wingo/${userId}`,
    `/WebApi/1004/lottery/30/${userId}`,
    `/WebApi/1004/wingo/30/${userId}`,
    `/WebApi/1004/${userId}`,
    `/WebApi/1004/lottery/result/${userId}`,
    `/WebApi/1004/winGo/${userId}`,
    `/WebApi/1004/issue/${userId}`,
    `/WebApi/1004/wingo/result/${userId}`,
    `/WebApi/1004/lottery/winning/${userId}`,
    `/WebApi/1004/WinGo/${userId}`,
    `/WebApi/1004/GameBetting/${userId}`,
  ];

  for (const ch of testChannels) {
    const result = await tryAppSyncEvents(ch);
    console.log(`Channel: ${ch}`);
    console.log(`  Status: ${result.status}, Body:`, JSON.stringify(result.body).substring(0, 200));
    console.log();
  }
})().catch(e => console.error(e));
