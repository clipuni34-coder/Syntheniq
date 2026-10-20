#!/usr/bin/env node
/**
 * WinGo_30S — AppSync Events WebSocket Client v3 (raw TLS, fixed auth)
 *
 * Key fixes:
 *   - Sends connection_init IMMEDIATELY after handshake (no 2s delay)
 *   - Includes auth payload (WS Token from URL) in connection_init
 *   - Uses header- subprotocol with WS Token for auth
 *   - Properly formats connection_init with payload.authorization
 *
 * Based on AWS AppSync Events WebSocket protocol:
 *   1. Connect with subprotocols: aws-appsync-event-ws, header-<base64>
 *   2. Send connection_init with auth payload
 *   3. Subscribe to channels
 */

const tls = require('tls');
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
const HOST = wsUrlObj.hostname;
const PATH = wsUrlObj.pathname + wsUrlObj.search;
const HTTP_HOST = HOST;

console.log('=== WinGo_30S — AppSync Events WebSocket Client v3 ===\n');
console.log('JWT (access):', ACCESS_TOKEN?.substring(0, 40) + '...[' + ACCESS_TOKEN?.length + ' chars]');
console.log('WS Token (from URL):', WS_TOKEN?.substring(0, 40) + '...[' + WS_TOKEN?.length + ' chars]');
console.log('WS URL:', WS_URL?.substring(0, 80) + '...');
console.log('WS Channels:', JSON.stringify(WS_CHANNELS));

if (!WS_URL) {
    console.error('ERROR: Missing JWT or WebSocket URL. Run refreshJwt.js first.');
    process.exit(1);
}

// Auth object for connection_init payload - use WS Token from URL
const authObject = {
    authorization: WS_TOKEN,
    host: HTTP_HOST
};

// Auth object for subscribe messages - use access token (for channel auth)
const subscribeAuthObject = {
    authorization: ACCESS_TOKEN,
    host: HTTP_HOST
};

// Create header subprotocol with auth
const authBase64 = Buffer.from(JSON.stringify(authObject)).toString('base64url');
const headerSubprotocol = 'header-' + authBase64;
const subprotocols = ['aws-appsync-event-ws', headerSubprotocol];

console.log('\n--- WebSocket Configuration ---');
console.log('Host:', HOST);
console.log('Path:', PATH.substring(0, 60) + '...');
console.log('Subprotocols:', ['aws-appsync-event-ws', 'header-[redacted]' + authBase64.substring(0, 20) + '...']);
console.log('connection_init payload auth (WS token):', WS_TOKEN.substring(0, 30) + '...');

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

