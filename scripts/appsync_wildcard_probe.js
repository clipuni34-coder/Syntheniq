#!/usr/bin/env node
/**
 * appsync_wildcard_probe.js
 *
 * AWS AppSync Events API supports WILDCARD subscriptions: namespace/channel/*
 * This could catch result events even if we don't know the exact channel path.
 *
 * From AWS docs: "Clients can subscribe to a group of related channels using a
 * wildcard syntax (e.g., "namespace/channel/*")"
 *
 * We'll try:
 * 1. Wildcard subscription to the entire namespace: /WebApi/1004/*
 * 2. Wildcard subscription to /WebApi/1004/lottery/*
 * 3. Wildcard subscription to /WebApi/1004/game/*
 * 4. Wildcard subscription to /WebApi/1004/userid/*
 */

const tls = require('tls');
const fs = require('fs');
const crypto = require('crypto');

const loginData = JSON.parse(fs.readFileSync('/tmp/fb999_login_response.json', 'utf8'));
const WS_URL = loginData.data.webSocketUrl;
const WS_TOKEN = new URL(WS_URL).searchParams.get('Token');
const HOST = new URL(WS_URL).hostname;
const PATH = new URL(WS_URL).pathname + new URL(WS_URL).search;

const authObject = { authorization: WS_TOKEN, host: HOST };
const wsKey = crypto.randomBytes(16).toString('base64');
const authBase64 = Buffer.from(JSON.stringify(authObject)).toString('base64url');
const subprotocols = ['aws-appsync-event-ws', 'header-' + authBase64];

console.log('=== AppSync Events Wildcard Channel Probe ===\n');
console.log('Host:', HOST);
console.log('Subprotocols:', subprotocols.length);

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
  else if (len < 65536) { hdr = Buffer.alloc(4); hdr[0] = 0x81; hdr[1] = 0x7E | 0x80; hdr.writeUInt16BE(len, 2); }
  else { hdr = Buffer.alloc(10); hdr[0] = 0x81; hdr[1] = 0x7F | 0x80; hdr.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([hdr, maskPayload(pb)]);
}

function makePong() {
  const mask = Buffer.from([Math.random()*256|0, Math.random()*256|0, Math.random()*256|0, Math.random()*256|0]);
  const hdr = Buffer.alloc(2); hdr[0] = 0x80 | 0xA; hdr[1] = 0x80;
  return Buffer.concat([hdr, mask]);
}

function parseFrames(buf, callback) {
  let off = 0;
  while (off < buf.length) {
    if (off + 2 > buf.length) break;
    const b0 = buf[off], b1 = buf[off + 1];
    const opcode = b0 & 0x0F;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7F;
    let lf = 2;
    if (len === 126) { if (off + 4 > buf.length) break; len = buf.readUInt16BE(off + 2); lf = 4; }
    else if (len === 127) { if (off + 10 > buf.length) break; len = Number(buf.readBigUInt64BE(BigInt(off + 2))); lf = 10; }
    if (off + lf + (masked ? 4 : 0) + len > buf.length) break;
    let start = off + lf;
    let text;
    if (masked) {
      const mask = buf.slice(start, start + 4);
      const data = buf.slice(start + 4, start + 4 + len);
      for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
      text = data.toString('utf8'); start += 4;
    } else {
      text = buf.slice(start, start + len).toString('utf8');
    }
    
    if (opcode === 0x9) { socket.write(makePong()); console.log('  <- PING -> PONG'); }
    else if (opcode === 0x8) console.log('  [CLOSE]', text.substring(0, 100));
    else if (opcode === 0x1) { callback(text); }
    
    off = start + len;
  }
  return off;
}

const sent = [];
const recv = [];
const events = [];
let opened = false, gotAck = false;
const startTime = Date.now();

