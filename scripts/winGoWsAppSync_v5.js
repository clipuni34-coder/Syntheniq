#!/usr/bin/env node
/**
 * WinGo_30S — WebSocket Client v5
 *
 * Tests two connection approaches:
 *   A. raw TLS with aws-appsync-event-ws subprotocol (like v4 - proven to work)
 *   B. ws library WITHOUT subprotocol (like _ws_capture.js)
 *
 * For each: connection_init with WS token payload, then subscribe to channels.
 * Runs for 62 seconds to capture at least 2 WinGo draw cycles (30s each).
 */

const fs = require('fs');
const crypto = require('crypto');
const loginData = JSON.parse(fs.readFileSync('/tmp/fb999_login_response.json', 'utf8'));
const ACCESS_TOKEN = loginData.data.token;
const WS_URL = loginData.data.webSocketUrl;
const WS_CHANNELS = loginData.data.webSocketChannels || [];

const wsUrlObj = new URL(WS_URL);
const WS_TOKEN = wsUrlObj.searchParams.get('Token') || ACCESS_TOKEN;
const HOST = wsUrlObj.hostname;
const PATH = wsUrlObj.pathname + wsUrlObj.search;
const HTTP_HOST = HOST;

const authObject = { authorization: WS_TOKEN, host: HTTP_HOST };
const authBase64 = Buffer.from(JSON.stringify(authObject)).toString('base64url');
const headerSubprotocol = 'header-' + authBase64;
const subprotocols = ['aws-appsync-event-ws', headerSubprotocol];

console.log('=== WinGo_30S — WebSocket Client v5 (62s capture) ===\n');
console.log('WS Token:', WS_TOKEN?.substring(0, 50) + '...[' + WS_TOKEN?.length + ' chars]');
console.log('Channels from login:', JSON.stringify(WS_CHANNELS));

const startTime = Date.now();
let opened = false, gotAck = false, subSuccess = 0;
const sent = [], received = [], events = [], subErrors = [];
let keepaliveCount = 0;

// ---- WebSocket frame helpers ----
function maskPayload(dataBuf) {
    const mask = Buffer.from([(Math.random()*256|0), (Math.random()*256|0), (Math.random()*256|0), (Math.random()*256|0)]);
    const out = Buffer.alloc(dataBuf.length);
    for (let i = 0; i < dataBuf.length; i++) out[i] = dataBuf[i] ^ mask[i % 4];
    return Buffer.concat([mask, out]);
}
function makeTextFrame(payload) {
    const pb = Buffer.from(payload, 'utf8'); const len = pb.length; let hdr;
    if (len < 126) { hdr = Buffer.alloc(2); hdr[0] = 0x81; hdr[1] = len | 0x80; }
    else if (len < 65536) { hdr = Buffer.alloc(4); hdr[0] = 0x81; hdr[1] = 0x7E | 0x80; hdr.writeUInt16BE(len, 2); }
    else { hdr = Buffer.alloc(10); hdr[0] = 0x81; hdr[1] = 0x7F | 0x80; hdr.writeBigUInt64BE(BigInt(len), 2); }
    return Buffer.concat([hdr, maskPayload(pb)]);
}
function makePong() {
    const mask = Buffer.from([(Math.random()*256|0), (Math.random()*256|0), (Math.random()*256|0), (Math.random()*256|0)]);
    const payloadBuf = Buffer.alloc(0);
    const out = Buffer.alloc(0);
    const len = 0;
    const hdr = Buffer.alloc(2); hdr[0] = 0x80 | 0xA; hdr[1] = len | 0x80;
    return Buffer.concat([hdr, mask, out]);
}

// ---- Build handshake ----
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
console.log('Host:', HOST);
console.log('Path:', PATH.substring(0, 80) + '...');
console.log('Subprotocols: [aws-appsync-event-ws, header-*]');

let leftover = Buffer.alloc(0);
let headerDone = false;

const socket = require('tls').connect(443, HOST, { rejectUnauthorized: false, servername: HOST }, () => {
    console.log('[*] TLS connected to', HOST, 'at', Date.now() - startTime, 'ms');
    socket.write(handshake);
    console.log('[*] Handshake sent');
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
        console.log(hsResponse.substring(0, 500));
        if (!is101) {
            console.error('WebSocket handshake FAILED - not 101');
            process.exit(1);
        }
        const echoedProto = hsResponse.split('\r\n').find(l => l.toLowerCase().startsWith('sec-websocket-protocol'));
        console.log('\n*** WS 101 OK ***');
        if (echoedProto) console.log('Selected subprotocol:', echoedProto.split(':')[1].trim());
        opened = true;
        leftover = leftover.slice(idx + 4);
        handleWebSocketFrames();
        sendConnectionInit();
        return;
    }
});

function handleWebSocketFrames() {
    let off = 0;
    while (off < leftover.length) {
        if (off + 2 > leftover.length) break;
        const b0 = leftover[off], b1 = leftover[off + 1];
        const opcode = b0 & 0x0F;
        const masked = (b1 & 0x80) !== 0;
        let len = b1 & 0x7F, lf = 2;
        if (len === 126) { if (off + 4 > leftover.length) break; len = leftover.readUInt16BE(off + 2); lf = 4; }
        else if (len === 127) { if (off + 10 > leftover.length) break; len = Number(leftover.readBigUInt64BE(BigInt(off + 2))); lf = 10; }
        if (off + lf + (masked ? 4 : 0) + len > leftover.length) break;
        let start = off + lf;
        let text;
        if (masked) { const mask = leftover.slice(start, start + 4); const data = leftover.slice(start + 4, start + 4 + len); for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4]; text = data.toString('utf8'); start += 4; }
        else { text = leftover.slice(start, start + len).toString('utf8'); }
        handleFrame(opcode, text);
        off = start + len;
    }
    leftover = leftover.slice(off);
}