function makePong(payloadBuf) {
    const mask = Buffer.from([(Math.random()*256|0), (Math.random()*256|0), (Math.random()*256|0), (Math.random()*256|0)]);
    const out = Buffer.alloc(payloadBuf.length);
    for (let i = 0; i < payloadBuf.length; i++) out[i] = payloadBuf[i] ^ mask[i % 4];
    const len = payloadBuf.length;
    const hdr = Buffer.alloc(len > 125 ? 4 : 2);
    hdr[0] = 0x80 | 0xA;
    hdr[1] = len | 0x80;
    if (len >= 126 && len < 65536) {
        const tmp = Buffer.alloc(4);
        tmp[0] = 0x80 | 0xA;
        tmp[1] = 0x7E | 0x80;
        tmp.writeUInt16BE(len, 2);
        return Buffer.concat([tmp, mask, out]);
    } else if (len >= 65536) {
        const tmp = Buffer.alloc(10);
        tmp[0] = 0x80 | 0xA;
        tmp[1] = 0x7F | 0x80;
        tmp.writeBigUInt64BE(BigInt(len), 2);
        return Buffer.concat([tmp, mask, out]);
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
console.log('Handshake headers:\n' + handshake.replace(/\r\n/g, '\n  ').substring(0, 500));

let socket;
let leftover = Buffer.alloc(0);
let headerDone = false;
let opened = false;
let gotAck = false;
let subSuccess = 0;
let subErrors = [];
let sent = [];
let received = [];
const startTime = Date.now();

const connectStart = Date.now();
console.log('Connect start:', new Date().toISOString());

socket = tls.connect(443, HOST, { rejectUnauthorized: false, servername: HOST }, () => {
    console.log('[*] TLS connected to', HOST);
    const t0 = Date.now();
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
        }

        opened = true;
        leftover = leftover.slice(idx + 4);
        handleWebSocketFrames();

        // Send connection_init IMMEDIATELY (no 2s delay)
        sendConnectionInit();
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

        handleFrame(opcode, text);
        off = start + len;
    }
    leftover = leftover.slice(off);
}

function handleFrame(opcode, text) {
    const ts = new Date().toISOString().substring(11, 19);
    const elapsed = Date.now() - startTime;

    if (opcode === 0x9) {
        console.log('  <- PING received, sending PONG');
        socket.write(makePong());
    } else if (opcode === 0xA) {
        console.log('  <- PONG received');
    } else if (opcode === 0x8) {
        console.log('  [CLOSE]', text ? text.substring(0, 100) : '');
    } else if (opcode === 0x1) {
        received.push(text);
        console.log(`\n[${ts}] (+${elapsed}ms) <- RECV: ${text.substring(0, 500)}`);

        try {
            const msg = JSON.parse(text);
            if (msg.type === 'connection_ack') {
                gotAck = true;
                console.log('  *** CONNECTION ACK RECEIVED ***');
                console.log('  connectionTimeoutMs:', msg.connectionTimeoutMs || '(not specified)');
                // Now subscribe
                sendSubscriptions();
            }
            if (msg.type === 'subscribe_success') {
                subSuccess++;
                console.log('  *** SUBSCRIPTION SUCCESS ***');
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
            if (msg.type === 'connection_error' || msg.type === 'error' || msg.errors) {
                console.log('  *** ERROR ***');
                console.log('  Error type:', msg.type);
                console.log('  Errors:', JSON.stringify(msg.errors || msg));
            }
        } catch (e) {
            if (text === 'ka' || text === 'ka\n') {
                console.log('  <- Keepalive (ka)');
            }
        }
    }
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

function sendConnectionInit() {
    console.log('\n--- Sending connection_init ---');
    const initMsg = JSON.stringify({
        type: 'connection_init',
        payload: authObject
    });
    socket.write(makeTextFrame(initMsg));
    sent.push(initMsg);
    console.log('  -> SENT: connection_init with auth payload');
    console.log('  -> Payload:', JSON.stringify({type:'connection_init', payload: {authorization: WS_TOKEN.substring(0, 30) + '...', host: HTTP_HOST}}));
}

function sendSubscriptions() {
    const channelsToSubscribe = [
        ...WS_CHANNELS,
        '/WebApi/1004/lottery/WinGo_30S',
        '/WebApi/1004/lottery/WinGo',
        '/WebApi/1004/lottery/WinGo_30S/result',
        '/WebApi/1004/lottery/WinGo_30S/open',
        '/WebApi/1004/lottery/WinGo_30S/openLottery',
    ];
    const uniqueChannels = [...new Set(channelsToSubscribe)];

    console.log('\n--- Subscribing to channels ---');
    for (const channel of uniqueChannels) {
        const subMsg = JSON.stringify({
            type: 'subscribe',
            id: crypto.randomUUID(),
            channel: channel,
            authorization: subscribeAuthObject
        });
        socket.write(makeTextFrame(subMsg));
        sent.push(subMsg);
        console.log('  -> SUBSCRIBE:', channel);
        // Double-send to match original behavior
        socket.write(makeTextFrame(subMsg));
    }

    console.log('\n--- Listening for real-time events ---');
    console.log('Will run for 55 seconds...\n');
}

// Timeout for initial connection
setTimeout(() => {
    if (!opened) {
        console.error('ERROR: WebSocket connection failed to establish within 10 seconds');
        process.exit(1);
    }
}, 10000);

// Session end + save results
setTimeout(() => {
    console.log('\n=== Session Complete ===');
    console.log('Opened:', opened);
    console.log('Connection ACK:', gotAck);
    console.log('Sub successes:', subSuccess);
    console.log('Sub errors:', subErrors.length);
    console.log('Sent messages:', sent.length);
    console.log('Received messages:', received.length);
    console.log('Elapsed time:', Date.now() - startTime, 'ms');

    const result = {
        timestamp: new Date().toISOString(),
        connectionSuccess: opened,
        connectionAck: gotAck,
        subSuccessCount: subSuccess,
        subErrors: subErrors,
        sentMessages: sent,
        receivedMessages: received,
        wsConfig: {
            host: HOST,
            path: PATH,
            subprotocols: ['aws-appsync-event-ws', 'header-[redacted]'],
            authObjectHost: HTTP_HOST,
        },
        channelsSubscribed: channelsToSubscribe || [],
        elapsedTimeMs: Date.now() - startTime
    };

    fs.writeFileSync('/tmp/wingo_ws_appsync_result.json', JSON.stringify(result, null, 2));
    console.log('\nResults saved to /tmp/wingo_ws_appsync_result.json');

    try { socket.end(); } catch (e) {}
    process.exit(0);
}, 55000);
