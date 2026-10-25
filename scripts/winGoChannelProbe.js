#!/usr/bin/env node
/**
 * WinGo_30S — Comprehensive WebSocket Channel Format Probe
 *
 * Tests 25+ channel formats to find which ones carry WinGo result push events.
 * Uses raw TLS WebSocket handshake with AppSync Events subprotocol.
 * Based on working patterns from winGoWsAppSync_v2/v6.
 */
const tls = require('tls');
const fs = require('fs');
const crypto = require('crypto');

const loginData = JSON.parse(fs.readFileSync('/tmp/fb999_login_response.json', 'utf8'));
const JWT = loginData.data.token;
const WS_URL = loginData.data.webSocketUrl;
const WS_CHANNELS = loginData.data.webSocketChannels || [];

const wsUrlObj = new URL(WS_URL);
const WS_TOKEN = wsUrlObj.searchParams.get('Token') || JWT;
const HOST = wsUrlObj.hostname;
const PATH = wsUrlObj.pathname + wsUrlObj.search;
const HTTP_HOST = HOST;

// Auth object using WS token (RS256 JWT from URL)
const authObject = { authorization: WS_TOKEN, host: HTTP_HOST };

console.log('=== WinGo Channel Format Probe (v2) ===\n');
console.log('WS URL:', WS_URL.substring(0, 100) + '...');
console.log('WS Token:', WS_TOKEN.substring(0, 50) + '...');
console.log('JWT (access):', JWT.substring(0, 50) + '...');
console.log('Server-provided channels:', JSON.stringify(WS_CHANNELS));

// ---- WebSocket frame helpers ----
function maskPayload(dataBuf) {
  const mask = Buffer.from([(Math.random()*256|0), (Math.random()*256|0), (Math.random()*256|0), (Math.random()*256|0)]);
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
  const mask = Buffer.from([(Math.random()*256|0), (Math.random()*256|0), (Math.random()*256|0), (Math.random()*256|0)]);
  const hdr = Buffer.alloc(2); hdr[0] = 0x80 | 0xA; hdr[1] = 0x80;
  return Buffer.concat([hdr, mask]);
}

// ---- Build 34 channel formats ----
const baseChannels = [];
baseChannels.push('/WebApi/1004/userid/364070');
baseChannels.push('/WebApi/1004/lottery/WinGo_30S');
baseChannels.push('/WebApi/1004/lottery/WinGo_30S/result');
baseChannels.push('/WebApi/1004/lottery/WinGo_30S/open');
baseChannels.push('/WebApi/1004/lottery/WinGo_30S/push');
baseChannels.push('/WebApi/1004/lottery/WinGo_30S/number');
baseChannels.push('/WebApi/1004/lottery/WinGo_30S/numbers');
baseChannels.push('/WebApi/1004/lottery/WinGo_30S/history');
baseChannels.push('/WebApi/1004/game/WinGo_30S');
baseChannels.push('/WebApi/1004/game/WinGo_30S/result');
baseChannels.push('/WebApi/1004/game/WinGo_30S/open');
baseChannels.push('/WebApi/1004/game/WinGo_30S/push');
baseChannels.push('/WebApi/1004/game/WinGo_30S/number');
baseChannels.push('/WebApi/1004/game/WinGo_30S/numbers');
baseChannels.push('/WebApi/1004/game/WinGo_30S/history');
baseChannels.push('/WebApi/1004/lottery/WinGo');
baseChannels.push('/WebApi/1004/game/WinGo');
baseChannels.push('/WebApi/1004/lottery/WinGo/result');
baseChannels.push('/WebApi/1004/game/WinGo/result');
baseChannels.push('/WebApi/1004/lottery/wingos');
baseChannels.push('/WebApi/1004/lottery/Wingo_30s');
baseChannels.push('/WebApi/1004/lottery/WINGO_30S');
baseChannels.push('/WebApi/1004/lottery/WinGo_30S/openLottery');
baseChannels.push('/WebApi/1004/lottery/WinGo_30S/open_lottery');
baseChannels.push('/result/WinGo_30S');
baseChannels.push('/WinGo_30S/result');
baseChannels.push('/WebApi/1004/game/WinGo_30S/openLottery');
baseChannels.push('/WebApi/1004/game/WinGo_30S/number');
baseChannels.push('/WebApi/1004/lottery');
baseChannels.push('/WebApi/1004/lottery/WinGo_30S/issue');
baseChannels.push('/WebApi/1004/game/WinGo_30S/issue');
baseChannels.push('/WebApi/1004/lottery/WinGo_30S/result/list');
baseChannels.push('/WebApi/1004/lottery/WinGo_30S/results');
baseChannels.push('/WebApi/1004/lottery/WinGo_30S/pushResult');

