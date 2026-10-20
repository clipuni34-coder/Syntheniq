#!/usr/bin/env node
/**
 * WinGo_30S — WebSocket Client v6
 *
 * Uses GraphQL subscription format (like winGoWebSocketCognito.js) with:
 *   - payload.query, payload.extensions.subscription.read.topics.url
 *   - raw TLS (proven to get 101 + connection_ack)
 *   - connection_init with WS token payload
 *
 * Also tries both simple channel format AND GraphQL subscription format.
 */

const tls = require('tls');
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

console.log('=== WinGo_30S — WebSocket Client v6 (GraphQL Subscription Format) ===\n');
console.log('WS Token:', WS_TOKEN?.substring(0, 50) + '...[' + WS_TOKEN?.length + ' chars]');
console.log('Channels from login:', JSON.stringify(WS_CHANNELS));

const startTime = Date.now();
let opened = false, gotAck = false;
const sent = [], received = [], events = [];
let keepaliveCount = 0;
let channelsTried = [];

// WebSocket frame helpers
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
    const hdr = Buffer.alloc(2); hdr[0] = 0x80 | 0xA; hdr[1] = 0x80;
    return Buffer.concat([hdr, mask, Buffer.alloc(0)]);
}

const authBase64 = Buffer.from(JSON.stringify(authObject)).toString('base64url');
const headerSubprotocol = 'header-' + authBase64;
const subprotocols = ['aws-appsync-event-ws', headerSubprotocol];

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

console.log('\n--- Connecting ---');

let leftover = Buffer.alloc(0);
let headerDone = false;

const socket = tls.connect(443, HOST, { rejectUnauthorized: false, servername: HOST }, () => {
    console.log('[*] TLS connected to', HOST);
    socket.write(handshake);
    console.log('[*] Handshake sent at', Date.now() - startTime, 'ms');
});
socket.setNoDelay(true);

