#!/usr/bin/env node
/**
 * WinGo_30S — WebSocket Client v7 (ws library, no subprotocol)
 *
 * Tests ws library without a subprotocol (like _ws_capture.js) to see if
 * the server routes messages differently.
 * Also sends connection_init with auth payload (WS token from URL).
 */
const WebSocket = require('ws');
const fs = require('fs');
const crypto = require('crypto');

const loginData = JSON.parse(fs.readFileSync('/tmp/fb999_login_response.json', 'utf8'));
const ACCESS_TOKEN = loginData.data.token;
const WS_URL = loginData.data.webSocketUrl;
const WS_CHANNELS = loginData.data.webSocketChannels || [];
const wsUrlObj = new URL(WS_URL);
const WS_TOKEN = wsUrlObj.searchParams.get('Token') || ACCESS_TOKEN;
const HOST = wsUrlObj.hostname;
const HTTP_HOST = HOST;
const authObject = { authorization: WS_TOKEN, host: HTTP_HOST };

console.log('=== WinGo_30S — WebSocket Client v7 (ws lib, no subprotocol) ===\n');
console.log('WS URL:', WS_URL.substring(0, 100) + '...');
console.log('WS Token:', WS_TOKEN.substring(0, 50) + '...');
console.log('Channels:', JSON.stringify(WS_CHANNELS));

const startTime = Date.now();
let opened = false, gotAck = false;
let subSuccess = 0;
const sent = [], received = [], events = [];
let keepaliveCount = 0;

// Approach 1: ws library, no subprotocol
const ws = new WebSocket(WS_URL, {
    rejectUnauthorized: false,
    headers: {
        'Origin': 'https://h5.ar-lottery01.com',
        'Referer': 'https://fb999.com/',
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone iOS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
    }
});

ws.on('open', () => {
    opened = true;
    console.log('\n*** WebSocket OPEN (no subprotocol) *** at', Date.now() - startTime, 'ms');
    console.log('Protocol:', ws.protocol || '(none)');

    // Send connection_init with auth payload
    const initMsg = JSON.stringify({ type: 'connection_init', payload: authObject });
    ws.send(initMsg);
    sent.push(initMsg);
    console.log('  -> SENT: connection_init with WS token');

    // After ack, subscribe
    setTimeout(() => {
        const channels = [...WS_CHANNELS, '/WebApi/1004/lottery/WinGo'];
        console.log('\n--- Subscribing ---');
        for (const channel of channels) {
            const subMsg = JSON.stringify({ type: 'subscribe', id: crypto.randomUUID(), channel, authorization: authObject });
            ws.send(subMsg);
            sent.push(subMsg);
            console.log('  -> SUBSCRIBE:', channel);
        }
        // Also try a ping
        ws.send(JSON.stringify({ type: 'ping' }));
        sent.push('{"type":"ping"}');
        console.log('  -> SENT: ping');
        console.log('\n--- Listening (55s) ---\n');
    }, 100);
});

ws.on('message', (data, isBinary) => {
    const text = isBinary ? data.toString('hex') : data.toString('utf8');
    received.push(text);
    const ts = new Date().toISOString().substring(11, 19);
    const elapsed = Date.now() - startTime;
    console.log(`\n[${ts}] (+${elapsed}ms) <- RECV: ${text.substring(0, 700)}`);
    try {
        const msg = JSON.parse(text);
        if (msg.type === 'connection_ack') { gotAck = true; console.log('  *** ACK ***'); }
        if (msg.type === 'subscribe_success') { subSuccess++; console.log('  *** SUBSCRIBED ***'); }
        if (msg.type === 'data') { console.log('  *** DATA ***'); events.push({ts, elapsedMs: elapsed, message: msg}); fs.appendFileSync('/tmp/wingo_ws_events.jsonl', JSON.stringify({ts, elapsedMs: elapsed, message: msg}) + '\n'); }
        if (msg.type === 'ka') { keepaliveCount++; }
        if (msg.type === 'error' || msg.errors) { console.log('  *** ERROR ***:', JSON.stringify(msg.errors || msg).substring(0, 200)); }
    } catch(e) { if (text === 'ka') keepaliveCount++; }
});

ws.on('error', (err) => { console.error('WS Error:', err.message.substring(0, 200)); });

ws.on('close', (code, reason) => {
    console.log('WS Closed:', code, reason ? reason.toString().substring(0, 80) : '');
});

// Also try: ws with aws-appsync-event-ws subprotocol
setTimeout(async () => {
    console.log('\n\n=== Approach 2: ws library WITH aws-appsync-event-ws subprotocol ===\n');
    const ws2 = new WebSocket(WS_URL, 'aws-appsync-event-ws', {
        rejectUnauthorized: false,
        headers: {
            'Origin': 'https://h5.ar-lottery01.com',
            'Referer': 'https://fb999.com/',
            'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
        }
    });

    let opened2 = false, ack2 = false;

    ws2.on('open', () => {
        opened2 = true;
        console.log('*** WebSocket OPEN (with subprotocol) ***');
        console.log('Protocol:', ws2.protocol || '(none)');
        const initMsg = JSON.stringify({ type: 'connection_init', payload: authObject });
        ws2.send(initMsg); sent.push(initMsg);
        console.log('  -> SENT: connection_init');
        setTimeout(() => {
            const subMsg = JSON.stringify({ type: 'subscribe', id: crypto.randomUUID(), channel: WS_CHANNELS[0], authorization: authObject });
            ws2.send(subMsg); sent.push(subMsg);
            console.log('  -> SUBSCRIBE:', WS_CHANNELS[0]);
        }, 100);
    });

    ws2.on('message', (data) => {
        const text = data.toString('utf8');
        received.push(text);
        const ts = new Date().toISOString().substring(11, 19);
        console.log(`[${ts}] <- RECV: ${text.substring(0, 700)}`);
        try { const m = JSON.parse(text); if (m.type === 'connection_ack') ack2 = true; } catch(e) {}
    });

    ws2.on('error', (e) => { console.error('WS2 Error:', e.message.substring(0, 200)); });

    setTimeout(() => {
        console.log('\n=== Session Complete (v7) ===');
        console.log('Approach 1 (no subprotocol): opened=' + opened + ', ack=' + gotAck + ', subSuccess=' + subSuccess);
        console.log('Approach 2 (with subprotocol): opened=' + opened2 + ', ack=' + ack2);
        console.log('Events:', events.length, 'Keepalives:', keepaliveCount);
        console.log('Elapsed:', Date.now() - startTime, 'ms');

        try { ws.close(); } catch(e) {}
        try { ws2.close(); } catch(e) {}
        process.exit(0);
    }, 50000);
}, 5000);