const wildcardChannels = [
  '/WebApi/1004/*',
  '/WebApi/1004/lottery/*',
  '/WebApi/1004/game/*',
  '/WebApi/1004/userid/*',
  '/WebApi/1004/lottery/WinGo_30S/*',
  '/WebApi/1004/game/WinGo_30S/*',
  '/Lottery/*',
  '/WebApi/1004/lottery/WinGo_30S',
  '/WebApi/1004/lottery/WinGo_30S/result',
  '/WebApi/1004/lottery/WinGo',
  '/WebApi/1004/userid/364070',
];

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
  console.log('\n[*] Handshake sent');
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
      socket.end();
      return;
    }
    console.log('*** 101 OK ***\n');
    opened = true;
    leftover = leftover.slice(idx + 4);
    
    // Send connection_init
    setTimeout(() => {
      const init = JSON.stringify({ type: 'connection_init', payload: authObject });
      socket.write(makeTextFrame(init));
      sent.push(init);
      console.log('-> connection_init');
    }, 50);

    // Subscribe to all channels after ack
    setTimeout(() => {
      if (!gotAck) {
        console.log('No ack received yet, sending anyway...');
      }
      let i = 0;
      const iv = setInterval(() => {
        if (i >= wildcardChannels.length) {
          clearInterval(iv);
          console.log('\n--- All subscriptions sent, listening for ' + (37 - (Date.now()-startTime)/1000) + 's ---');
          return;
        }
        const ch = wildcardChannels[i++];
        const sub = JSON.stringify({ type: 'subscribe', id: crypto.randomUUID(), channel: ch, authorization: authObject });
        socket.write(makeTextFrame(sub));
        sent.push(sub);
        console.log('-> SUBSCRIBE:', ch);
      }, 30);
    }, 300);
  }
  
  const consumed = parseFrames(leftover, (text) => {
    recv.push(text);
    const ts = new Date().toISOString().substring(11, 19);
    const elapsed = Date.now() - startTime;
    console.log(`\n[${ts}] (+${elapsed}ms) <- RECV (${text.length}b):`);
    console.log(text.substring(0, 800));
    
    try {
      const msg = JSON.parse(text);
      if (msg.type === 'connection_ack') { gotAck = true; console.log('  *** CONNECTION_ACK ***'); }
      if (msg.type === 'subscribe_success') console.log('  *** SUBSCRIBE_SUCCESS ***');
      if (msg.type === 'subscribe_error') console.log('  *** SUBSCRIBE_ERROR ***:', JSON.stringify(msg).substring(0, 200));
      if (msg.type === 'data') {
        console.log('  *** DATA EVENT ***');
        console.log('  id:', msg.id);
        console.log('  event:', JSON.stringify(msg.event).substring(0, 500));
        events.push({ elapsed, id: msg.id, event: msg.event });
      }
    } catch(e) {}
  });
  leftover = leftover.slice(consumed);
});

socket.on('error', e => console.log('Socket error:', e.message));

// Status every 5 seconds
const statusIv = setInterval(() => {
  const elapsed = Date.now() - startTime;
  console.log(`[${elapsed}ms] opened=${opened} ack=${gotAck} sent=${sent.length} recv=${recv.length} dataEvents=${events.length}`);
}, 5000);

// End after 37 seconds
setTimeout(() => {
  clearInterval(statusIv);
  console.log('\n=== SESSION COMPLETE ===');
  console.log('Opened:', opened, '| Ack:', gotAck);
  console.log('Sent:', sent.length, '| Received:', recv.length, '| Data events:', events.length);
  
  console.log('\n--- Data Events ---');
  events.forEach(e => {
    console.log(`[${e.elapsed}ms] id=${e.id}:`, JSON.stringify(e.event).substring(0, 300));
  });
  
  const wingoMsgs = recv.filter(m => m.toLowerCase().includes('wingo') || m.toLowerCase().includes('result'));
  console.log('\nMessages mentioning WinGo/result:', wingoMsgs.length);
  
  const result = {
    success: opened && gotAck,
    channelsTested: wildcardChannels,
    sentCount: sent.length,
    receivedCount: recv.length,
    dataEvents: events,
    wingoMessages: wingoMsgs,
    allReceived: recv
  };
  
  fs.writeFileSync('/tmp/wingo_wildcard_probe.json', JSON.stringify(result, null, 2));
  console.log('\nSaved: /tmp/wingo_wildcard_probe.json');
  
  try { socket.end(); } catch(e) {}
  process.exit(0);
}, 37000);
