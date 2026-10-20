/**
 * WinGo_30S — WebSocket test with Cognito token as query param
 * AppSync URL format: wss://...?Token=<JWT>
 * 
 * Also uses Cognito tokens to try other endpoints that might push earlier results.
 */

const https = require('https');
const fs = require('fs');
const crypto = require('crypto');

const tokens = JSON.parse(fs.readFileSync('/tmp/viralclips_tokens.json', 'utf8'));
const ACCESS_TOKEN = tokens.access_token;
const ID_TOKEN = tokens.id_token;

function httpRequest(hostname, path, method = 'GET', body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname, path, method,
      headers: { 'Accept': 'application/json', 'Content-Type': 'application/json', ...headers }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function ne() { return crypto.randomBytes(16).toString('hex'); }
function we(str) { return crypto.createHash('md5').update(str).digest('hex').toUpperCase().slice(0, 32); }
function signParams(params) {
  const u = { ...params, language: 0 };
  u.random = ne();
  const c = JSON.parse(JSON.stringify(u));
  const o = Object.keys(c).filter(key =>
    !(typeof c[key] === 'object' && c[key] !== null && !Array.isArray(c[key])) && !Array.isArray(c[key]));
  o.sort();
  const i = {};
  o.forEach(key => { if (c[key] !== null && c[key] !== "" && c[key] !== undefined) i[key] = c[key] === 0 ? 0 : c[key]; });
  u.signature = we(JSON.stringify(i));
  u.timestamp = Math.floor(Date.now() / 1e3);
  return u;
}

async function getAPIResults(token) {
  const res = await httpRequest('fb999api.com', '/api/webapi/GetLastFiveIssueNumberResult', 'POST',
    JSON.stringify(signParams({ TypeId: 30 })), { 'Authorization': `Bearer ${token}` });
  if (res.status === 200) {
    const json = JSON.parse(res.body);
    if (json.code === 0 && json.data?.number) {
      const nums = typeof json.data.number === 'string' ? json.data.number.split(',') : json.data.number;
      return nums;
    }
  }
  return null;
}

async function main() {
  console.log('=== WinGo_30S — WebSocket + API Enhanced Test ===\n');

  // Test: Get API results with Cognito token
  console.log('1. Testing API with Cognito tokens...');
  for (const [label, token] of [['access_token', ACCESS_TOKEN], ['id_token', ID_TOKEN]]) {
    const results = await getAPIResults(token);
    console.log(`  ${label}: ${results ? results.join(',') : 'FAILED'}`);
  }

  // Now try WebSocket with Cognito token as query parameter
  // The real fb999 URL format is: wss://...?Token=<JWT>
  // Try with Cognito token
  console.log('\n2. Testing WebSocket with Cognito token in URL...');
  
  const wsUrl = `wss://pro-v3-payplatform.admin-broadcast.com/event/realtime?Token=${encodeURIComponent(ACCESS_TOKEN)}`;
  
  try {
    const WebSocket = require('ws');
    const ws = new WebSocket(wsUrl, 'aws-appsync-event-ws', {
      headers: {
        'Origin': 'https://fb999.com',
        'Referer': 'https://fb999.com/',
      },
    });
    
    let messages = [];
    
    ws.on('open', () => {
      console.log('  WebSocket connected! Sending init...');
      ws.send(JSON.stringify({ type: 'connection_init', payload: {} }));
    });
    
    ws.on('message', (data) => {
      const msg = data.toString().substring(0, 500);
      messages.push(msg);
      console.log('  WS:', msg);
    });
    
    ws.on('error', (err) => {
      console.log('  WS error:', err.message.substring(0, 100));
    });
    
    setTimeout(() => {
      console.log(`  WS test complete: ${messages.length} messages`);
      if (messages.length > 0 && messages.some(m => m.includes('connection_ack'))) {
        console.log('  Connection ACK received! Subscribing...');
        ws.send(JSON.stringify({
          id: 'sub1',
          type: 'subscribe',
          payload: {
            query: 'subscription { subscribe { data topic } }',
            variables: {},
            extensions: {
              subscription: {
                read: {
                  topics: { url: '/WebApi/1004/lottery/WinGo' }
                }
              }
            }
          }
        }));
      }
      setTimeout(() => {
        ws.close();
        process.exit(0);
      }, 8000);
    }, 10000);
    
  } catch(e) {
    console.log('  ws not available:', e.message);
    
    // Fallback: raw TLS
    console.log('\n  Trying raw TLS WebSocket...');
    const tls = require('tls');
    const net = require('net');
    
    const wsKey = crypto.randomBytes(16).toString('base64');
    const host = 'pro-v3-payplatform.admin-broadcast.com';
    const path = `/event/realtime?Token=${encodeURIComponent(ACCESS_TOKEN)}`;
    
    const socket = tls.connect(443, host, { rejectUnauthorized: false }, () => {
      const handshake = [
        `GET ${path} HTTP/1.1`,
        `Host: ${host}`,
        `Connection: Upgrade`,
        `Upgrade: websocket`,
        `Sec-WebSocket-Version: 13`,
        `Sec-WebSocket-Key: ${wsKey}`,
        `Sec-WebSocket-Protocol: aws-appsync-event-ws`,
        `Origin: https://fb999.com`,
        ``, ``
      ].join('\r\n');
      
      socket.write(handshake);
    });
    
    socket.setNoDelay(true);
    let buf = Buffer.alloc(0);
    
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const resp = buf.toString('utf8');
      console.log('  Raw TLS response:', resp.substring(0, 300));
    });
    
    socket.on('error', (e) => {
      console.log('  TLS error:', e.message);
    });
    
    setTimeout(() => {
      console.log('  TLS test timeout');
      socket.end();
      process.exit(0);
    }, 10000);
  }

  // Test: Check if there's a way to get the result early via other endpoints
  console.log('\n3. Testing other endpoints with Cognito token...');
  
  // Try fb999-api-probe-v3.js style endpoints
  const altEndpoints = [
    '/api/lottery/getLotteryIssue?gameCode=WinGo_30S&token=' + ID_TOKEN,
    '/api/lottery/getRecentIssue?gameCode=WinGo_30S&token=' + ID_TOKEN,
    '/api/lottery/getCurrentIssue?gameCode=WinGo_30S&token=' + ID_TOKEN,
    '/api/webapi/GetGameIssue',  // with signed body
    '/api/webapi/GetWinTheLotteryResult',  // with signed body + TypeId
  ];
  
  for (const ep of altEndpoints) {
    try {
      let body = null;
      let headers = {};
      
      if (ep.startsWith('/api/webapi/')) {
        const params = ep.includes('GetGameIssue') ? { TypeId: 30 } : { TypeId: 30, IssueNumber: '20261020100051700' };
        body = JSON.stringify(signParams(params));
        headers = { 'Authorization': `Bearer ${ACCESS_TOKEN}` };
      }
      
      const res = await httpRequest('fb999api.com', ep, body ? 'POST' : 'GET', body, headers);
      
      if (res.status !== 404) {
        console.log(`  ${ep}: ${res.status}`);
        console.log(`    ${res.body.substring(0, 200)}`);
      }
    } catch(e) {
      // Skip
    }
  }
}

main().catch(e => console.error('Error:', e.message));