console.log('\n--- Channels to subscribe (' + baseChannels.length + ') ---');
baseChannels.forEach((c, i) => console.log('  [' + (i+1) + '] ' + c));

// ---- State ----
const sent = [], received = [], events = [];
const subResults = {};
let opened = false, gotAck = false, keepaliveCount = 0;
const START_TIME = Date.now();
const RUN_MS = 37000;

// ---- Subprotocols ----
const authBase64 = Buffer.from(JSON.stringify(authObject)).toString('base64url');
const headerSubprotocol = 'header-' + authBase64;
const subprotocols = ['aws-appsync-event-ws', headerSubprotocol];

// ---- WebSocket handshake ----
const wsKey = crypto.randomBytes(16).toString('base64');
const handshake = [
  'GET ' + PATH + ' HTTP/1.1',
  'Host: ' + HOST,
  'Connection: Upgrade',
  'Upgrade: websocket',
  'Sec-WebSocket-Version: 13',
  'Sec-WebSocket-Key: ' + wsKey,
  'Origin: https://h5.ar-lottery01.com',
  'Referer: https://fb999.com/',
  'User-Agent: Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
  'Authorization: ' + WS_TOKEN,
  'Sec-WebSocket-Protocol: ' + subprotocols.join(', '),
  'Accept-Encoding: gzip, deflate, br',
  'Accept-Language: en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7',
  '', ''
].join('\r\n');

let socket;
let leftover = Buffer.alloc(0);
let headerDone = false;

socket = tls.connect(443, HOST, { rejectUnauthorized: false, servername: HOST }, () => {
  console.log('\n[*] TLS connected to', HOST);
  socket.write(handshake);
  console.log('[*] Handshake sent');
});
socket.setNoDelay(true);

socket.on('data', (chunk) => {
  leftover = Buffer.concat([leftover, chunk]);
  if (!headerDone) {
    console.log('[*] Raw data chunk (' + chunk.length + ' bytes):', chunk.slice(0, 100).toString('utf8').substring(0, 100));
    const idx = leftover.indexOf('\r\n\r\n');
    if (idx < 0) return;
    const hsResponse = leftover.slice(0, idx).toString();
    headerDone = true;
    const is101 = hsResponse.includes(' 101 ');
    console.log('\n--- Handshake Response ---');
    console.log(hsResponse.substring(0, 500));
    if (!is101) {
      console.error('WebSocket handshake FAILED — not 101');
      process.exit(1);
    }
    const echoedProto = hsResponse.split('\r\n').find(l => l.toLowerCase().startsWith('sec-websocket-protocol'));
    console.log('\n*** WS 101 OK — Connection Upgraded ***');
    if (echoedProto) console.log('Selected subprotocol:', echoedProto.split(':')[1].trim());
    opened = true;
    leftover = leftover.slice(idx + 4);
    handleWebSocketFrames();

    // Send connection_init IMMEDIATELY after handshake
    setTimeout(() => {
      const initMsg = JSON.stringify({ type: 'connection_init', payload: authObject });
      socket.write(makeTextFrame(initMsg));
      sent.push(initMsg);
      console.log('-> SENT: connection_init (with WS token auth payload)');
    }, 50);
    return;
  }
  handleWebSocketFrames();
});

