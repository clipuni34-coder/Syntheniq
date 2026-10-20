#!/usr/bin/env node
/**
 * WinGo_30S — Race Condition Exploiter App
 * 
 * Railway.app deployment entry point
 * 
 * Endpoints:
 * - GET  /           → Dashboard HTML
 * - GET  /health      → Health check
 * - GET  /status      → Current status (JWT, betting mode, etc.)
 * - POST /login       → Refresh JWT token
 * - GET  /prediction  → Latest prediction
 * - POST /race        → Start race monitoring
 * - GET  /results     → Race results history
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const crypto = require('crypto');
const { execSync, spawn } = require('child_process');

const PORT = process.env.PORT || 3000;
const JWT_FILE = '/tmp/fb999_login_response.json';

// === Utility Functions ===
function getJwt() {
  try {
    const data = JSON.parse(fs.readFileSync(JWT_FILE, 'utf8'));
    return data.data?.token;
  } catch (e) {
    return null;
  }
}

function isJwtValid() {
  try {
    const data = JSON.parse(fs.readFileSync(JWT_FILE, 'utf8'));
    const exp = data.data?.expiresIn;
    return exp && (exp * 1000) > Date.now();
  } catch (e) {
    return false;
  }
}

function refreshJwt() {
  return new Promise((resolve, reject) => {
    execSync('node /app/scripts/refreshJwt.js', { stdio: 'inherit' });
    resolve(isJwtValid());
  });
}

// === HTTP Server ===
const server = http.createServer(async (req, res) => {
  const url = req.url.split('?')[0];
  
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');
  
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }
  
  // === Health Check ===
  if (url === '/health') {
    res.writeHead(200);
    res.end(JSON.stringify({ 
      status: 'ok', 
      timestamp: new Date().toISOString(),
      jwt_valid: isJwtValid()
    }));
    return;
  }
  
  // === Status ===
  if (url === '/status') {
    const jwt = getJwt();
    let prediction = null;
    let raceWins = null;
    
    try {
      const history = JSON.parse(fs.readFileSync('/tmp/wingo_history.json', 'utf8'));
      prediction = history.results?.[0];
    } catch (e) {}
    
    try {
      raceWins = fs.readFileSync('/tmp/wingo_race_wins.txt', 'utf8');
    } catch (e) {}
    
    res.writeHead(200);
    res.end(JSON.stringify({
      jwt_valid: isJwtValid(),
      jwt_expires: jwt ? new Date(JSON.parse(fs.readFileSync(JWT_FILE, 'utf8')).data.expiresIn * 1000).toISOString() : null,
      prediction: prediction,
      race_wins: raceWins,
      server_time: new Date().toISOString()
    }));
    return;
  }
  
  // === Login / Refresh JWT ===
  if (url === '/login' && req.method === 'POST') {
    try {
      await refreshJwt();
      res.writeHead(200);
      res.end(JSON.stringify({ 
        success: true, 
        jwt_valid: isJwtValid() 
      }));
    } catch (e) {
      res.writeHead(500);
      res.end(JSON.stringify({ 
        success: false, 
        error: e.message 
      }));
    }
    return;
  }
  
  // === Get Prediction ===
  if (url === '/prediction') {
    try {
      const history = JSON.parse(fs.readFileSync('/tmp/wingo_history.json', 'utf8'));
      const latest = history.results?.[0];
      res.writeHead(200);
      res.end(JSON.stringify({ 
        latest_result: latest,
        history_count: history.results?.length || 0
      }));
    } catch (e) {
      res.writeHead(200);
      res.end(JSON.stringify({ 
        latest_result: null, 
        history_count: 0 
      }));
    }
    return;
  }
  
  // === Start Race Monitor ===
  if (url === '/race' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', async () => {
      try {
        // Run race exploiter in background
        const proc = spawn('node', ['/app/scripts/winGoRaceFinal.js'], {
          detached: true,
          stdio: 'ignore'
        });
        proc.unref();
        
        res.writeHead(200);
        res.end(JSON.stringify({ 
          success: true, 
          message: 'Race monitoring started',
          pid: proc.pid
        }));
      } catch (e) {
        res.writeHead(500);
        res.end(JSON.stringify({ success: false, error: e.message }));
      }
    });
    return;
  }
  
  // === Get Race Results ===
  if (url === '/results') {
    let results = '';
    try {
      results = fs.readFileSync('/tmp/wingo_race_wins.txt', 'utf8');
    } catch (e) {
      results = 'No race wins recorded yet';
    }
    let log = '';
    try {
      log = fs.readFileSync('/tmp/wingo_race_log.txt', 'utf8');
    } catch (e) {
      log = 'No race log yet';
    }
    res.writeHead(200);
    res.end(JSON.stringify({ 
      wins: results,
      log: log
    }));
    return;
  }
  
  // === Dashboard HTML ===
  if (url === '/') {
    res.setHeader('Content-Type', 'text/html');
    res.writeHead(200);
    res.end(`
<!DOCTYPE html>
<html>
<head>
  <title>WinGo_30S Race Condition Exploiter</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin: 40px; background: #1a1a2e; color: #eee; }
    h1 { color: #00d4ff; }
    .card { background: #16213e; padding: 20px; margin: 10px 0; border-radius: 8px; border: 1px solid #0f3460; }
    .status { display: inline-block; padding: 4px 12px; border-radius: 4px; font-weight: bold; }
    .green { background: #00c853; color: white; }
    .red { background: #ff1744; color: white; }
    .yellow { background: #ffd600; color: black; }
    button { background: #00d4ff; color: #1a1a2e; border: none; padding: 10px 20px; border-radius: 4px; cursor: pointer; margin: 5px; font-weight: bold; }
    button:hover { background: #0099cc; }
    pre { background: #0f0f23; padding: 15px; border-radius: 4px; overflow-x: auto; font-size: 12px; max-height: 300px; overflow-y: auto; }
    .log { white-space: pre-wrap; }
  </style>
</head>
<body>
  <h1>WinGo_30S Race Condition Exploiter</h1>
  
  <div class="card">
    <h3>System Status</h3>
    <div id="status">Loading...</div>
  </div>
  
  <div class="card">
    <h3>Controls</h3>
    <button onclick="refreshJwt()">Refresh JWT</button>
    <button onclick="startRace()">Start Race Monitor</button>
    <button onclick="getResults()">Get Results</button>
    <button onclick="getStatus()">Refresh Status</button>
  </div>
  
  <div class="card">
    <h3>Race Results</h3>
    <pre id="results">No results yet</pre>
  </div>
  
  <div class="card">
    <h3>Race Log</h3>
    <pre id="log" class="log">No log yet</pre>
  </div>

  <script>
    async function getStatus() {
      const res = await fetch('/status');
      const data = await res.json();
      const jwtStatus = data.jwt_valid ? '<span class="status green">VALID</span>' : '<span class="status red">EXPIRED</span>';
      document.getElementById('status').innerHTML = `
        <p>JWT: ${jwtStatus}</p>
        <p>Expires: ${data.jwt_expires || 'N/A'}</p>
        <p>Server Time: ${data.server_time}</p>
      `;
    }
    
    async function refreshJwt() {
      const res = await fetch('/login', { method: 'POST' });
      const data = await res.json();
      alert(data.success ? 'JWT refreshed!' : 'Failed: ' + data.error);
      getStatus();
    }
    
    async function startRace() {
      const res = await fetch('/race', { method: 'POST' });
      const data = await res.json();
      alert(data.success ? 'Race monitoring started!' : 'Failed: ' + data.error);
    }
    
    async function getResults() {
      const res = await fetch('/results');
      const data = await res.json();
      document.getElementById('results').textContent = data.wins || 'No wins';
      document.getElementById('log').textContent = data.log || 'No log';
    }
    
    getStatus();
    getResults();
    setInterval(getStatus, 10000);
    setInterval(getResults, 15000);
  </script>
</body>
</html>
    `);
    return;
  }
  
  // === 404 ===
  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, () => {
  console.log(`WinGo_30S App running on port ${PORT}`);
  console.log(`Dashboard: http://localhost:${PORT}`);
  console.log(`Health: http://localhost:${PORT}/health`);
});

// Auto-refresh JWT every 25 minutes
setInterval(async () => {
  try {
    execSync('node /app/scripts/refreshJwt.js', { stdio: 'ignore' });
    console.log('JWT auto-refreshed');
  } catch (e) {
    console.error('JWT refresh failed:', e.message);
  }
}, 25 * 60 * 1000);
