const express = require('express');
const WebSocket = require('ws');
const crypto = require('crypto');
const http = require('http');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());

// Store for active connections and state
const clients = new Set();
let gameState = {
  status: 'idle',
  currentIssue: null,
  nextIssue: null,
  timeToClose: null,
  lastResult: null,
  raceWindow: null,
  betPlaced: false
};

// === API Signing ===
function ne() { 
  return crypto.randomBytes(16).toString('hex'); 
}

function we(str) { 
  return crypto.createHash('md5').update(str).digest('hex').toUpperCase().slice(0, 32); 
}

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

// === HTTP Request Functions ===
function httpGet(hostname, path) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname, path, method: 'GET' }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.end();
  });
}

function httpsPost(hostname, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const allHeaders = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
      'Referer': 'https://fb999.com/',
      'Origin': 'https://fb999.com',
      'ar-origin': 'https://fb999.com',
      ...headers
    };
    allHeaders['Content-Length'] = Buffer.byteLength(body);
    
    const req = http.request({ hostname, path, method: 'POST', headers: allHeaders }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(body);
    req.end();
  });
}

// === JWT Management ===
function getJwt() {
  try {
    const loginData = JSON.parse(fs.readFileSync('/tmp/fb999_login_response.json', 'utf8'));
    return loginData.data?.token;
  } catch (e) {
    return null;
  }
}

function isJwtValid() {
  try {
    const loginData = JSON.parse(fs.readFileSync('/tmp/fb999_login_response.json', 'utf8'));
    const exp = loginData.data?.expiresIn || 0;
    return exp > Math.floor(Date.now() / 1000);
  } catch (e) {
    return false;
  }
}

// === WebSocket Broadcasting ===
function broadcast(data) {
  const json = JSON.stringify(data);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(json);
    }
  }
}

// WebSocket connection handling
wss.on('connection', (ws, req) => {
  console.log('Client connected');
  clients.add(ws);
  
  // Send initial state
  ws.send(JSON.stringify({ type: 'GAME_STATE', data: gameState }));
  
  ws.on('close', () => {
    console.log('Client disconnected');
    clients.delete(ws);
  });
  
  ws.on('error', (err) => {
    console.error('WebSocket error:', err.message);
    clients.delete(ws);
  });
  
  // Handle client commands
  ws.on('message', (message) => {
    try {
      const msg = JSON.parse(message.toString());
      handleClientMessage(ws, msg);
    } catch (e) {
      console.error('Error parsing message:', e);
    }
  });
});

function handleClientMessage(ws, msg) {
  switch (msg.type) {
    case 'START_MONITORING':
      startMonitoring();
      ws.send(JSON.stringify({ type: 'MONITORING_STARTED' }));
      break;
    case 'STOP_MONITORING':
      stopMonitoring();
      ws.send(JSON.stringify({ type: 'MONITORING_STOPPED' }));
      break;
    case 'PLACE_BET':
      placeBet(msg.data);
      break;
  }
}

// === Race Condition Detection ===
let monitoring = false;
let lastResult = '';
let monitoringInterval = null;

function startMonitoring() {
  if (monitoring) return;
  monitoring = true;
  console.log('Starting race condition monitoring...');
  lastResult = '';
  monitoringInterval = setInterval(monitorRaceWindow, 50); // 50ms polling
}

function stopMonitoring() {
  monitoring = false;
  if (monitoringInterval) {
    clearInterval(monitoringInterval);
    monitoringInterval = null;
  }
  console.log('Monitoring stopped');
}

