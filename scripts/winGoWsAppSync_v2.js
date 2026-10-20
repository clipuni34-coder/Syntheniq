#!/usr/bin/env node
/**
 * WinGo_30S — AppSync Events WebSocket Client v2
 *
 * Fixed protocol implementation:
 *   - Uses the `ws` npm library for proper WebSocket framing
 *   - Sends connection_init WITH auth payload immediately after handshake
 *   - Uses the WebSocket Token (from URL) as the authorization
 *   - Subscribes to WinGo result channels
 *
 * Goal: Capture result PUSH earlier than the ~2.4s HTTP polling limit.
 */

const WebSocket = require('ws');
const fs = require('fs');
const crypto = require('crypto');

// Load fresh JWT from login response
const loginData = JSON.parse(fs.readFileSync('/tmp/fb999_login_response.json', 'utf8'));
const ACCESS_TOKEN = loginData.data.token;
const WS_URL = loginData.data.webSocketUrl;
const WS_CHANNELS = loginData.data.webSocketChannels || [];

// Extract the WebSocket Token from the URL query parameter
const wsUrlObj = new URL(WS_URL);
const WS_TOKEN = wsUrlObj.searchParams.get('Token') || ACCESS_TOKEN;
const WS_HOST = wsUrlObj.hostname;
const WS_PATH = wsUrlObj.pathname + wsUrlObj.search;

// Build auth object - use the WS token (from URL) as authorization for AppSync Events
const authObject = {
    authorization: WS_TOKEN,
    host: WS_HOST
};

// Also prepare the access token auth object (used in subscribe messages)
const accessAuthObject = {
    authorization: ACCESS_TOKEN,
    host: WS_HOST
};

console.log('=== WinGo_30S — AppSync Events WebSocket Client v2 ===\n');
console.log('WS URL:', WS_URL?.substring(0, 80) + '...');
console.log('WS Host:', WS_HOST);
console.log('WS Path:', WS_PATH.substring(0, 60) + '...');
console.log('Access Token (HS256):', ACCESS_TOKEN?.substring(0, 40) + '...[' + ACCESS_TOKEN?.length + ' chars]');
console.log('WS Token (RS256 from URL):', WS_TOKEN?.substring(0, 40) + '...[' + WS_TOKEN?.length + ' chars]');
console.log('WS Channels:', JSON.stringify(WS_CHANNELS));

if (!WS_URL) {
    console.error('ERROR: Missing WebSocket URL. Run refreshJwt.js first.');
    process.exit(1);
}

const subprotocols = ['aws-appsync-event-ws'];

console.log('\n--- WebSocket Configuration ---');
console.log('Subprotocols:', JSON.stringify(subprotocols));

const startTime = Date.now();
let opened = false;
let gotAck = false;
let subSuccess = 0;
let subErrors = [];
let received = [];
let sent = [];
let events = [];

// WebSocket frame helpers for potential manual frame handling
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

console.log('\n--- Connecting to AppSync Events WebSocket ---');
console.log('Connecting to:', WS_URL.substring(0, 100) + '...');

// Create WebSocket connection with the ws library
const ws = new WebSocket(WS_URL, subprotocols, {
    rejectUnauthorized: false,
    headers: {
        'Origin': 'https://h5.ar-lottery01.com',
        'Referer': 'https://fb999.com/',
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
    },
    // AppSync sends keepalive "ka" messages
    pingInterval: 0,
    pingTimeout: 10000,
});

