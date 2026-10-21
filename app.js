#!/usr/bin/env node
/**
 * WinGo_30S — Production Race Condition App
 * 
 * Features:
 * - Continuous race window monitoring (50ms polling)
 * - Automatic JWT refresh every 25 minutes
 * - Discord webhook alerts for race windows and results
 * - Web dashboard for monitoring
 * - Background monitoring service
 * 
 * Deployment: Fly.io / Docker / Any Node.js host
 * 
 * Health check: /health
 * Status: /api/status
 * Events: /api/events
 * Webhook: Discord alerts for race results
 */

const express = require('express');
const WebSocket = require('ws');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

// === Configuration ===
const PORT = process.env.PORT || 3000;
const FB999_PHONE = process.env.FB999_PHONE || '2349121493739';
const FB999_PASSWORD = process.env.FB999_PASSWORD || 'Drewziwugod6';
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK_URL || null;

const app = express();
app.use(express.json());
app.use(express.static('public'));

// === State Management ===
const state = {
  jwt: null,
  jwtExpiry: 0,
  raceWins: [],
  events: [],
  monitoring: false,
  lastResult: null,
  lastRaceWindow: null,
  lastLoginError: null,
  bettingEnabled: true,  // Toggle: false to stop placing bets
  stats: {
    roundsDetected: 0,
    raceWindowsFound: 0,
    betsPlaced: 0,
    wins: 0,
    losses: 0
  }
};

// === API Signing (from winGoApiSearch.js) ===
function randomHex() { 
  return crypto.randomBytes(16).toString('hex'); 
}

function md5Hex(str) { 
  return crypto.createHash('md5').update(str).digest('hex').toUpperCase().slice(0, 32); 
}

function signParams(params) {
  const u = { ...params, language: 0 };
  u.random = randomHex();
  const c = JSON.parse(JSON.stringify(u));
  const o = Object.keys(c).filter(key =>
    !(typeof c[key] === 'object' && c[key] !== null && !Array.isArray(c[key])) && !Array.isArray(c[key]));
  o.sort();
  const i = {};
  o.forEach(key => { if (c[key] !== null && c[key] !== "" && c[key] !== undefined) i[key] = c[key] === 0 ? 0 : c[key]; });
  u.signature = md5Hex(JSON.stringify(i));
  u.timestamp = Math.floor(Date.now() / 1e3);
  return u;
}

// === HTTP Request Helpers ===
function httpRequest(hostname, path, method = 'GET', body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const allHeaders = {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15',
      'Referer': 'https://fb999.com/',
      'Origin': 'https://fb999.com',
      'ar-origin': 'https://fb999.com',
      ...headers
    };
    if (body) {
      allHeaders['Content-Length'] = Buffer.byteLength(body);
    }
    
    const req = https.request({
      hostname,
      path,
      method,
      headers: allHeaders
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (body) {
      req.write(body);
    }
    req.end();
  });
}

// === JWT Management ===
function toLocalNumber(full) {
  const n = String(full || '').replace(/\s+/g, '').replace(/^\+/, '');
  return n.startsWith('234') ? n.slice(3) : n;
}

function loadJwt() {
  try {
    const loginData = JSON.parse(fs.readFileSync('/tmp/fb999_login_response.json', 'utf8'));
    const token = loginData.data?.token;
    const exp = loginData.data?.expiresIn || 0;
    
    if (token && exp > Math.floor(Date.now() / 1000)) {
      return token;
    }
  } catch (e) {}
  return null;
}