async function monitorRaceWindow() {
  try {
    // Get current round info
    const config = JSON.parse((await httpGet('draw.ar-lottery06.com', '/WinGo/WinGo_30S.json')).body);
    const currentEnd = new Date(config.current.endTime).getTime();
    const now = Date.now();
    const msToClose = currentEnd - now;
    
    // Get latest result
    const histRes = await httpGet('draw.ar-lottery06.com',
      '/WinGo/WinGo_30S/GetHistoryIssuePage.json?pageNo=1&pageSize=10');
    
    let detectedResult = null;
    if (histRes.status === 200) {
      const data = JSON.parse(histRes.body);
      const list = data.data?.list || [];
      
      if (list.length > 0 && list[0].issueNumber !== lastResult) {
        lastResult = list[0].issueNumber;
        detectedResult = {
          issueNumber: list[0].issueNumber,
          number: list[0].number,
          color: list[0].color,
          msToClose: msToClose,
          time: new Date().toISOString()
        };
        
        // Check if in race window (result detected before round closes)
        if (msToClose > 2000) {
          gameState.raceWindow = {
            active: true,
            msRemaining: msToClose,
            result: detectedResult.number,
            color: getColorCategory(detectedResult.number)
          };
          
          broadcast({
            type: 'RACE_WINDOW_DETECTED',
            data: gameState.raceWindow
          });
          
          console.log(`⚡ Race window: ${msToClose}ms before close, result=${detectedResult.number}`);
        }
      }
    }
    
    // Update game state
    gameState = {
      ...gameState,
      status: 'active',
      currentIssue: config.current.issueNumber,
      nextIssue: config.next.issueNumber,
      timeToClose: msToClose,
      lastResult: detectedResult
    };
    
    broadcast({ type: 'GAME_STATE_UPDATE', data: gameState });
    
  } catch (e) {
    console.error('Monitor error:', e.message);
  }
}

function getColorCategory(n) {
  n = parseInt(n);
  if (n === 0) return 'Violet';
  if ([1,3,5,7,9].includes(n)) return 'Red';
  return 'Green';
}

// === Bet Placement ===
async function placeBet(data) {
  const { SelectType, Amount, BetCount } = data;
  
  if (!isJwtValid()) {
    broadcast({ type: 'BET_RESULT', data: { success: false, error: 'JWT expired' } });
    return;
  }
  
  const jwt = getJwt();
  
  // Get current issue
  const config = JSON.parse((await httpGet('draw.ar-lottery06.com', '/WinGo/WinGo_30S.json')).body);
  const currentIssue = config.current.issueNumber;
  
  // Prepare bet request
  const body = JSON.stringify(signParams({
    TypeId: 30,
    lottery: 'WinGo',
    gameCode: 'WinGo_30S',
    issueNumber: currentIssue,
    BetCount: BetCount || 1,
    Amount: Amount || 1,
    SelectType: SelectType || 'Red'
  }));
  
  try {
    const res = await httpsPost('fb999api.com', '/api/webapi/GameBetting', body, {
      'Authorization': `Bearer ${jwt}`
    });
    
    const result = {
      success: res.status === 200,
      status: res.status,
      data: res.body
    };
    
    try {
      const json = JSON.parse(res.body);
      result.code = json.code;
      result.msg = json.msg;
      result.betSuccessful = json.code === 0;
    } catch (e) {
      // Non-JSON response
    }
    
    broadcast({ type: 'BET_RESULT', data: result });
    console.log('Bet result:', JSON.stringify(result));
  } catch (e) {
    broadcast({ type: 'BET_RESULT', data: { success: false, error: e.message } });
  }
}

// === REST API Endpoint ===
app.get('/api/status', (req, res) => {
  res.json({
    ...gameState,
    jwtValid: isJwtValid(),
    clients: clients.size
  });
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.post('/api/bet', (req, res) => {
  const { SelectType, Amount, BetCount } = req.body;
  const body = JSON.stringify(signParams({
    TypeId: 30,
    lottery: 'WinGo',
    gameCode: 'WinGo_30S',
    issueNumber: gameState.currentIssue,
    BetCount: BetCount || 1,
    Amount: Amount || 1,
    SelectType: SelectType || 'Red'
  }));
  
  const jwt = getJwt();
  httpsPost('fb999api.com', '/api/webapi/GameBetting', body, {
    'Authorization': `Bearer ${jwt}`
  }).then(result => {
    res.json(result);
  }).catch(e => {
    res.status(500).json({ error: e.message });
  });
});

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`WinGo Racer server running on port ${PORT}`);
});
