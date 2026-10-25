#!/usr/bin/env node
/**
 * appsync_publish_test.js
 *
 * The AppSync Events API supports publishing events via WebSocket 'publish' message type.
 * Let's try publishing an event to the WinGo channel to see what response we get.
 * 
 * Also tries the correct event payload format with proper channel naming.
 */

'use strict';
const tls = require('tls');
const fs = require('fs');
const crypto = require('crypto');

const login = JSON.parse(fs.readFileSync('/tmp/fb999_login_response.json', 'utf8'));
const WS_URL = login.data.webSocketUrl;
const WS_TOKEN = new URL(WS_URL).searchParams.get('Token');
const HOST = new URL(WS_URL).hostname;
const PATH = new URL(WS_URL).pathname + new URL(WS_URL).search;

const authObject = { authorization: WS_TOKEN, host: HOST };
const wsKey = crypto.randomBytes(16).toString('base64');
const authBase64 = Buffer.from(JSON.stringify(authObject)).toString('base64url');
const subprotocols = ['aws-appsync-event-ws', 'header-' + authBase64];

console.log('=== AppSync Events Publish Test ===\n');

function maskPayload(dataBuf) {
  const mask = Buffer.from([Math.random()*256|0, Math.random()*256|0, Math.random()*256|0, Math.random()*256|0]);
  const out = Buffer.alloc(dataBuf.length);
  for (let i = 0; i < dataBuf.length; i++) out[i] = dataBuf[i] ^ mask[i % 4];
  return Buffer.concat([mask, out]);
}
function makeTextFrame(payload) {
  const pb = Buffer.from(payload, 'utf8');
  const len = pb.length;
  let hdr;
  if (len < 126) { hdr = Buffer.alloc(2); hdr[0] = 0x81; hdr[1] = len | 0x80; }
  else { hdr = Buffer.alloc(4); hdr[0] = 0x81; hdr[1] = 0x7E | 0x80; hdr.writeUInt16BE(len, 2); }
  return Buffer.concat([hdr, maskPayload(pb)]);
}
function makePong() {
  const mask = Buffer.from([Math.random()*256|0, Math.random()*256|0, Math.random()*256|0, Math.random()*256|0]);
  const hdr = Buffer.alloc(2); hdr[0] = 0x80 | 0xA; hdr[1] = 0x80;
  return Buffer.concat([hdr, mask]);
}

const sent = [];
const recv = [];
const events = [];
let opened = false, gotAck = false;
const startTime = Date.now();

const socket = tls.connect(443, HOST, { rejectUnauthorized: false, servername: HOST }, () => {
  const handshake = [
    'GET ' + PATH + ' HTTP/1.1',
    'Host: ' + HOST,
    'Connection: Upgrade',
    'Upgrade: websocket',
    'Sec-WebSocket-Version: 13',
    'Sec-WebSocket-Key: ' + wsKey,
    'Origin: https://h5.ar-lottery06.com',
    'Sec-WebSocket-Protocol: ' + subprotocols.join(', '),
    'Authorization: ' + WS_TOKEN,
    '', ''
  ].join('\r\n');
  socket.write(handshake);
  console.log('[*] Handshake sent');
});

socket.setNoDelay(true);
let leftover = Buffer.alloc(0);
let headerDone = false;