// Capture the POST /Login API response (single attempt)
function waitForLoginResponse(page, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out after ${timeoutMs}ms waiting for POST /Login response`)),
      timeoutMs
    );
    page.on('response', async res => {
      try {
        if (res.request().method() !== 'POST') return;
        const url = res.url();
        if (!url.includes('fb999api.com') || !url.endsWith('/Login')) return;
        let reqBody = '';
        try { reqBody = res.request().postData() || ''; } catch (e) { reqBody = ''; }
        if (!reqBody || !reqBody.includes('username')) return; // skip empty duplicate
        clearTimeout(timer);
        let body = '';
        try { body = await res.text(); } catch (e) { body = ''; }
        let json = null, parseError = null;
        try { json = body ? JSON.parse(body) : null; } catch (e) { parseError = e.message; }
        resolve({ status: res.status(), body, json, parseError });
      } catch (e) {
        /* keep listening */
      }
    });
  });
}

async function refreshJwt() {
  console.log('Refreshing JWT token...');
  
  const puppeteer = require('puppeteer');
  const LOCAL_NUMBER = toLocalNumber(FB999_PHONE);
  
  console.log('  Phone:', FB999_PHONE);
  console.log('  Local number:', LOCAL_NUMBER);
  
  // Try system Chromium first, fall back to puppeteer's bundled Chromium
  let executablePath = null;
  try {
    // Check if system Chromium exists
    if (fs.existsSync('/usr/bin/chromium')) {
      executablePath = '/usr/bin/chromium';
    } else if (fs.existsSync('/usr/bin/chromium-browser')) {
      executablePath = '/usr/bin/chromium-browser';
    } else if (fs.existsSync('/usr/bin/google-chrome')) {
      executablePath = '/usr/bin/google-chrome';
    } else if (fs.existsSync('/usr/bin/google-chrome-stable')) {
      executablePath = '/usr/bin/google-chrome-stable';
    } else {
      // Try puppeteer's bundled Chromium
      const defaultPath = puppeteer.executablePath();
      if (defaultPath && fs.existsSync(defaultPath)) {
        executablePath = defaultPath;
      }
    }
    console.log('  Chromium executable:', executablePath || 'default (puppeteer bundled)');
  } catch (e) {
    console.log('  Using default Chromium');
  }
  
  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath,
    ignoreHTTPSErrors: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--window-size=414,896',
      '--ignore-certificate-errors',
      '--disable-blink-features=AutomationDetected,IsolateOrigins,IOSurfaceSharing',
      '--disable-features=EncryptedClientHello'
    ]
  });
  
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1');
  await page.setViewport({ width: 414, height: 896, isMobile: true });
  
  // Capture login requests for debugging
  let loginRequests = [];
  page.on('request', req => {
    try {
      const url = req.url();
      if (url.includes('fb999api.com') && url.endsWith('/Login')) {
        loginRequests.push({
          method: req.method(),
          url,
          postData: req.postData() || '',
        });
      }
    } catch (e) {}
  });
  
  page.on('console', msg => console.log(`  [page] ${msg.text()}`));
  
  try {
    // Navigate to login page
    console.log('  Navigating to fb999.com/#/login...');
    await page.goto('https://fb999.com/#/login', { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 3000));
    
    // Fill local phone number
    try {
      await page.waitForSelector('input[name="userNumber"]', { visible: true, timeout: 10000 });
      await page.click('input[name="userNumber"]');
      await page.type('input[name="userNumber"]', LOCAL_NUMBER, { delay: 40 });
      console.log('  Filled userNumber:', LOCAL_NUMBER);
    } catch (e) {
      state.lastLoginError = 'Could not find userNumber input: ' + e.message;
      console.error('  userNumber input error:', e.message);
      await page.screenshot({ path: '/tmp/login_error_user.png' }).catch(() => {});
      return false;
    }
    
    // Fill password (first VISIBLE password input)
    try {
      const pwdHandle = await page.waitForSelector('input[type="password"]', { visible: true, timeout: 10000 });
      await pwdHandle.click();
      await pwdHandle.type(FB999_PASSWORD, { delay: 40 });
      console.log('  Filled password');
    } catch (e) {
      state.lastLoginError = 'Could not find password input: ' + e.message;
      console.error('  Password input error:', e.message);
      await page.screenshot({ path: '/tmp/login_error_pwd.png' }).catch(() => {});
      return false;
    }
    
    // Click the visible "Log in" button (must be visible + match regex)
    // The fb999.com SPA may render the button with text like "Log in", "Login", "Sign In", or "Đăng nhập"
    try {
      console.log('  Waiting for login button...');
      await page.waitForFunction(() => {
        const btns = Array.from(document.querySelectorAll('button'));
        return btns.some(b => {
          const r = b.getBoundingClientRect();
          const s = window.getComputedStyle(b);
          const text = (b.textContent || '').trim().toLowerCase();
          return r.width > 0 && r.height > 0
            && s.visibility !== 'hidden' && s.display !== 'none'
            && b.offsetParent !== null
            && (
              /log\s*in/i.test(text) ||
              text.includes('login') ||
              text.includes('sign in') ||
              text.includes('đăng nhập') ||
              text.includes('đăng') ||
              text.includes('submit')
            );
        });
      }, { timeout: 15000 });
      
      const clicked = await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('button'));
        for (const b of btns) {
          const r = b.getBoundingClientRect();
          const s = window.getComputedStyle(b);
          const visible = r.width > 0 && r.height > 0
            && s.visibility !== 'hidden' && s.display !== 'none'
            && b.offsetParent !== null;
          if (!visible) continue;
          const text = (b.textContent || '').trim().toLowerCase();
          if (
            /log\s*in/i.test(text) ||
            text.includes('login') ||
            text.includes('sign in') ||
            text.includes('đăng nhập') ||
            text.includes('đăng') ||
            text.includes('submit')
          ) {
            b.click();
            return { found: true, text: b.textContent.trim(), className: b.className };
          }
        }
        // Fallback: click any visible button that's a submit type
        const submitBtn = Array.from(document.querySelectorAll('button[type="submit"]')).find(b => {
          const r = b.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && b.offsetParent !== null;
        });
        if (submitBtn) {
          submitBtn.click();
          return { found: true, text: submitBtn.textContent.trim(), className: submitBtn.className, fallback: true };
        }
        return { found: false };
      });
      console.log('  Submit button clicked:', JSON.stringify(clicked));
      
      if (!clicked.found) {
        state.lastLoginError = 'No visible login button found. Page may have anti-bot protection.';
        await page.screenshot({ path: '/tmp/login_no_btn.png' }).catch(() => {});
        return false;
      }
    } catch (e) {
      state.lastLoginError = 'Could not find login button: ' + e.message;
      console.error('  Login button error:', e.message);
      await page.screenshot({ path: '/tmp/login_error_btn.png' }).catch(() => {});
      return false;
    }
    
    // Wait for the /Login API response
    console.log('  Waiting for /Login API response...');
    let resp;
    try {
      resp = await waitForLoginResponse(page, 30000);
      console.log('  /Login response received, status:', resp.status);
    } catch (e) {
      state.lastLoginError = 'No /Login API response: ' + e.message;
      console.error('  /Login response error:', e.message);
      await page.screenshot({ path: '/tmp/login_error_resp.png' }).catch(() => {});
      return false;
    }
    
    // Log the request body that was sent
    if (loginRequests.length > 0) {
      console.log('  /Login request body:', loginRequests[0].postData);
    }
    
    // Allow SPA to set localStorage
    await new Promise(r => setTimeout(r, 3000));
    
    // Read localStorage
    const storage = await page.evaluate(() => {
      const result = {};
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key) result[key] = localStorage.getItem(key);
      }
      return result;
    });
    console.log('  localStorage keys:', Object.keys(storage).join(', '));
    
    // Extract token (prefer response, fall back to localStorage)
    let token = null;
    if (resp && resp.json && resp.json.data) {
      token = resp.json.data.token || resp.json.data.jwt || resp.json.data.accessToken;
    }
    const arToken = storage.ar_token;
    if (arToken) token = arToken;
    
    if (token) {
      console.log('  JWT refreshed successfully!');
      
      let exp = 0;
      try {
        const parts = token.split('.');
        if (parts.length === 3) {
          const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
          exp = payload.exp || (Math.floor(Date.now() / 1000) + 1800);
        } else {
          exp = Math.floor(Date.now() / 1000) + 1800;
        }
      } catch (e) {
        exp = Math.floor(Date.now() / 1000) + 1800;
      }
      
      state.jwt = token;
      state.jwtExpiry = exp;
      state.lastLoginError = null;
      
      // Save to file
      const loginResponse = {
        data: {
          token: token,
          expiresIn: exp,
          webSocketUrl: storage.ar_ws_url || resp.json?.data?.webSocketUrl,
          webSocketChannels: storage.ar_ws_channels || JSON.stringify(resp.json?.data?.webSocketChannels)
        },
        code: 0,
        msg: 'Succeed'
      };
      fs.writeFileSync('/tmp/fb999_login_response.json', JSON.stringify(loginResponse, null, 2));
      
      return true;
    } else {
      state.lastLoginError = 'No token found after login. Response code/msg: ' + 
        (resp?.json?.code || 'unknown') + ' / ' + (resp?.json?.msg || 'no msg');
      console.log('  No token found after login');
      console.log('  Response:', JSON.stringify(resp?.json).substring(0, 500));
      return false;
    }
  } catch (e) {
    state.lastLoginError = 'Login error: ' + e.message;
    console.error('  Login error:', e.message);
    return false;
  } finally {
    await browser.close();
  }
}

// === Discord Webhook ===
function sendDiscordAlert(message, type = 'info') {
  if (!DISCORD_WEBHOOK) return;
  
  const payload = JSON.stringify({
    embeds: [{
      title: `WinGo Racer Alert [${type.toUpperCase()}]`,
      description: message,
      color: type === 'success' ? 0x00ff00 : type === 'error' ? 0xff0000 : 0x00aaff,
      timestamp: new Date().toISOString()
    }]
  });
  
  httpRequest('discord.com', `/api/webhooks/${DISCORD_WEBHOOK.split('/').slice(-2).join('/')}`, 'POST', payload)
    .catch(e => console.error('Discord webhook error:', e.message));
}

// === Number Classifiers ===
function numberToColor(n) {
  n = parseInt(n);
  if (n === 0) return 'Violet';
  if ([1, 3, 5, 7, 9].includes(n)) return 'Red';
  return 'Green';
}

function classify(n) {
  n = parseInt(n);
  if (n === 0) return 'violet';
  if (n >= 5) return 'big';
  return 'small';
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// === Race Condition Detection ===
let lastDetectedIssue = '';
let raceWindow = false;

async function startRaceMonitoring() {
  console.log('Starting race condition monitor...');
  state.monitoring = true;
  
  while (state.monitoring) {
    try {
      // Check JWT
      if (!state.jwt || Date.now() > state.jwtExpiry * 1000 - 60000) {
        console.log('JWT expired, refreshing...');
        await refreshJwt();
        await sleep(5000);
        continue;
      }
      
      // Get current round
      const config = JSON.parse((await httpRequest('draw.ar-lottery06.com', '/WinGo/WinGo_30S.json')).body);
      const currentEnd = new Date(config.current.endTime).getTime();
      const now = Date.now();
      const msToClose = currentEnd - now;
      
      // Get latest result
      const histRes = await httpRequest('draw.ar-lottery06.com',
        '/WinGo/WinGo_30S/GetHistoryIssuePage.json?pageNo=1&pageSize=10');
      const list = JSON.parse(histRes.body).data?.list || [];
      
      if (list.length > 0 && list[0].issueNumber !== lastDetectedIssue) {
        lastDetectedIssue = list[0].issueNumber;
        const resultNum = list[0].number;
        const resultColor = numberToColor(resultNum);
        
        state.lastResult = {
          issueNumber: list[0].issueNumber,
          number: resultNum,
          color: resultColor,
          timestamp: new Date().toISOString()
        };
        
        state.stats.roundsDetected++;
        
        console.log(`[${new Date().toLocaleTimeString()}] Result: ${resultNum} (${resultColor})`);
        console.log(`  ${Math.round(msToClose/1000)}s to current round close`);
        
        // Check for race window
        if (msToClose > 2000 && msToClose < 35000) {
          raceWindow = true;
          state.lastRaceWindow = {
            color: resultColor,
            number: resultNum,
            msToClose: msToClose,
            timestamp: new Date().toISOString()
          };
          
          state.stats.raceWindowsFound++;
          
          console.log(`⚡ RACE WINDOW! ${Math.round(msToClose/1000)}s remaining`);
          sendDiscordAlert(
            `**Race Window Detected!**\n` +
            `Result: ${resultNum} (${resultColor})\n` +
            `Time to close: ${Math.round(msToClose/1000)}s\n` +
            `Placing bets on next round (${config.next?.issueNumber})...`,
            'success'
          );
          
            // Place race bets only if betting is enabled
            if (state.bettingEnabled) {
              await executeRaceBets(resultColor, config.next?.issueNumber || config.current.issueNumber);
            } else {
              console.log('Betting paused - race window detected but not placing bets');
            }
           
           raceWindow = false;
        }
      }
      
    } catch (e) {
      console.error('Monitor error:', e.message);
    }
    
    // Continue polling even during race
    if (!raceWindow) {
      await sleep(50);
    }
  }
}

async function executeRaceBets(color, issueNumber) {
  console.log(`Executing race bets on ${color}...`);
  
    const betPromises = [];
    const BET_COUNT = 1;  // 1 bet per race window (human-like)
    for (let i = 0; i < BET_COUNT; i++) {
    const body = JSON.stringify(signParams({
      TypeId: 30,
      lottery: 'WinGo',
      gameCode: 'WinGo_30S',
      issueNumber: issueNumber,
      BetCount: 1,
       Amount: 100,  // ₦100 bet amount
      SelectType: color
    }));
    
    betPromises.push(
      httpRequest('fb999api.com', '/api/webapi/GameBetting', 'POST', body, {
        'Authorization': `Bearer ${state.jwt}`
      }).then(res => {
        state.stats.betsPlaced++;
        
        try {
          const json = JSON.parse(res.body);
          if (json.code === 0) {
            state.stats.wins++;
            state.raceWins.push({
              issueNumber,
              color,
              timestamp: new Date().toISOString()
            });
            
            sendDiscordAlert(
              `**🎯 BET PLACED SUCCESSFULLY! 🎯**\n` +
              `Issue: ${issueNumber}\n` +
              `Color: ${color}\n` +
              `Status: ${json.msg || 'Success'}`,
              'success'
            );
            
            console.log(`✅ Bet ${i+1}: SUCCESS`);
          } else if (json.code === 1 && json.msg === 'Game is being maintained') {
            console.log(`⚠️ Bet ${i+1}: MAINTENANCE - ${json.msg || 'Maintenance mode'}`);
          } else if (json.code === 4) {
            state.stats.losses++;
            console.log(`❌ Bet ${i+1}: LOSS - ${json.msg || 'Bet lost'}`);
          } else {
            console.log(`⚠️ Bet ${i+1}: Unexpected response - code=${json.code}, msg=${json.msg || 'N/A'}, body=${JSON.stringify(json).substring(0, 200)}`);
          }
        } catch (e) {
          console.error('Bet parse error:', e.message);
        }
      }).catch(e => {
        console.error('Bet error:', e.message);
      })
    );
  }
  
  await Promise.allSettled(betPromises);
  console.log(`Race complete. Wins: ${state.stats.wins}, Losses: ${state.stats.losses}`);
}

// === Express Routes ===
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    jwt_valid: !!state.jwt && state.jwtExpiry > Math.floor(Date.now() / 1000),
    monitoring: state.monitoring
  });
});

app.get('/api/status', (req, res) => {
  res.json({
    jwt_valid: !!state.jwt && state.jwtExpiry > Math.floor(Date.now() / 1000),
    jwt_expires: state.jwtExpiry ? new Date(state.jwtExpiry * 1000).toISOString() : null,
    monitoring: state.monitoring,
    betting_enabled: state.bettingEnabled,
    lastResult: state.lastResult,
    lastRaceWindow: state.lastRaceWindow,
    lastLoginError: state.lastLoginError,
    stats: state.stats,
    race_wins: state.raceWins
  });
});

app.get('/api/events', (req, res) => {
  res.json({
    events: state.events,
    stats: state.stats
  });
});

app.post('/api/refresh-jwt', async (req, res) => {
  const success = await refreshJwt();
  res.json({ success });
});

app.post('/api/start-monitoring', (req, res) => {
  if (!state.monitoring) {
    startRaceMonitoring();
    res.json({ started: true });
  } else {
    res.json({ already_running: true });
  }
});

app.post('/api/stop-betting', (req, res) => {
  state.bettingEnabled = false;
  res.json({ betting_enabled: false });
});

app.post('/api/start-betting', (req, res) => {
  state.bettingEnabled = true;
  res.json({ betting_enabled: true });
});

app.get('/api/betting-status', (req, res) => {
  res.json({ betting_enabled: state.bettingEnabled });
});

// === Initialize ===
async function init() {
  console.log('=== WinGo_30S Race Condition App ===\n');
  
   // Initial JWT refresh
   console.log('Loading JWT...');
   state.jwt = loadJwt();
   
   if (!state.jwt) {
     console.log('No valid JWT, refreshing...');
     await refreshJwt();
   } else {
     // Set jwtExpiry from the loaded token's expiry
     try {
       const loginData = JSON.parse(fs.readFileSync('/tmp/fb999_login_response.json', 'utf8'));
       state.jwtExpiry = loginData.data?.expiresIn || 0;
     } catch (e) {}
   }
  
  // Start server
  app.listen(PORT, () => {
    console.log(`App running on port ${PORT}`);
    console.log(`Health: http://localhost:${PORT}/health`);
    console.log(`Status: http://localhost:${PORT}/api/status\n`);
  });
  
  // Start monitoring
  if (state.jwt) {
    await startRaceMonitoring();
  }
  
  // Auto-refresh JWT every 25 minutes
  setInterval(async () => {
    await refreshJwt();
  }, 25 * 60 * 1000);
}

init().catch(console.error);

module.exports = app;