socket.on('data', (chunk) => {
    leftover = Buffer.concat([leftover, chunk]);
    if (!headerDone) {
        const idx = leftover.indexOf('\r\n\r\n');
        if (idx < 0) return;
        const hsResponse = leftover.slice(0, idx).toString();
        headerDone = true;
        if (!hsResponse.includes(' 101 ')) {
            console.error('Handshake FAILED');
            console.log(hsResponse.substring(0, 500));
            process.exit(1);
        }
        console.log('\n*** WS 101 OK ***');
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
        console.log(`\n[${ts}] (+${elapsed}ms) <- RECV: ${text.substring(0, 700)}`);
        try {
            const msg = JSON.parse(text);
            if (msg.type === 'connection_ack') {
                gotAck = true;
                console.log('  *** CONNECTION ACK ***');
                setTimeout(sendSubscriptions, 100);
            }
            if (msg.type === 'subscribe_success') { console.log('  *** SUBSCRIBE SUCCESS ***'); }
            if (msg.type === 'subscribe_error') { console.log('  *** SUBSCRIBE ERROR ***:', JSON.stringify(msg.errors)); }
            if (msg.type === 'data') {
                console.log('  *** DATA EVENT ***');
                console.log('  id:', msg.id);
                console.log('  event:', msg.event);
                let eventData = null;
                if (msg.event) { try { eventData = JSON.parse(msg.event); } catch(e) {} }
                console.log('  parsed event:', JSON.stringify(eventData).substring(0, 400));
                events.push({ts, elapsedMs: elapsed, message: msg});
                fs.appendFileSync('/tmp/wingo_ws_events.jsonl', JSON.stringify({timestamp: new Date().toISOString(), elapsedMs: elapsed, message: msg}) + '\n');
            }
            if (msg.type === 'error' || msg.type === 'connection_error' || msg.errors) {
                console.log('  *** ERROR ***:', JSON.stringify(msg.errors || msg));
            }
            if (msg.type === 'ka') { keepaliveCount++; }
        } catch(e) {
            if (text === 'ka' || text === 'ka\n') { keepaliveCount++; console.log('  <- KA'); }
        }
    }
}

socket.on('data', () => { if (headerDone && opened) handleWebSocketFrames(); });
socket.on('error', (e) => { console.error('Socket error:', e.message); });

function sendConnectionInit() {
    console.log('\n--- Sending connection_init (WS token payload) ---');
    const initMsg = JSON.stringify({ type: 'connection_init', payload: authObject });
    socket.write(makeTextFrame(initMsg));
    sent.push(initMsg);
    console.log('  -> SENT connection_init');
}

function sendSubscriptions() {
    // Channels to try
    const channels = [
        ...WS_CHANNELS,                              // "/WebApi/1004/userid/364070"
        '/WebApi/1004/lottery/WinGo',
        '/WebApi/1004/lottery/WinGo_30S',
        '/WebApi/1004/game/WinGo_30S',
    ];
    const uniqueChannels = [...new Set(channels)];
    channelsTried = uniqueChannels;

    console.log('\n--- Sending subscriptions (GraphQL format + simple) ---');

    let i = 0;
    const iv = setInterval(() => {
        if (i >= uniqueChannels.length) { clearInterval(iv); console.log('\nAll subscriptions sent.\n'); return; }
        const channel = uniqueChannels[i++];
        
        // Method 1: GraphQL subscription format (AppSync Events style)
        const gqlMsg = JSON.stringify({
            id: crypto.randomUUID(),
            type: 'subscribe',
            payload: {
                query: 'subscription { subscribe { data topic } }',
                variables: {},
                extensions: {
                    subscription: {
                        read: {
                            topics: { url: channel }
                        }
                    }
                }
            }
        });
        socket.write(makeTextFrame(gqlMsg));
        sent.push(gqlMsg);
        console.log('  -> GQL SUBSCRIBE:', channel);

        // Method 2: Simple format with authorization
        const simpleMsg = JSON.stringify({
            type: 'subscribe',
            id: crypto.randomUUID(),
            channel: channel,
            authorization: authObject
        });
        socket.write(makeTextFrame(simpleMsg));
        sent.push(simpleMsg);
        console.log('  -> SIMPLE SUBSCRIBE:', channel);
    }, 300);

    const interval = setInterval(() => {
        const elapsed = Date.now() - startTime;
        console.log(`[${elapsed}ms] ack=${gotAck}, recv=${received.length}, events=${events.length}, ka=${keepaliveCount}`);
    }, 10000);

    setTimeout(() => {
        console.log('\n=== Session Complete ===');
        console.log('Opened:', opened, 'ACK:', gotAck);
        console.log('Sub successes:', sent.length / 2, 'attempted');
        console.log('Events:', events.length);
        console.log('Keepalives:', keepaliveCount);
        console.log('Elapsed:', Date.now() - startTime, 'ms');

        clearInterval(interval);
        const result = {
            timestamp: new Date().toISOString(),
            connectionSuccess: opened,
            connectionAck: gotAck,
            sentCount: sent.length,
            receivedCount: received.length,
            eventsCount: events.length,
            keepaliveCount,
            sentMessages: sent,
            receivedMessages: received,
            events,
            wsConfig: { host: HOST, path: PATH.substring(0, 100) },
            channelsSubscribed: channelsTried,
            elapsedTimeMs: Date.now() - startTime
        };
        fs.writeFileSync('/tmp/wingo_ws_appsync_result.json', JSON.stringify(result, null, 2));
        console.log('Saved to /tmp/wingo_ws_appsync_result.json');
        try { socket.end(); } catch(e) {}
        process.exit(0);
    }, 62000);
}

// Ping keepalive
const pingInterval = setInterval(() => {
    if (opened && gotAck) {
        try { socket.write(makeTextFrame(JSON.stringify({ type: 'ping' }))); } catch(e) {}
    }
}, 25000);

setTimeout(() => {
    if (!opened) { console.error('ERROR: Connection failed within 10s'); process.exit(1); }
}, 10000);
