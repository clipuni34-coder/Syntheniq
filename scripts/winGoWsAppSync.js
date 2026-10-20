#!/usr/bin/env node
/**
 * WinGo_30S — AppSync Events WebSocket Client (Early Result Capture)
 *
 * Implements the correct AWS AppSync Events WebSocket protocol:
 *   1. Handshake with subprotocols: aws-appsync-event-ws, header-<base64url(auth)>
 *   2. Send connection_init
 *   3. Subscribe to WinGo result channels
 *
 * Auth object format (Cognito/OIDC):
 *   {"authorization": "<JWT>", "host": "<HTTP endpoint>"}
 *
 * Channels to subscribe to:
 *   - /WebApi/1004/userid/364070  (user-specific)
 *   - /WebApi/1004/lottery/WinGo_30S
 *   - /WebApi/1004/lottery/WinGo
 *
 * Goal: Capture result PUSH earlier than the ~2.4s HTTP polling limit.
 */

const tls = require('tls');
const fs = require('fs');
const crypto = require('crypto');

// Load fresh JWT from login response
const loginData = JSON.parse(fs.readFileSync('/tmp/fb999_login_response.json', 'utf8'));
const JWT = loginData.data.token;
const WS_URL = loginData.data.webSocketUrl;
const WS_CHANNELS = loginData.data.webSocketChannels || [];

console.log('=== WinGo_30S — AppSync Events WebSocket Client ===\n');
console.log('JWT:', JWT?.substring(0, 40) + '...' || '(none from login response)');
console.log('WS URL:', WS_URL?.substring(0, 80) + '...' || '(none)');
console.log('WS Channels:', JSON.stringify(WS_CHANNELS));

if (!JWT || !WS_URL) {
  console.error('ERROR: Missing JWT or WebSocket URL. Run refreshJwt.js first.');
  process.exit(1);
}

// Parse WebSocket URL
const wsUrl = new URL(WS_URL);
const HOST = wsUrl.hostname;  // pro-v3-payplatform.admin-broadcast.com
const PATH = wsUrl.pathname + wsUrl.search;

// The HTTP API endpoint for AppSync auth (host field in auth object)
// Based on AWS docs, this is the AppSync Events HTTP endpoint
// For custom domains (our case), it's the same domain with /event
const HTTP_HOST = HOST;  // pro-v3-payplatform.admin-broadcast.com

// Auth object per AWS AppSync Events protocol (Cognito/OIDC mode)
const authObject = {
  authorization: JWT,
  host: HTTP_HOST
};

// Create the header subprotocol
const authBase64 = Buffer.from(JSON.stringify(authObject)).toString('base64url');
const headerSubprotocol = 'header-' + authBase64;

// Subprotocols array (order matters - aws-appsync-event-ws first)
const subprotocols = ['aws-appsync-event-ws', headerSubprotocol];

console.log('\n--- WebSocket Configuration ---');
console.log('Host:', HOST);
console.log('Path:', PATH.substring(0, 60) + '...');
console.log('HTTP host for auth:', HTTP_HOST);
console.log('Subprotocols:', JSON.stringify(subprotocols));
console.log('Auth object:', JSON.stringify({authorization: JWT.substring(0, 20) + '...', host: HTTP_HOST}));

// WebSocket frame helpers
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
  if (len < 126) {
    hdr = Buffer.alloc(2);
    hdr[0] = 0x81;
    hdr[1] = len | 0x80;
  } else if (len < 65536) {
    hdr = Buffer.alloc(4);
    hdr[0] = 0x81;
    hdr[1] = 0x7E | 0x80;
    hdr.writeUInt16BE(len, 2);
  } else {
    hdr = Buffer.alloc(10);
    hdr[0] = 0x81;
    hdr[1] = 0x7F | 0x80;
    hdr.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([hdr, maskPayload(pb)]);
}

function makePong(payloadBuf = Buffer.alloc(0)) {
  return makeControlFrame(0xA, payloadBuf);
}

function makeControlFrame(opcode, payloadBuf) {
  const mask = Buffer.from([(Math.random()*256|0), (Math.random()*256|0), (Math.random()*256|0), (Math.random()*256|0)]);
  const out = Buffer.alloc(payloadBuf.length);
  for (let i = 0; i < payloadBuf.length; i++) out[i] = payloadBuf[i] ^ mask[i % 4];
  const len = payloadBuf.length;
  const hdr = Buffer.alloc(len > 125 ? 4 : 2);
  hdr[0] = 0x80 | opcode;
  let sz = 2;
  if (len < 126) {
    hdr[1] = len | 0x80;
  } else if (len < 65536) {
    hdr[1] = 0x7E | 0x80;
    hdr.writeUInt16BE(len, 2);
    sz = 4;
  } else {
    hdr[1] = 0x7F | 0x80;
    hdr.writeBigUInt64BE(BigBigInt(len), 2);
    sz = 10;
  }
  return Buffer.concat([hdr, mask, out]);
}