function handleFrame(opcode, text) {
    const ts = new Date().toISOString().substring(11, 19);
    const elapsed = Date.now() - startTime;
    if (opcode === 0x9) { console.log('  <- PING, replying PONG'); socket.write(makePong()); }
    else if (opcode === 0xA) { console.log('  <- PONG'); }
    else if (opcode === 0x8) { console.log('  [CLOSE]', text.substring(0, 100)); }
    else if (opcode === 0x1) {
        received.push(text);
        console.log(`\n[${ts}] (+${elapsed}ms) <- RECV: ${text.substring(0, 600)}`);
        try {
            const msg = JSON.parse(text);
            if (msg.type === 'connection_ack') {
                gotAck = true;
                console.log('  *** CONNECTION ACK ***');
                console.log('  timeoutMs:', msg.connectionTimeoutMs);
                // Send subscribe immediately
                sendSubscriptions();
            }
            if (msg.type === 'subscribe_success') { subSuccess++; console.log('  *** SUBSCRIBE SUCCESS ***'); }
            if (msg.type === 'subscribe_error') { subErrors.push(text); console.log('  *** SUBSCRIBE ERROR ***'); }
            if (msg.type === 'data') {
                console.log('  *** DATA EVENT ***');
                console.log('  id:', msg.id);
                console.log('  event:', msg.event);
                events.push({ts, elapsedMs: elapsed, message: msg});
                fs.appendFileSync('/tmp/wingo_ws_events.jsonl', JSON.stringify({timestamp: new Date().toISOString(), elapsedMs: elapsed, message: msg}) + '\n');
            }
            if (msg.type === 'error' || msg.type === 'connection_error' || msg.errors) {
                console.log('  *** ERROR ***:', JSON.stringify(msg.errors || msg));
            }
            if (msg.type === 'ka') { keepaliveCount++; }
        } catch(e) {
            if (text === 'ka' || text === 'ka\n') { keepaliveCount++; }
        }
    }
}

socket.on('data', () => { if (headerDone && opened) handleWebSocketFrames(); });
socket.on('error', (e) => { console.error('Socket error:', e.message); });

function sendConnectionInit() {
    console.log('\n--- Sending connection_init (with WS token) ---');
    const initMsg = JSON.stringify({ type: 'connection_init', payload: authObject });
    socket.write(makeTextFrame(initMsg));
    sent.push(initMsg);
    console.log('  -> SENT connection_init with payload (WS token)');
}

function sendSubscriptions() {
    // Subscribe to user channel + WinGo channel
    const channels = [...new Set([...WS_CHANNELS, '/WebApi/1004/lottery/WinGo'])];
    console.log('\n--- Subscribing to channels ---');
    let i = 0;
    const iv = setInterval(() => {
        if (i >= channels.length) { clearInterval(iv); return; }
        const ch = channels[i++];
        const subMsg = JSON.stringify({ type: 'subscribe', id: crypto.randomUUID(), channel: ch, authorization: authObject });
        socket.write(makeTextFrame(subMsg));
        sent.push(subMsg);
        console.log('  -> SUBSCRIBE:', ch);
    }, 200);

    console.log('\n--- Listening for WinGo results (62s) ---\n');

    const interval = setInterval(() => {
        const elapsed = Date.now() - startTime;
        console.log(`[${elapsed}ms] Status: ack=${gotAck}, subSuccess=${subSuccess}, subErrors=${subErrors.length}, recv=${received.length}, events=${events.length}, ka=${keepaliveCount}`);
    }, 10000);

    setTimeout(() => {
        console.log('\n=== Session Complete ===');
        console.log('Opened:', opened);
        console.log('Connection ACK:', gotAck);
        console.log('Sub successes:', subSuccess);
        console.log('Sub errors:', subErrors.length);
        console.log('Events captured:', events.length);
        console.log('Keepalives:', keepaliveCount);
        console.log('Elapsed:', Date.now() - startTime, 'ms');

        clearInterval(interval);
        const result = {
            timestamp: new Date().toISOString(),
            connectionSuccess: opened,
            connectionAck: gotAck,
            subSuccessCount: subSuccess,
            subErrors,
            sentMessages: sent,
            receivedMessages: received,
            eventsCount: events.length,
            events,
            keepaliveCount,
            wsConfig: { host: HOST, path: PATH.substring(0, 100), subprotocols: ['aws-appsync-event-ws', 'header-[redacted]'] },
            channelsSubscribed: channels,
            elapsedTimeMs: Date.now() - startTime
        };
        fs.writeFileSync('/tmp/wingo_ws_appsync_result.json', JSON.stringify(result, null, 2));
        console.log('Results saved to /tmp/wingo_ws_appsync_result.json');
        try { socket.end(); } catch(e) {}
        process.exit(0);
    }, 62000);
}

// Ping keepalive (send every 20s)
const pingInterval = setInterval(() => {
    if (opened && gotAck) {
        try { socket.write(makeTextFrame(JSON.stringify({ type: 'ping' }))); } catch(e) {}
    }
}, 20000);

// Connection timeout
setTimeout(() => {
    if (!opened) { console.error('ERROR: Connection failed within 10s'); process.exit(1); }
}, 10000);
