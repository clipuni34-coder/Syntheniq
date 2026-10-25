#!/usr/bin/env node
/**
 * appsync_deep_probe.js
 *
 * Since wildcard subscriptions to /WebApi/1004/* work but WinGo results aren't
 * published there, the results must use a DIFFERENT channel namespace.
 *
 * From the bundle analysis, the result-fetching paths include:
 *   - WinGoGetWinTheLotteryResult
 *   - GetWinTheLotteryResult  
 *   - GetLastFiveIssueNumberResult
 *
 * Let's try result-related channel patterns:
 *   - /Result/* 
 *   - /Lottery/*
 *   - /OpenResult/*
 *   - /gameResult/*
 *   - /lotteryResult/*
 *   - /draw/*
 *   - /publish/*
 *   - /broadcast/*
 *   - /*
 *
 * And also the exact patterns that might match the result-publishing namespace.
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

console.log('=== AppSync Events Deep Channel Probe ===\n');

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

const sent = [];
const recv = [];
const events = [];
let opened = false, gotAck = false;
const startTime = Date.now();

// Try a wider range of channel patterns
const channels = [
  // Known working
  '/WebApi/1004/lottery/WinGo',
  '/WebApi/1004/lottery/WinGo_30S',
  
  // Result-related patterns
  '/Result/*',
  '/Result/Lottery/*',
  '/Result/WinGo_30S',
  '/Lottery/Result/*',
  '/Lottery/WinGo/*',
  
  // Game-related patterns
  '/game/WinGo_30S/*',
  '/Game/WinGo/*',
  '/Game/Result/*',
  
  // Publish/broadcast patterns
  '/publish/WinGo_30S',
  '/publish/lottery/*',
  '/broadcast/*',
  
  // Draw-related patterns
  '/draw/WinGo_30S',
  '/draw/result/*',
  '/draw/lottery/*',
  
  // WinGo-specific result patterns
  '/WinGo/*',
  '/WinGo/Result/*',
  '/WinGo_30S/*',
  '/WinGo_30S/Result',
  '/WinGo/30S/Result',
  
  // Alternative API patterns
  '/api/WinGo/*',
  '/api/lottery/*',
  
  // Number/result patterns
  '/number/WinGo_30S',
  '/number/*',
  '/openResult/*',
  '/open/*',
  
  // Broad wildcards
  '/*',
  '/WebApi/*',
  '/WebApi/1004/lottery/*',
  
  // TRX-style
  '/TrxWingo/*',
  '/trxWingo/*',
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
  console.log('[*] Handshake sent, waiting for 101...');
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
      process.exit(1);
    }
    console.log('*** 101 OK ***');
    opened = true;
    leftover = leftover.slice(idx + 4);
    
    setTimeout(() => {
      const init = JSON.stringify({ type: 'connection_init', payload: authObject });
      socket.write(makeTextFrame(init));
      console.log('-> connection_init');
    }, 50);

    setTimeout(() => {
      console.log('\n--- Subscribing to', channels.length, 'channels ---\n');
      let i = 0;
      const iv = setInterval(() => {
        if (i >= channels.length) { clearInterval(iv); return; }
        const ch = channels[i++];
        const sub = JSON.stringify({ type: 'subscribe', id: crypto.randomUUID(), channel: ch, authorization: authObject });
        socket.write(makeTextFrame(sub));
        sent.push(sub);
        console.log('-> SUBSCRIBE:', ch);
      }, 50);
      
      // After all subs sent, listen for results
      setTimeout(() => {
        console.log('\n--- Listening for data events ---\n');
      }, channels.length * 50 + 200);
    }, 300);
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
      for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
      text = data.toString('utf8'); start += 4;
    } else {
      text = leftover.slice(start, start + len).toString('utf8');
    }
    
    if (opcode === 0x9) socket.write(makePong());
    else if (opcode === 0x8) console.log('  [CLOSE]', text.substring(0, 100));
    else if (opcode === 0x1) {
      recv.push(text);
      const ts = new Date().toISOString().substring(11, 19);
      const elapsed = Date.now() - startTime;
      
      try {
        const msg = JSON.parse(text);
        if (msg.type === 'connection_ack') { gotAck = true; console.log('  *** CONNECTION_ACK ***'); }
        if (msg.type === 'subscribe_success') console.log('  *** SUBSCRIBE_SUCCESS:', msg.channel || '(no channel field)');
        if (msg.type === 'subscribe_error') console.log('  *** SUBSCRIBE_ERROR ***:', msg.channel || JSON.stringify(msg).substring(0, 200));
        if (msg.type === 'data') {
          console.log(`\n[${elapsed}ms] *** DATA EVENT *** id=${msg.id}`);
          console.log('  event:', JSON.stringify(msg.event).substring(0, 500));
          events.push({ elapsed, id: msg.id, event: msg.event });
          
          const evStr = JSON.stringify(msg.event || '').toLowerCase();
          if (evStr.includes('win') || evStr.includes('result') || evStr.includes('number') || evStr.includes('issue') || evStr.includes('open')) {
            console.log('  *** INTERESTING DATA EVENT ***');
          }
        }
      } catch(e) {
        if (text === 'ka' || text === 'ka\n') console.log('  <- keepalive');
      }
      off = start + len;
    } else {
      off = start + len;
    }
  }
   leftover = leftover.slice(off);
});

socket.on('error', e => console.log('Socket error:', e.message));

const statusIv = setInterval(() => {
  const elapsed = Date.now() - startTime;
  console.log(`[${elapsed}ms] opened=${opened} ack=${gotAck} sent=${sent.length} recv=${recv.length} dataEvents=${events.length}`);
}, 5000);

setTimeout(() => {
  clearInterval(statusIv);
  console.log('\n=== SESSION COMPLETE ===');
  console.log('Opened:', opened, '| Ack:', gotAck);
  console.log('Sent:', sent.length, '| Received:', recv.length, '| Data events:', events.length);
  
  const interesting = events.filter(e => {
    const s = JSON.stringify(e.event || '').toLowerCase();
    return s.includes('win') || s.includes('result') || s.includes('number') || s.includes('issue');
  });
  console.log('\nInteresting data events:', interesting.length);
  
  fs.writeFileSync('/tmp/wingo_deep_probe.json', JSON.stringify({
    totalSent: sent.length,
    totalReceived: recv.length,
    opened: opened,
    ack: gotAck,
    channelsTested: channels,
    dataEvents: events,
    interestingEvents: interesting,
    allReceived: recv
  }, null, 2));
  console.log('Saved: /tmp/wingo_deep_probe.json');
  try { socket.end(); } catch(e) {}
  process.exit(0);
}, 40000);