// WebSocket handshake
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
  'Sec-WebSocket-Protocol: ' + subprotocols.join(', '),
  'Accept-Encoding: gzip, deflate, br',
  'Accept-Language: en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7',
  '', ''
].join('\r\n');

console.log('\n--- Connecting to AppSync Events WebSocket ---');
console.log('Handshake headers:', handshake.replace(/\r\n/g, '\n  ').substring(0, 400));

let socket;
let leftover = Buffer.alloc(0);
let headerDone = false;
let opened = false;
let gotAck = false;
let sent = [];
let received = [];
const startTime = Date.now();

const connectStart = Date.now();

socket = tls.connect(443, HOST, { rejectUnauthorized: false, servername: HOST }, () => {
  console.log('[*] TLS connected to', HOST);
  socket.write(handshake);
});
socket.setNoDelay(true);

socket.on('data', (chunk) => {
  leftover = Buffer.concat([leftover, chunk]);

  if (!headerDone) {
    const idx = leftover.indexOf('\r\n\r\n');
    if (idx < 0) return;
    const hsResponse = leftover.slice(0, idx).toString();
    headerDone = true;
    const is101 = hsResponse.includes(' 101 ');

    console.log('\n--- Handshake Response ---');
    console.log(hsResponse.substring(0, 600));

    if (!is101) {
      console.error('WebSocket handshake FAILED - not 101');
      console.log(hsResponse.substring(0, 500));
      process.exit(1);
    }

    const echoedProto = hsResponse.split('\r\n').find(l => l.toLowerCase().startsWith('sec-websocket-protocol'));
    console.log('\n*** WS 101 OK — Connection Upgraded ***');
    if (echoedProto) {
      const selectedProto = echoedProto.split(':')[1].trim();
      console.log('Selected subprotocol:', selectedProto);
      const isAppsyncProto = selectedProto === 'aws-appsync-event-ws' || selectedProto === headerSubprotocol;
      console.log('Valid AppSync protocol:', isAppsyncProto);
    }

    opened = true;
    leftover = leftover.slice(idx + 4);
    handleWebSocketFrames();
    return;
  }
});

function handleWebSocketFrames() {
  let off = 0;
  while (off < leftover.length) {
    if (off + 2 > leftover.length) break;
    const b0 = leftover[off], b1 = leftover[off + 1];
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0F;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7F;
    let lf = 2;

    if (len === 126) {
      if (off + 4 > leftover.length) break;
      len = leftover.readUInt16BE(off + 2);
      lf = 4;
    } else if (len === 127) {
      if (off + 10 > leftover.length) break;
      len = Number(leftover.readBigUInt64BE(BigInt(off + 2)));
      lf = 10;
    }

    if (off + lf + (masked ? 4 : 0) + len > leftover.length) break;

    let start = off + lf;
    let text;
    if (masked) {
      const mask = leftover.slice(start, start + 4);
      const data = leftover.slice(start + 4, start + 4 + len);
      for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
      text = data.toString('utf8');
      start += 4;
    } else {
      text = leftover.slice(start, start + len).toString('utf8');
    }

    // Handle frame
    if (opcode === 0x9) {
      console.log('  <- PING received, sending PONG');
      socket.write(makePong());
    } else if (opcode === 0xA) {
      console.log('  <- PONG received');
    } else if (opcode === 0x8) {
      console.log('  [CLOSE]', text.substring(0, 100));
    } else if (opcode === 0x1) {
      received.push(text);
      const ts = new Date().toISOString().substring(11, 19);
      const elapsed = Date.now() - startTime;
      console.log(`\n[${ts}] (+${elapsed}ms) <- RECV: ${text.substring(0, 500)}`);

      try {
        const msg = JSON.parse(text);
        if (msg.type === 'connection_ack') {
          gotAck = true;
          console.log('  *** CONNECTION ACK RECEIVED ***');
          console.log('  connectionTimeoutMs:', msg.connectionTimeoutMs || '(not specified)');
        }
        if (msg.type === 'subscribe_success') {
          console.log('  *** SUBSCRIPTION SUCCESS ***');
        }
        if (msg.type === 'subscribe_error') {
          console.log('  *** SUBSCRIPTION ERROR ***');
          console.log('  Error:', JSON.stringify(msg.errors));
        }
        if (msg.type === 'data') {
          console.log('  *** DATA EVENT ***');
          console.log('  id:', msg.id);
          console.log('  event:', msg.event);
          // Log to file for analysis
          fs.appendFileSync('/tmp/wingo_ws_events.jsonl', JSON.stringify({
            timestamp: new Date().toISOString(),
            receivedAt: Date.now(),
            message: msg
          }) + '\n');
        }
        if (msg.type === 'message') {
          console.log('  *** MESSAGE EVENT ***');
        }
      } catch (e) {
        // Not JSON, raw text
      }
    }
    off = start + len;
  }
  leftover = leftover.slice(off);
}