ws.on('open', () => {
    opened = true;
    console.log('\n*** WS Connected — Connection Opened ***');
    console.log('Selected URL:', WS_URL.substring(0, 80) + '...');

    // Send connection_init IMMEDIATELY with auth payload
    // AppSync Events: connection_init must carry the authorization
    const initMsg = JSON.stringify({
        type: 'connection_init',
        payload: authObject
    });
    ws.send(initMsg);
    sent.push(initMsg);
    console.log('  -> SENT: connection_init with auth payload (WS Token)');
    console.log('  -> Payload:', JSON.stringify({authorization: WS_TOKEN.substring(0, 30) + '...', host: WS_HOST}));

    // Schedule subscription after ack or timeout
    setTimeout(() => {
        if (!gotAck) {
            console.log('  WARNING: No connection_ack received within 3s, proceeding with subscribe anyway');
        }

        const channelsToSubscribe = [
            ...WS_CHANNELS,
            '/WebApi/1004/lottery/WinGo_30S',
            '/WebApi/1004/lottery/WinGo',
            '/WebApi/1004/lottery/WinGo_30S/result',
            '/WebApi/1004/lottery/WinGo_30S/open',
        ];

        // Deduplicate channels
        const uniqueChannels = [...new Set(channelsToSubscribe)];

        console.log('\n--- Subscribing to channels ---');
        for (const channel of uniqueChannels) {
            const subMsg = JSON.stringify({
                type: 'subscribe',
                id: crypto.randomUUID(),
                channel: channel,
                authorization: accessAuthObject
            });
            ws.send(subMsg);
            sent.push(subMsg);
            console.log('  -> SUBSCRIBE:', channel);
        }

        console.log('\n--- Listening for real-time events ---');
        console.log('Will run for 55 seconds...\n');
    }, 100); // Send connection_init first, then subscribe quickly

    // Periodic status
    const interval = setInterval(() => {
        const elapsed = Date.now() - startTime;
        console.log(`[${elapsed}ms] Status: opened=${opened}, ack=${gotAck}, subSuccess=${subSuccess}, errors=${subErrors.length}, recv=${received.length}, events=${events.length}`);
    }, 10000);

    // After 55 seconds, close and save results
    setTimeout(() => {
        console.log('\n=== Session Complete ===');
        console.log('Opened:', opened);
        console.log('Connection ACK:', gotAck);
        console.log('Sub successes:', subSuccess);
        console.log('Sub errors:', subErrors.length);
        console.log('Sent messages:', sent.length);
        console.log('Received messages:', received.length);
        console.log('Events captured:', events.length);
        console.log('Elapsed time:', Date.now() - startTime, 'ms');

        clearInterval(interval);

        const result = {
            timestamp: new Date().toISOString(),
            connectionSuccess: opened,
            connectionAck: gotAck,
            subSuccessCount: subSuccess,
            subErrors: subErrors,
            sentMessages: sent,
            receivedMessages: received,
            eventsCount: events.length,
            events: events,
            wsConfig: {
                host: WS_HOST,
                path: WS_PATH,
                subprotocols: subprotocols,
                authObjectHost: WS_HOST,
                usedWsToken: true,
            },
            channelsSubscribed: channelsToSubscribe || [],
            elapsedTimeMs: Date.now() - startTime
        };

        fs.writeFileSync('/tmp/wingo_ws_appsync_result.json', JSON.stringify(result, null, 2));
        console.log('\nResults saved to /tmp/wingo_ws_appsync_result.json');

        try { ws.close(); } catch (e) {}
        process.exit(0);
    }, 55000);
});

ws.on('message', (data, isBinary) => {
    const text = isBinary ? data.toString('hex') : data.toString('utf8');
    received.push(text);
    const ts = new Date().toISOString().substring(11, 19);
    const elapsed = Date.now() - startTime;
    console.log(`\n[${ts}] (+${elapsed}ms) <- RECV: ${text.substring(0, 800)}`);

    try {
        const msg = JSON.parse(text);
        if (msg.type === 'connection_ack') {
            gotAck = true;
            console.log('  *** CONNECTION ACK RECEIVED ***');
            console.log('  connectionTimeoutMs:', msg.connectionTimeoutMs || '(not specified)');
        }
        if (msg.type === 'subscribe_success') {
            subSuccess++;
            console.log('  *** SUBSCRIPTION SUCCESS ***');
            console.log('  ID:', msg.id);
        }
        if (msg.type === 'subscribe_error') {
            console.log('  *** SUBSCRIPTION ERROR ***');
            console.log('  Error:', JSON.stringify(msg.errors));
            subErrors.push({error: msg.errors, message: text});
        }
        if (msg.type === 'data') {
            console.log('  *** DATA EVENT ***');
            console.log('  id:', msg.id);
            console.log('  event:', msg.event);
            events.push({
                timestamp: new Date().toISOString(),
                receivedAt: Date.now(),
                elapsedMs: elapsed,
                message: msg
            });
            // Log to file for analysis
            fs.appendFileSync('/tmp/wingo_ws_events.jsonl', JSON.stringify({
                timestamp: new Date().toISOString(),
                receivedAt: Date.now(),
                elapsedMs: elapsed,
                message: msg
            }) + '\n');
        }
        if (msg.type === 'message') {
            console.log('  *** MESSAGE EVENT ***');
        }
        if (msg.type === 'error' || msg.type === 'connection_error' || msg.errors) {
            console.log('  *** ERROR ***');
            console.log('  Error type:', msg.type);
            console.log('  Errors:', JSON.stringify(msg.errors || msg));
        }
    } catch (e) {
        // Not JSON - could be AppSync "ka" keepalive
        if (text === 'ka' || text === 'ka\n') {
            console.log('  <- Keepalive (ka)');
        } else {
            console.log('  <- (non-JSON message)');
        }
    }
});

ws.on('pong', () => {
    console.log('  <- PONG received');
});

ws.on('ping', (data) => {
    console.log('  <- PING received, sending PONG');
});

ws.on('error', (err) => {
    console.error('WebSocket error:', err.message);
    console.error('WebSocket error code:', err.code);
});

ws.on('close', (code, reason) => {
    console.log('\nWebSocket closed:');
    console.log('  Code:', code);
    console.log('  Reason:', reason ? reason.toString() : '(empty)');
    console.log('  Time:', Date.now() - startTime, 'ms');
});

// Timeout for initial connection
setTimeout(() => {
    if (!opened) {
        console.error('ERROR: WebSocket connection failed to establish within 10 seconds');
        process.exit(1);
    }
}, 10000);