socket.on('data', (chunk) => {
  leftover = Buffer.concat([leftover, chunk]);
  if (!headerDone) {
    const idx = leftover.indexOf('\r\n\r\n');
    if (idx < 0) return;
    const hsResp = leftover.slice(0, idx).toString();
    headerDone = true;
    if (!hsResp.includes(' 101 ')) {
      console.log('Handshake failed:', hsResp.substring(0, 200));
      socket.end(); process.exit(1);
    }
    console.log('*** 101 OK ***\n');
    opened = true;
    leftover = leftover.slice(idx + 4);
    
    // Send connection_init
    setTimeout(() => {
      const init = JSON.stringify({ type: 'connection_init', payload: authObject });
      socket.write(makeTextFrame(init));
      console.log('-> connection_init');
    }, 50);

    // After ack, try to publish events
    setTimeout(() => {
      if (gotAck) {
        console.log('\n--- Publishing events to discover result channels ---\n');
        
        // Try to get the channel list or discover available channels
        const publishAttempts = [
          // Try querying with empty publish
          { type: 'publish', id: crypto.randomUUID(), channel: '/WebApi/1004/lottery/WinGo_30S', payload: '{}' },
          { type: 'publish', id: crypto.randomUUID(), channel: '/WebApi/1004/lottery/WinGo', payload: '{}' },
          
          // Try querying for result events
          { type: 'query', id: crypto.randomUUID(), channel: '/WebApi/1004/lottery/WinGo_30S' },
          { type: 'query', id: crypto.randomUUID(), channel: '/WebApi/1004/lottery/*' },
          
          // Try listing channels
          { type: 'listChannels', id: crypto.randomUUID() },
          { type: 'subscribe', id: crypto.randomUUID(), channel: '/WebApi/1004/lottery/WinGo_30S' },
          { type: 'subscribe', id: crypto.randomUUID(), channel: '/WebApi/1004/lottery/WinGo_30S/result' },
          { type: 'subscribe', id: crypto.randomUUID(), channel: '/WebApi/1004/lottery/WinGo_30S/openResult' },
          { type: 'subscribe', id: crypto.randomUUID(), channel: '/WebApi/1004/lottery/WinGo_30S/open' },
        ];
        
        let i = 0;
        const iv = setInterval(() => {
          if (i >= publishAttempts.length) { clearInterval(iv); return; }
          const msg = publishAttempts[i++];
          socket.write(makeTextFrame(JSON.stringify(msg)));
          sent.push(msg);
          console.log('-> SEND:', JSON.stringify(msg).substring(0, 200));
        }, 200);
      }
    }, 500);

    // Subscribe to wildcard channels after publishing
    setTimeout(() => {
      const subChannels = [
        '/WebApi/1004/*',
        '/WebApi/1004/lottery/WinGo_30S',
        '/WebApi/1004/lottery/WinGo_30S/*',
        '/WebApi/1004/lottery/WinGo',
        '/WebApi/1004/game/WinGo_30S',
      ];
      let i = 0;
      const iv = setInterval(() => {
        if (i >= subChannels.length) { clearInterval(iv); console.log('\n--- Listening for events ---\n'); return; }
        const ch = subChannels[i++];
        const sub = JSON.stringify({ type: 'subscribe', id: crypto.randomUUID(), channel: ch, authorization: authObject });
        socket.write(makeTextFrame(sub));
        sent.push(sub);
        console.log('-> SUBSCRIBE:', ch);
      }, 200);
    }, 2000);
  }
  
  // Parse frames
  let off = 0;
  while (off < leftover.length) {
    if (off + 2 > leftover.length) break;
    const b0 = leftover[off], b1 = leftover[off + 1];
    const opcode = b0 & 0x0F;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7F;
    let lf = 2;
    if (len === 126) { if (off + 4 > leftover.length) break; len = leftover.readUInt16BE(off + 2); lf = 4; }
    else if (len === 127) { if (off + 10 > leftover.length) break; len = Number(leftover.readBigUInt64BE(BigInt(off + 2))); lf = 10; }
    if (off + lf + (masked ? 4 : 0) + len > leftover.length) break;
    let start = off + lf;
    let text;
    if (masked) {
      const mask = leftover.slice(start, start + 4);
      const data = leftover.slice(start + 4, start + 4 + len);
      for (let j = 0; j < data.length; j++) data[j] ^= mask[j % 4];
      text = data.toString('utf8'); start += 4;
    } else {
      text = leftover.slice(start, start + len).toString('utf8');
    }
    
    if (opcode === 0x9) socket.write(makePong());
    else if (opcode === 0x8) console.log('  [CLOSE]', text.substring(0, 80));
    else if (opcode === 0x1) {
      recv.push(text);
      const elapsed = Date.now() - startTime;
      console.log(`\n[${elapsed}ms] <- RECV: ${text.substring(0, 500)}`);
      
      try {
        const msg = JSON.parse(text);
        if (msg.type === 'connection_ack') { gotAck = true; console.log('  *** ACK ***'); }
        if (msg.type === 'subscribe_success') console.log('  *** SUB_SUCCESS ***');
        if (msg.type === 'subscribe_error') console.log('  *** SUB_ERROR ***:', JSON.stringify(msg).substring(0, 200));
        if (msg.type === 'publish_success') console.log('  *** PUBLISH_SUCCESS ***');
        if (msg.type === 'data') {
          console.log('  *** DATA ***');
          events.push({ elapsed, event: msg.event });
        }
      } catch(e) {}
    }
    off = start + len;
  }
  leftover = leftover.slice(off);
});

socket.on('error', e => console.log('Socket error:', e.message));

setInterval(() => {
  const e = Date.now() - startTime;
  console.log(`[${e}ms] opened=${opened} ack=${gotAck} sent=${sent.length} recv=${recv.length} events=${events.length}`);
}, 5000);

setTimeout(() => {
  console.log('\n=== COMPLETE ===');
  console.log('Opened:', opened, 'Ack:', gotAck);
  console.log('Sent:', sent.length, 'Received:', recv.length, 'Data events:', events.length);
  
  const interesting = events.filter(e => {
    const s = JSON.stringify(e.event || '').toLowerCase();
    return s.includes('win') || s.includes('result') || s.includes('number') || s.includes('issue');
  });
  console.log('Interesting events:', interesting.length);
  
  fs.writeFileSync('/tmp/appsync_publish_test.json', JSON.stringify({
    sent, received: recv, events, interestingEvents: interesting
  }, null, 2));
  console.log('Saved: /tmp/appsync_publish_test.json');
  try { socket.end(); } catch(e) {}
  process.exit(0);
}, 30000);
