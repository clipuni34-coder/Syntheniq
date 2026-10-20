#!/usr/bin/env node
/**
 * WinGo_30S — Early Result Detector (via WebSocket real-time push)
 * 
 * Uses the user's JWT to connect to AppSync Events WebSocket.
 * If the WebSocket pushes results, we can detect them as early as the server publishes them.
 * Falls back to 100ms HTTP polling (draw server) for ~2.4s early detection.
 *
 * Usage: node winGoEarlyDetector.js <jwt-token>
 */

const https = require('http');  // Will use https module directly below
const fs = require('fs');

const JWT = process.argv[2];
if (!JWT) {
  console.error('Usage: node winGoEarlyDetector.js <jwt-token>');
  console.error('If no token: runs HTTP-only mode');
}

const httpsModule = require('https');

function httpRequest(hostname, path) {
  return new Promise((resolve, reject) => {
    const req = httpsModule.request({ hostname, path, method: 'GET' }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.end();
  });
}

function classify(n) {
  n = parseInt(n);
  if (n === 0) return 'VIOLET(0)';
  if (n >= 5) return 'BIG(' + n + ')';
  return 'SMALL(' + n + ')';
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// WebSocket connection using raw TLS (no external deps)
async function tryWebSocket(jwt) {
  console.log('\n--- Attempting WebSocket real-time push ---');
  
  try {
    const WebSocket = require('ws'); // Try ws module first
    
    const wsUrl = 'wss://pro-v3-payplatform.admin-broadcast.com/event/realtime';
    console.log('Connecting to:', wsUrl);
    
    const ws = new WebSocket(wsUrl, 'aws-appsync-event-ws', {
      headers: {
        'Origin': 'https://fb999.com',
        'Referer': 'https://fb999.com/',
        'Authorization': jwt,
      },
    });
    
    let messages = [];
    let subbed = false;
    
    ws.on('open', () => {
      console.log('✓ WebSocket connected');
      ws.send(JSON.stringify({ type: 'connection_init', payload: {} }));
    });
    
    ws.on('message', (data) => {
      messages.push(data.toString());
      const msg = data.toString().substring(0, 300);
      console.log('  ⚡', msg);
      
      if (msg.includes('connection_ack') && !subbed) {
        subbed = true;
        console.log('  → Subscribing to /WebApi/1004/lottery/WinGo...');
        ws.send(JSON.stringify({
          id: 'sub1',
          type: 'subscribe',
          payload: {
            query: 'subscription { onLotteryResult { number issueNumber color } }',
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
    });
    
    ws.on('error', (err) => {
      console.log('  WS error:', err.message.substring(0, 100));
    });
    
    return ws;
  } catch(e) {
    console.log('  ws module not available, using raw approach');
    return null;
  }
}

async function main() {
  console.log('=== WinGo_30S Early Result Detector ===');
  console.log('Goal: Get actual result before countdown ends\n');
  
  let ws = null;
  if (JWT) {
    ws = await tryWebSocket(JWT);
  }
  
  // Load history
  let history = [];
  try {
    const h = JSON.parse(fs.readFileSync('/tmp/wingo_history.json', 'utf8'));
    history = h.results || [];
  } catch(e) {}
  
  console.log('\n--- HTTP Polling (draw server, no auth) ---');
  console.log('Detecting results ~2.4s before countdown end...\n');
  
  let lastIssue = '';
  let resultsCount = 0;
  
  // Get initial config
  let config = JSON.parse((await httpRequest('draw.ar-lottery06.com', '/WinGo/WinGo_30S.json')).body);
  console.log(`Current issue: ${config.current.issueNumber}`);
  console.log(`Next issue: ${config.next.issueNumber}`);
  console.log(`Next close: ${new Date(config.next.endTime).toISOString()}`);
  console.log(`Time to close: ${(config.current.endTime - Date.now())/1000}s\n`);
  
  // Continuous polling loop
  while (true) {
    try {
      config = JSON.parse((await httpRequest('draw.ar-lottery06.com', '/WinGo/WinGo_30S.json')).body);
      
      const res = await httpRequest('draw.ar-lottery06.com',
        '/WinGo/WinGo_30S/GetHistoryIssuePage.json?pageNo=1&pageSize=10');
      
      if (res.status === 200) {
        const data = JSON.parse(res.body);
        const list = data.data?.list || [];
        
        if (list.length > 0 && list[0].issueNumber !== lastIssue) {
          lastIssue = list[0].issueNumber;
          const latest = list[0];
          const msFromClose = Date.now() - config.current.endTime;
          
          resultsCount++;
          
          console.log(`[${new Date().toLocaleTimeString()}] 🎯 RESULT: ${latest.issueNumber} → ${classify(latest.number)}`);
          console.log(`  ${Math.abs(msFromClose)}ms ${msFromClose < 0 ? 'BEFORE' : 'AFTER'} countdown end`);
          if (msFromClose < 0) console.log(`  ⏱️ ${Math.abs(msFromClose)/1000}s before round ends!`);
          
          fs.appendFileSync('/tmp/wingo_early_results.txt',
            `[${new Date().toISOString()}] ${latest.issueNumber} → ${latest.number} (${classify(latest.number)}) | ${msFromClose}ms from close\n`);
          
          history.unshift({ issueNumber: latest.issueNumber, number: latest.number });
          history = history.slice(0, 50);
          fs.writeFileSync('/tmp/wingo_history.json', JSON.stringify({ results: history }, null, 2));
        }
      }
    } catch(e) {
      // Continue
    }
    
    await sleep(100);
  }
}

main().catch(e => console.error('Error:', e.message));