// Continue listening for frames
socket.on('data', () => {
  if (headerDone && opened) {
    handleWebSocketFrames();
  }
});

socket.on('error', (e) => {
  console.error('Socket error:', e.message);
});

// Send flow: wait for connection, send connection_init, wait for ack, subscribe
setTimeout(async () => {
  if (!opened) {
    console.log('Not connected yet, retrying...');
    return;
  }

  // Send connection_init
  console.log('\n--- Sending connection_init ---');
  const initMsg = JSON.stringify({ type: 'connection_init' });
  socket.write(makeTextFrame(initMsg));
  sent.push(initMsg);
  console.log('  -> SENT:', initMsg);

  // Wait for ack, then subscribe
  setTimeout(() => {
    if (!gotAck) {
      console.log('  No connection_ack received, proceeding with subscribe anyway');
    }

    // Subscribe to all relevant channels
    const channelsToSubscribe = [
      '/WebApi/1004/userid/364070',
      '/WebApi/1004/lottery/WinGo_30S',
      '/WebApi/1004/lottery/WinGo',
      '/WebApi/1004/lottery/WinGo_30S/result',
      '/WebApi/1004/lottery/WinGo_30S/Result',
      '/WebApi/1004/lottery/WinGo_30S/open',
      '/WebApi/1004/lottery/WinGo_30S/openLottery',
      '/WebApi/1004/lottery/WinGo_30S/publish',
    ];

    console.log('\n--- Subscribing to channels ---');
    for (const channel of channelsToSubscribe) {
      const subMsg = JSON.stringify({
        type: 'subscribe',
        id: crypto.randomUUID(),
        channel: channel,
        authorization: authObject
      });
      socket.write(makeTextFrame(subMsg));
      sent.push(subMsg);
      console.log('  -> SUBSCRIBE:', channel);
      // Small delay between subscribes
      socket.write(makeTextFrame(subMsg));
    }

    console.log('\n--- Listening for real-time events ---');
    console.log('Will run for 60 seconds...\n');

    // Log periodic status
    const interval = setInterval(() => {
      const elapsed = Date.now() - startTime;
      console.log(`[${elapsed}ms] Status: opened=${opened}, ack=${gotAck}, sent=${sent.length}, recv=${received.length}`);
    }, 10000);

    // After 60 seconds, close and save results
    setTimeout(() => {
      console.log('\n=== Session Complete ===');
      console.log('Opened:', opened);
      console.log('Connection ACK:', gotAck);
      console.log('Sent messages:', sent.length);
      console.log('Received messages:', received.length);
      console.log('Elapsed time:', Date.now() - startTime, 'ms');

      clearInterval(interval);

      const result = {
        timestamp: new Date().toISOString(),
        connectionSuccess: opened,
        connectionAck: gotAck,
        sentMessages: sent,
        receivedMessages: received,
        wsConfig: {
          host: HOST,
          path: PATH,
          subprotocols: subprotocols,
          authObjectHost: HTTP_HOST
        },
        channelsSubscribed: channelsToSubscribe
      };

      fs.writeFileSync('/tmp/wingo_ws_appsync_result.json', JSON.stringify(result, null, 2));
      console.log('\nResults saved to /tmp/wingo_ws_appsync_result.json');

      try { socket.end(); } catch (e) {}
      process.exit(0);
    }, 60000);

  }, 3000);

}, 2000);

// Handle ping interval (send keepalive if needed)
setInterval(() => {
  // Server sends ka messages, we don't need to send pings
}, 30000);

// Timeout for initial connection
setTimeout(() => {
  if (!opened) {
    console.error('ERROR: WebSocket connection failed to establish within 10 seconds');
    process.exit(1);
  }
}, 10000);

function BigInt(n) { return BigInt(n); }