function handleWebSocketFrames() {
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
    if (opcode === 0x9) { console.log('  <- PING, sending PONG'); socket.write(makePong()); }
    else if (opcode === 0xA) { /* pong */ }
    else if (opcode === 0x8) { console.log('  [CLOSE]', text.substring(0, 100)); }
    else if (opcode === 0x1) {
      received.push(text);
      const ts = new Date().toISOString().substring(11, 19);
      const elapsed = Date.now() - START_TIME;
      console.log(`\n[${ts}] (+${elapsed}ms) <- RECV: ${text.substring(0, 800)}`);
      try {
        const msg = JSON.parse(text);
        if (msg.type === 'connection_ack') {
          gotAck = true;
          console.log('  *** CONNECTION_ACK ***');
          // Start subscribing after ack
          setTimeout(subscribeToAll, 100);
        }
        if (msg.type === 'subscribe_success') {
          console.log('  *** SUBSCRIBE_SUCCESS ***');
          // Track which channel was accepted
          const sub = sent.find(s => { try { return JSON.parse(s).id === msg.id } catch(e) { return false } });
          if (sub) { const parsed = JSON.parse(sub); subResults[parsed.channel] = { accepted: true, id: msg.id }; }
        }
        if (msg.type === 'subscribe_error') {
          console.log('  *** SUBSCRIBE_ERROR ***:', JSON.stringify(msg.errors || msg).substring(0, 300));
          const sub = sent.find(s => { try { return JSON.parse(s).id === msg.id } catch(e) { return false } });
          if (sub) { const parsed = JSON.parse(sub); subResults[parsed.channel] = { accepted: false, error: JSON.stringify(msg.errors || msg).substring(0, 200), id: msg.id }; }
        }
        if (msg.type === 'data') {
          console.log('  *** DATA EVENT ***');
          console.log('  id:', msg.id);
          console.log('  event:', JSON.stringify(msg.event).substring(0, 500));
          events.push({ ts, elapsedMs: elapsed, id: msg.id, event: msg.event });
        }
        if (msg.type === 'ka' || msg.type === 'ping' || text === 'ka') { keepaliveCount++; }
        if (msg.type === 'error' || msg.type === 'connection_error' || msg.errors) {
          console.log('  *** ERROR ***:', JSON.stringify(msg.errors || msg).substring(0, 300));
        }
      } catch(e) {
        if (text === 'ka' || text === 'ka\n') { keepaliveCount++; console.log('  <- Keepalive (ka)'); }
      }
    }
    off = start + len;
  }
  leftover = leftover.slice(off);
}

socket.on('error', (e) => console.log('Socket error:', e.message));

function subscribeToAll() {
  console.log('\n--- Subscribing to all ' + baseChannels.length + ' channels ---');
  let idx = 0;
  const subInterval = setInterval(() => {
    if (idx >= baseChannels.length) {
      clearInterval(subInterval);
      console.log('\n--- All subscriptions sent, listening... ---\n');
      return;
    }
    const channel = baseChannels[idx++];
    const subMsg = JSON.stringify({
      type: 'subscribe',
      id: crypto.randomUUID(),
      channel: channel,
      authorization: authObject
    });
    socket.write(makeTextFrame(subMsg));
    sent.push(subMsg);
    console.log('-> SUBSCRIBE [' + idx + '/' + baseChannels.length + ']:', channel);
  }, 20);
}

// Periodic status
const statusInterval = setInterval(() => {
  const elapsed = Date.now() - START_TIME;
  const accepted = Object.entries(subResults).filter(([_, v]) => v.accepted).length;
  const rejected = Object.entries(subResults).filter(([_, v]) => !v.accepted).length;
  console.log(`[${elapsed}ms] Status: opened=${opened}, ack=${gotAck}, sent=${sent.length}, recv=${received.length}, ack=${keepaliveCount}, accepted=${accepted}, rejected=${rejected}`);
}, 5000);

