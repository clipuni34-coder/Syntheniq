#!/usr/bin/env node
'use strict';
const fs = require('fs');
const jwt = require('jsonwebtoken');

// Load login response
const loginData = JSON.parse(fs.readFileSync('/workspace/app/findings/fb999_login_response.json', 'utf8'));
const wsUrl = loginData.data.webSocketUrl;
const channels = loginData.data.webSocketChannels;
const wsToken = wsUrl.match(/Token=(.+)/)[1];

// Decode the WebSocket JWT
const parts = wsToken.split('.');
const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
console.log('=== WebSocket JWT Payload ===');
console.log('sub:', payload.sub);

// The AppSync Events WebSocket API uses:
// 1. connection_init with authorization token
// 2. subscribe with channel + authorization
// 3. data events as {type: "data", id, payload: {events: [...]}}

const userId = channels[0].match(/userid\/(\d+)/)[1];
console.log('User ID:', userId);

const WebSocket = require('ws');

async function testChannel(channel, timeout = 3000) {
  return new Promise((resolve) => {
    const ws = new WebSocket(wsUrl, {
      headers: { 'Sec-WebSocket-Protocol': 'aws-appsync-events-ws' }
    });
    
    let messages = [];
    let dataEvents = [];
    let resolved = false;

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        ws.close();
        resolve({ channel, messages, dataEvents, timedOut: true });
      }
    }, timeout);

    ws.on('open', () => {
      // Send connection_init
      ws.send(JSON.stringify({
        type: 'connection_init',
        payload: { authorization: wsToken }
      }));
    });

    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { msg = { raw: data.toString() }; }
      messages.push(msg);
      
      if (msg.type === 'connection_ack') {
        // Subscribe to our channel after connection is acknowledged
        setTimeout(() => {
          ws.send(JSON.stringify({
            type: 'subscribe',
            id: 'sub1',
            payload: {
              channel: channel,
              authorization: wsToken,
            }
          }));
        }, 200);
      }
      
      if (msg.type === 'data' || msg.type === 'next' || msg.type === 'subscribed') {
        dataEvents.push(msg);
      }
      
      if (msg.type === 'subscribe_success') {
        // Successfully subscribed - wait for data
        console.log(`  Subscribed to ${channel}`);
      }
    });

    ws.on('error', (e) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        resolve({ channel, error: e.message, messages, dataEvents });
      }
    });
  });
}

async function main() {
  console.log('\n=== Testing WebSocket channels for WinGo results ===\n');
  
  const testChannels = [
    // Native app might use these instead of just /WebApi/1004/userid/<id>
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
    `/WebApi/1004/wingo/history/${userId}`,
    `/WebApi/1004/lottery/issue/${userId}`,
    `/WebApi/1004/wingo/prize/${userId}`,
    `/WebApi/1004/lottery/bet/${userId}`,
    `/WebApi/1004/WinGoResult/${userId}`,
    `/WebApi/1004/WinGo/result/${userId}`,
  ];

  for (const ch of testChannels) {
    process.stderr.write(`.`);
    const result = await testChannel(ch, 2000);
    
    const hasData = result.dataEvents.length > 0;
    const hasSubSuccess = result.messages.some(m => m.type === 'subscribe_success' || m.type === 'subscribed');
    const hasSubError = result.messages.some(m => m.type === 'subscribe_error' || m.type === 'error');
    
    let status;
    if (hasData) status = '*** DATA RECEIVED ***';
    else if (hasSubSuccess && !hasSubError) status = 'subscribed (no data)';
    else if (hasSubError) status = 'subscribed then error';
    else if (result.error) status = `error: ${result.error}`;
    else status = result.timedOut ? 'timeout' : 'unknown';
    
    console.log(`\r${ch}: ${status}`);
    if (hasData) {
      console.log('  DATA EVENTS:', JSON.stringify(result.dataEvents, null, 2).substring(0, 500));
    }
    if (result.messages.length > 0) {
      const interesting = result.messages.filter(m => 
        m.type !== 'connection_ack' && 
        m.type !== 'subscribe_success' && 
        m.type !== 'subscribed'
      );
      if (interesting.length > 0) {
        console.log('  Message types:', interesting.map(m => m.type).join(', '));
      }
    }
  }
  
  console.log('\n=== Done ===');
}

main().catch(e => console.error('Fatal:', e));
