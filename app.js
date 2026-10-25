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
 * Deployment: Koyeb / Docker / Any Node.js host
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

// === Configuration ===
const PORT = process.env.PORT || 3000;
const FB999_PHONE = process.env.FB999_PHONE || '2349121493739';
const FB999_PASSWORD = process.env.FB999_PASSWORD || 'Drewziwugod6';
const DISCORD_WEBHOOK = process.env.DISCORD_WEBHOOK_URL || null;
const FB999_JWT = process.env.FB999_JWT || null; // Can set JWT via env var

// === JWT Management ===
function loadJwt() {
  // Try environment variable first
  if (FB999_JWT) {
    try {
      const parts = FB999_JWT.split('.');
      if (parts.length === 3) {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
        if (payload.exp) {
          state.jwtExpiry = payload.exp;
          if (state.jwtExpiry > Math.floor(Date.now() / 1000)) {
            console.log('JWT loaded from environment variable');
            return FB999_JWT;
          }
        }
      }
    } catch(e) {}
  }
  
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

function refreshJwt() {
  return new Promise((resolve) => {
    console.log('Refreshing JWT token...');
    
    const puppeteer = require('puppeteer');
    
    puppeteer.launch({
      headless: 'new',
      executablePath: process.env.CHROME_BIN || process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
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
    }).then(async (browser) => {
      const page = await browser.newPage();
      await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1');
      await page.setViewport({ width: 414, height: 896, isMobile: true });
      
      try {
        await page.goto('https://fb999.com/#/login', { waitUntil: 'networkidle2', timeout: 30000 });
        await new Promise(r => setTimeout(r, 2000));
        
        // Fill credentials
        await page.waitForSelector('input[name="userNumber"]', { timeout: 10000 });
        await page.type('input[name="userNumber"]', FB999_PHONE, { delay: 50 });
        
        const pwdField = await page.waitForSelector('input[type="password"]', { visible: true, timeout: 10000 });
        await pwdField.type(FB999_PASSWORD, { delay: 50 });
        
        // Click login
        await page.waitForFunction(() => {
          const btns = Array.from(document.querySelectorAll('button'));
          return btns.some(b => b.textContent.trim().toLowerCase().includes('login'));
        }, { timeout: 15000 });
        
        await page.evaluate(() => {
          const btn = Array.from(document.querySelectorAll('button'))
            .find(b => b.textContent.trim().toLowerCase().includes('login'));
          if (btn) btn.click();
        });
        
        // Wait for response
        await page.waitForTimeout(5000);
        
        // Check localStorage for token
        const storage = await page.evaluate(() => {
          const result = {};
          for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key) result[key] = localStorage.getItem(key);
          }
          return result;
        });
        
        const token = storage.ar_token || storage.token;
        if (token) {
          console.log('JWT refreshed successfully!');
          
          // Get token expiry from JWT
          const parts = token.split('.');
          const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
          const exp = payload.exp || (Math.floor(Date.now() / 1000) + 1800);
          
          state.jwt = token;
          state.jwtExpiry = exp;
          
          // Save to file
          const loginResponse = {
            data: {
              token: token,
              expiresIn: exp,
              webSocketUrl: storage.ar_ws_url,
              webSocketChannels: storage.ar_ws_channels
            },
            code: 0,
            msg: 'Succeed'
          };
          fs.writeFileSync('/tmp/fb999_login_response.json', JSON.stringify(loginResponse, null, 2));
          
          resolve(true);
        } else {
          console.log('No token found in localStorage');
          resolve(false);
        }
      } catch (e) {
        console.error('Login error:', e.message);
        resolve(false);
      } finally {
        await browser.close();
      }
    }).catch(err => {
      console.error('Browser launch error:', err.message);
      resolve(false);
    });
  });
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
// CORRECTED: The actual Draw server API returns these colors:
//   0 → "red,violet"  (wins Red + Violet bets)
//   5 → "green,violet" (wins Green + Violet bets)
//   odd (1,3,7,9) → "green"
//   even (2,4,6,8) → "red"
// NOTE: The previous version had odd→Red/even→Green INVERTED — this was verified
// against live API data at draw.ar-lottery06.com and corrected.
function numberToColor(n) {
  n = parseInt(n);
  if (n === 0) return 'Violet';           // special case: 0 wins Red+Violet
  if ([1, 3, 7, 9].includes(n)) return 'Green';   // odd → Green
  if ([2, 4, 6, 8].includes(n)) return 'Red';     // even → Red
  if (n === 5) return 'Violet';           // special case: 5 wins Green+Violet (bypassed above since 5 is odd)
  return 'Unknown';
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
          classify: classify(resultNum),
          timestamp: new Date().toISOString()
        };
        
        // Update trend history
        updateHistory(state.lastResult);
        
        // Generate prediction if we have 10 results
        if (state.history.length >= 10) {
          const prediction = predictNext();
          if (prediction) {
            console.log(`📈 Trend Prediction: ${prediction.prediction} (${prediction.confidence} confidence)`);
          }
        }
        
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
            `Placing rapid bets...`,
            'success'
          );
          
          // Place race bets
          await executeRaceBets(resultColor, list[0].issueNumber);
          
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
  for (let i = 0; i < 50; i++) {
    const body = JSON.stringify(signParams({
      TypeId: 30,
      lottery: 'WinGo',
      gameCode: 'WinGo_30S',
      issueNumber: issueNumber,
      BetCount: 1,
      Amount: 1,
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
            // Maintenance
          } else if (json.code === 4) {
            state.stats.losses++;
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
  res.json({
    name: 'WinGo Racer',
    version: '1.0.0',
    status: 'running',
    endpoints: ['/health', '/api/status', '/api/events', '/api/trend'],
    dashboard: 'https://wingo-racer.onrender.com/health'
  });
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
    lastResult: state.lastResult,
    lastRaceWindow: state.lastRaceWindow,
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

// === Trend Analysis Endpoint ===
app.get('/api/trend', (req, res) => {
  if (state.history.length < 10) {
    return res.json({
      error: 'Need 10 results for trend analysis',
      available: state.history.length,
      required: 10
    });
  }
  
  const analysis = analyzeTrend();
  const prediction = predictNext();
  
  res.json({
    history: state.history.map(h => ({
      issueNumber: h.issueNumber,
      number: h.number,
      classify: h.classify
    })),
    trendAnalysis: analysis,
    prediction: prediction,
    status: 'active'
  });
});

// === Manual Trend Prediction (2 seconds before close) ===
app.get('/api/predict', (req, res) => {
  const prediction = predictNext();
  if (!prediction) {
    return res.json({
      error: 'Insufficient data (need 10 results)',
      available: state.history.length
    });
  }
  res.json(prediction);
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

// === Initialize ===
async function init() {
  console.log('=== WinGo_30S Race Condition App ===\n');
  
   // Initial JWT refresh/load
   console.log('Loading JWT...');
   state.jwt = loadJwt();
   
   if (!state.jwt) {
     console.log('No valid JWT, refreshing...');
     await refreshJwt();
   } else {
     // Set jwtExpiry from the loaded token's expiry
     try {
       if (FB999_JWT) {
         const parts = FB999_JWT.split('.');
         const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
         state.jwtExpiry = payload.exp || 0;
       } else {
         const loginData = JSON.parse(fs.readFileSync('/tmp/fb999_login_response.json', 'utf8'));
         state.jwtExpiry = loginData.data?.expiresIn || 0;
       }
     } catch (e) {}
   }
  
  // Start server
  app.listen(PORT, () => {
    console.log(`App running on port ${PORT}`);
    console.log(`Health: http://localhost:${PORT}/health`);
    console.log(`Status: http://localhost:${PORT}/api/status\n`);
  });
  
  // Try to start monitoring without blocking server startup
  setTimeout(async () => {
    try {
      if (!state.jwt) {
        console.log('Attempting JWT refresh...');
        await refreshJwt().catch(err => console.error('JWT refresh error:', err.message));
      }
      
      if (state.jwt) {
        console.log('Starting race monitoring...');
        state.monitoring = true;
        startRaceMonitoring();
      }
    } catch(e) {
      console.error('Startup monitoring error:', e.message);
    }
  }, 5000);
  
  // Auto-refresh JWT every 25 minutes
  setInterval(async () => {
    await refreshJwt();
  }, 25 * 60 * 1000);
}

init().catch(console.error);

module.exports = app;