// Final close after 37 seconds
setTimeout(() => {
  clearInterval(statusInterval);
  console.log('\n\n=== SESSION COMPLETE ===');
  console.log('Opened:', opened);
  console.log('Connection ACK:', gotAck);
  console.log('Total sent:', sent.length);
  console.log('Total received:', received.length);
  console.log('Data events:', events.length);
  console.log('Keepalives:', keepaliveCount);

  console.log('\n--- Subscription Results ---');
  console.log('Accepted (' + Object.entries(subResults).filter(([_, v]) => v.accepted).length + '):');
  Object.entries(subResults).filter(([_, v]) => v.accepted).forEach(([ch]) => console.log('  ✓ ' + ch));
  console.log('Rejected (' + Object.entries(subResults).filter(([_, v]) => !v.accepted).length + '):');
  Object.entries(subResults).filter(([_, v]) => !v.accepted).forEach(([ch, v]) => console.log('  ✗ ' + ch + ' — ' + v.error));
  const noResp = baseChannels.filter(c => !subResults[c]);
  if (noResp.length) {
    console.log('No response (' + noResp.length + ' channels)');
    noResp.forEach(c => console.log('  ? ' + c));
  }

  // WinGo result data analysis
  console.log('\n--- WinGo Result Data Analysis ---');
  const wingoData = received.filter(m => {
    const l = m.toLowerCase();
    return l.includes('wingo') && (l.includes('result') || l.includes('open') || l.includes('number') || l.includes('issue') || l.includes('data'));
  });
  console.log('Messages mentioning WinGo + result keywords:', wingoData.length);

  const dataEventsWithWinGo = events.filter(e => {
    const ev = JSON.stringify(e.event || '').toLowerCase();
    return ev.includes('wingo') || ev.includes('winguo') || ev.includes('30s');
  });
  console.log('Data events with WinGo content:', dataEventsWithWinGo.length);
  dataEventsWithWinGo.forEach(e => {
    console.log('  Event [' + e.id + ']:', JSON.stringify(e.event).substring(0, 500));
  });

  const result = {
    timestamp: new Date().toISOString(),
    connectionSuccess: opened,
    connectionAck: gotAck,
    wsTokenUsed: WS_TOKEN.substring(0, 50) + '...',
    jwtUsed: JWT.substring(0, 50) + '...',
    wsUrl: WS_URL,
    host: HOST,
    path: PATH,
    subprotocols,
    channelsTested: baseChannels,
    channelCount: baseChannels.length,
    subscriptionsSent: sent.length,
    messagesReceived: received.length,
    subscriptionResults: subResults,
    acceptedChannels: Object.entries(subResults).filter(([_, v]) => v.accepted).map(([ch]) => ch),
    rejectedChannels: Object.entries(subResults).filter(([_, v]) => !v.accepted).map(([ch, v]) => ({ channel: ch, error: v.error })),
    dataEvents: events,
    winGoResultMessages: wingoData,
    allReceivedMessages: received,
    allSentMessages: sent,
  };

  fs.writeFileSync('/tmp/wingo_channel_probe_detailed.json', JSON.stringify(result, null, 2));
  fs.writeFileSync('/tmp/wingo_channel_probe_summary.json', JSON.stringify({
    success: opened && gotAck,
    totalChannels: baseChannels.length,
    acceptedChannels: result.acceptedChannels,
    rejectedChannels: result.rejectedChannels,
    dataEvents: result.dataEvents,
    summary: 'Tested ' + baseChannels.length + ' channels. ' + result.acceptedChannels.length + ' accepted. ' + result.dataEvents.length + ' data events received.'
  }, null, 2));
  console.log('\nResults saved to:');
  console.log('  /tmp/wingo_channel_probe_detailed.json');
  console.log('  /tmp/wingo_channel_probe_summary.json');

  try { socket.end(); } catch(e) {}
  process.exit(0);
}, RUN_MS);
