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

const app = express();
app.use(express.json());

// Serve static dashboard from public/
const path = require('path');
app.use(express.static(path.join(__dirname, 'public')));

// Root route
app.get('/', (req, res) => {
  res.json({
    name: 'WinGo Racer',
    version: '1.0.0',
    status: 'running',
    endpoints: ['/health', '/api/status', '/api/events', '/api/trend'],
    dashboard: 'https://wingo-racer.onrender.com/'
  });
});

// === State Management ===
const state = {
  jwt: null,
  jwtExpiry: 0,
  raceWins: [],
  events: [],
  monitoring: false,
  lastResult: null,
  lastRaceWindow: null,
  stats: {
    roundsDetected: 0,
    raceWindowsFound: 0,
    betsPlaced: 0,
    wins: 0,
    losses: 0
  },
  // === Trend Analysis State ===
  history: [],           // Last 10 results {issueNumber, number, color, classify, timestamp}
  trendPrediction: null,  // Current trend-based prediction
  advancedPrediction: null, // Multi-method high-accuracy prediction
  predictedForIssue: {}   // Track which issues we've predicted for (prevents duplicate bets)
};

// === Trend Analysis Engine ===
// Uses last 10 game results to predict next Big/Small outcome
function updateHistory(result) {
  state.history.push(result);
  if (state.history.length > 10) {
    state.history.shift();
  }
}

function classifyTrend(results) {
  const classes = results.map(r => r.classify);
  const big = classes.filter(c => c === 'big').length;
  const small = classes.filter(c => c === 'small').length;
  
  if (big > small) return 'big';
  if (small > big) return 'small';
  return 'balanced'; // Equal split
}

function analyzeTrend() {
  if (state.history.length < 10) return null;
  
  const trend = classifyTrend(state.history);
  const currentStreak = [];
  const trendSequence = state.history.map(r => r.classify);
  
  // Find current streak
  for (let i = trendSequence.length - 1; i >= 0; i--) {
    if (trendSequence[i] === trendSequence[trendSequence.length - 1]) {
      currentStreak.unshift(trendSequence[i]);
    } else {
      break;
    }
  }
  
  return {
    trend: trend,
    streak: currentStreak,
    streakLength: currentStreak.length,
    last10: {
      big: trendSequence.filter(c => c === 'big').length,
      small: trendSequence.filter(c => c === 'small').length,
      violet: trendSequence.filter(c => c === 'violet').length
    },
    confidence: calculateConfidence(trendSequence, trend)
  };
}

function calculateConfidence(sequence, trend) {
  const counts = { big: 0, small: 0, violet: 0 };
  sequence.forEach(c => counts[c]++);
  
  const total = sequence.length;
  const ratio = counts[trend] / total;
  
  // Confidence based on how dominant the trend is
  if (ratio >= 0.8) return 'very-high';
  if (ratio >= 0.7) return 'high';
  if (ratio >= 0.6) return 'medium';
  if (ratio >= 0.55) return 'low';
  return 'very-low';
}

// Predict next Big/Small outcome 2 seconds before close
function predictNext() {
  const analysis = analyzeTrend();
  if (!analysis) return null;
  
  state.trendPrediction = {
    prediction: analysis.trend === 'big' ? 'Big' : 'Small',
    confidence: analysis.confidence,
    basedOn: 'last_10_results',
    trendAnalysis: analysis,
    timestamp: new Date().toISOString()
  };
  
  return state.trendPrediction;
}

// === Advanced Prediction Engine ===
// Uses multiple analysis methods for higher accuracy prediction

function analyzePatternFrequency(history) {
  // Look for repeating patterns (2-3 result sequences)
  if (history.length < 8) return { pattern: 'none', confidence: 'none', score: 0 };
  
  // Get last 5 results
  const recent = history.slice(-5).map(r => r.classify);
  const last3 = recent.slice(-3);
  
  // Check for pattern repetitions in last 8
  const last8 = history.slice(-8).map(r => r.classify);
  
  // Find the most recent trend
  const mostRecent = history[history.length - 1].classify;
  const streak = [];
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].classify === mostRecent) streak.unshift(mostRecent);
    else break;
  }
  
  // Pattern-based: look at 2-2 splits and alternations
  const seq = last8;
  let patterns = {};
  for (let i = 0; i < seq.length - 2; i++) {
    const p = seq.slice(i, i + 2).join('-');
    patterns[p] = (patterns[p] || 0) + 1;
  }
  
  // Most frequent 2-pattern
  let bestPattern = null, bestCount = 0;
  for (const [p, c] of Object.entries(patterns)) {
    if (c > bestCount) { bestCount = c; bestPattern = p; }
  }
  
  // Predict based on recent pattern
  if (streak.length >= 2) {
    // If streak is 2+, it's likely to continue (momentum)
    return { 
      pattern: `streak-${streak.length}`, 
      confidence: streak.length >= 3 ? 'high' : 'medium',
      score: streak.length >= 3 ? 0.8 : 0.65,
      prediction: streak[0] === 'big' ? 'Big' : 'Small'
    };
  }
  
  // Alternating pattern detection
  const isAlternating = last8.every((v, i) => i === 0 || v !== last8[i-1]);
  if (isAlternating && last8.length >= 6) {
    return {
      pattern: 'alternating',
      confidence: 'high',
      score: 0.75,
      prediction: recent[recent.length - 1] === 'big' ? 'Small' : 'Big'
    };
  }
  
  return { pattern: 'none', confidence: 'none', score: 0 };
}

function calculateAdvancedConfidence(history) {
  if (history.length < 10) return { confidence: 'very-low', score: 0.4 };
  
  let scores = [];
  
  // Method 1: Majority ratio
  const counts = { big: 0, small: 0, violet: 0 };
  history.forEach(h => counts[h.classify]++);
  const majority = Object.values(counts).sort((a,b) => b-a)[0];
  const ratio = majority / history.length;
  const method1Score = ratio;
  scores.push({ name: 'majority', score: method1Score, weight: 1 });
  
  // Method 2: Pattern frequency analysis
  const patternResult = analyzePatternFrequency(history);
  const method2Score = patternResult.score || 0;
  scores.push({ name: 'pattern', score: method2Score, weight: 1 });
  
  // Method 3: Recent trend (last 3 results)
  const last3 = history.slice(-3).map(h => h.classify);
  const trend3 = last3.every(c => c === last3[0]) ? 1 : last3[2] === last3[1] ? 0.7 : 0.5;
  scores.push({ name: 'recent', score: trend3, weight: 1.5 }); // Higher weight for recent trend
  
  // Calculate weighted average
  let totalWeight = 0, weightedScore = 0;
  scores.forEach(s => {
    weightedScore += s.score * s.weight;
    totalWeight += s.weight;
  });
  const finalScore = weightedScore / totalWeight;
  
  let confidence;
  if (finalScore >= 0.85) confidence = 'very-high';
  else if (finalScore >= 0.7) confidence = 'high';
  else if (finalScore >= 0.6) confidence = 'medium';
  else if (finalScore >= 0.5) confidence = 'low';
  else confidence = 'very-low';
  
  return { confidence, score: finalScore };
}

function predictColor(history) {
  // Analyze color patterns from last 10 results
  if (history.length < 5) return null;
  
  const colors = history.map(h => h.color?.toLowerCase() || '');
  const recentColors = colors.slice(-5);
  
  // Count frequency
  const counts = { red: 0, green: 0, violet: 0 };
  colors.forEach(c => {
    if (c === 'red') counts.red++;
    else if (c === 'green') counts.green++;
    else if (c === 'violet') counts.violet++;
  });
  
  // Check for streaks
  const lastColor = recentColors[recentColors.length - 1];
  let streak = 0;
  for (let i = recentColors.length - 1; i >= 0; i--) {
    if (recentColors[i] === lastColor) streak++;
    else break;
  }
  
  // Pattern analysis
  let prediction = null;
  let confidence = 0;
  
  // If strong color dominance
  if (counts.red >= 6) { prediction = 'Red'; confidence = 0.7; }
  else if (counts.green >= 6) { prediction = 'Green'; confidence = 0.7; }
  else if (counts.violet >= 3) { prediction = 'Violet'; confidence = 0.65; }
  
  // Streak continuation
  if (streak >= 3 && lastColor) {
    prediction = lastColor === 'red' ? 'Red' : lastColor === 'green' ? 'Green' : 'Violet';
    confidence = Math.max(confidence, 0.75);
  }
  
  // Alternation pattern
  const isAlternating = recentColors.length >= 4 && recentColors.every((c, i) => i === 0 || c !== recentColors[i-1]);
  if (isAlternating) {
    prediction = recentColors[recentColors.length - 1] === 'red' ? 'Green' : 'Red';
    confidence = Math.max(confidence, 0.72);
  }
  
  if (!prediction) {
    // Default to the most frequent
    const max = Math.max(counts.red, counts.green, counts.violet);
    if (counts.red === max) prediction = 'Red';
    else if (counts.green === max) prediction = 'Green';
    else prediction = 'Violet';
    confidence = 0.5;
  }
  
  return {
    color: prediction,
    confidence: confidence >= 0.75 ? 'high' : confidence >= 0.65 ? 'medium' : 'low',
    score: Math.round(confidence * 100)
  };
}

function getAdvancedPrediction() {
  if (state.history.length < 10) return null;
  
  // Combine multiple analysis methods
  const patternResult = analyzePatternFrequency(state.history);
  const confidenceInfo = calculateAdvancedConfidence(state.history);
  const colorPrediction = predictColor(state.history);
  
  // Determine final prediction
  let prediction = patternResult.prediction || (confidenceInfo.score >= 0.5 ? 'Big' : 'Small');
  
  // Use majority vote to override if pattern is weak
  const counts = { big: 0, small: 0 };
  state.history.forEach(h => {
    if (h.classify === 'big') counts.big++;
    else if (h.classify === 'small') counts.small++;
  });
  
  // Majority prediction as fallback
  const majorityPrediction = counts.big > counts.small ? 'Big' : 'Small';
  if (patternResult.score < 0.5) {
    prediction = majorityPrediction;
  }
  
  state.advancedPrediction = {
    prediction: prediction,
    color: colorPrediction ? colorPrediction.color : 'Unknown',
    colorConfidence: colorPrediction ? colorPrediction.confidence : 'low',
    colorScore: colorPrediction ? colorPrediction.score : 0,
    confidence: confidenceInfo.confidence,
    score: Math.round(confidenceInfo.score * 100),
    methods: {
      majority: counts.big > counts.small ? `Big (${counts.big}/10)` : `Small (${counts.small}/10)`,
      pattern: patternResult.pattern,
      recentTrend: `${state.history.slice(-3).map(h => h.classify).join(' → ')}`
    },
    basedOn: '10_results_multi_analysis',
    timestamp: new Date().toISOString()
  };
  
  return state.advancedPrediction;
}

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
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.setTimeout(30000);
    if (body) {
      req.write(body);
    }
    req.end();
  });
}

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
    console.log('Refreshing JWT token via API...');
    
    const loginParams = {
      username: FB999_PHONE,
      pwd: FB999_PASSWORD,
      phonetype: 2,
      logintype: 'mobile',
      packId: '',
      deviceId: crypto.randomBytes(16).toString('hex'),
      pixelId: '',
      fbcId: '',
      fbc: '',
      fbp: '',
      adId: ''
    };
    
    const signed = signParams(loginParams);
    const body = JSON.stringify(signed);
    
    httpRequest('fb999api.com', '/api/webapi/Login', 'POST', body)
      .then(res => {
        try {
          const json = JSON.parse(res.body);
          if (json.code === 0 && json.data?.token) {
            const token = json.data.token;
            const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
            
            state.jwt = token;
            state.jwtExpiry = payload.exp || json.data.expiresIn;
            
            // Save to file for persistence
            fs.writeFileSync('/tmp/fb999_login_response.json', JSON.stringify(json, null, 2));
            
            console.log('JWT refreshed successfully via API!');
            console.log('JWT expiry:', new Date(state.jwtExpiry * 1000).toISOString());
            resolve(true);
          } else {
            console.error('JWT refresh failed:', json.msg || ('code: ' + json.code));
            resolve(false);
          }
        } catch(e) {
          console.error('JWT parse error:', e.message);
          resolve(false);
        }
      })
      .catch(e => {
        console.error('JWT refresh network error:', e.message);
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
      color: type === 'success' ? 0x00ff00 : type === 'error' ? 0xff0000 : type === 'warning' ? 0xffaa00 : 0x00aaff,
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
    let msToClose;
    try {
      // Check JWT
      if (!state.jwt || Date.now() > state.jwtExpiry * 1000 - 60000) {
        console.log('JWT expired, refreshing...');
        await refreshJwt();
        await sleep(5000);
        continue;
      }
      
       // Get current round info
      const config = JSON.parse((await httpRequest('draw.ar-lottery06.com', '/WinGo/WinGo_30S.json')).body);
      const currentEnd = new Date(config.current.endTime).getTime();
      const now = Date.now();
      msToClose = currentEnd - now;
      
      // Get latest result from draw server (leaks ~2.5s before close)
      const histRes = await httpRequest('draw.ar-lottery06.com',
        '/WinGo/WinGo_30S/GetHistoryIssuePage.json?pageNo=1&pageSize=10');
      const list = JSON.parse(histRes.body).data?.list || [];
      
      // ALSO check GetLastFiveIssueNumberResult for EARLY leak (17-33s before close!)
      let earlyLeak = null;
      if (state.jwt && msToClose > 10000 && msToClose < 35000) {
        try {
          const lfRes = await httpRequest('fb999api.com', '/api/webapi/GetLastFiveIssueNumberResult', 'POST',
            JSON.stringify(signParams({ TypeId: 30 })),
            { 'Authorization': `Bearer ${state.jwt}`, 'token': state.jwt, 'ar-token': state.jwt }
          );
          const lf = JSON.parse(lfRes.body);
          if (lf.code === 0 && lf.data?.number) {
            // data.number is comma-separated: "n,n,n,n,n" (last 5 results)
            const numbers = lf.data.number.split(',').map(n => parseInt(n));
            const latestNum = numbers[numbers.length - 1];
            
            // Check if this is a new result we haven't seen
            if (latestNum !== state.lastEarlyLeakNumber && !isNaN(latestNum)) {
              state.lastEarlyLeakNumber = latestNum;
              earlyLeak = {
                number: latestNum,
                color: numberToColor(latestNum),
                msToClose: msToClose,
                source: 'GetLastFiveIssueNumberResult',
                timestamp: new Date().toISOString()
              };
              console.log(`🚨 EARLY LEAK (API): ${latestNum} (${numberToColor(latestNum)}) ${Math.round(msToClose/1000)}s before close`);
            }
          } else {
            console.log(`⚠️ GetLastFiveIssueNumberResult: ${lf.code} - ${lf.msg || 'no data'}`);
          }
        } catch(e) {
          console.log(`⚠️ Early leak API error: ${e.message}`);
        }
      }
      
      // Detect result from draw server (later leak)
      let newResultReceived = false;
      let leakedResult = earlyLeak;
      
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
        
        // If we haven't already leaked this via API, mark it here
        if (!leakedResult) {
          leakedResult = {
            issueNumber: list[0].issueNumber,
            number: resultNum,
            color: resultColor,
            msToClose: msToClose,
            source: 'GetHistoryIssuePage',
            timestamp: new Date().toISOString()
          };
          console.log(`⚡ LATE LEAK: ${resultNum} (${resultColor}) ${Math.round(msToClose/1000)}s before close`);
        }
        
        // Update trend history
        updateHistory(state.lastResult);
        newResultReceived = true;
        state.stats.roundsDetected++;
        
        console.log(`[${new Date().toLocaleTimeString()}] Result: ${resultNum} (${resultColor})`);
      }
      
      // BET ON LEAKED RESULT - if we have it early, use it immediately
      if (leakedResult && msToClose > 10000) {
        // Use the ACTUAL leaked result color to bet on the current round (which is still open)
        const betColor = leakedResult.color.toLowerCase();
        const targetIssue = config.current?.issueNumber;
        
        console.log(`⚡ LEAK-BASED BET: Using ${leakedResult.source} result ${leakedResult.number} (${betColor}) ${Math.round(msToClose/1000)}s before close`);
        
        state.lastRaceWindow = {
          color: betColor,
          number: leakedResult.number,
          msToClose: msToClose,
          timestamp: new Date().toISOString(),
          isLeakedResult: true,
          leakSource: leakedResult.source
        };
        
        state.stats.raceWindowsFound++;
        
        sendDiscordAlert(
          `**🚨 EARLY LEAK DETECTED!**\n` +
          `Number: **${leakedResult.number}**\n` +
          `Color: **${leakedResult.color}**\n` +
          `Source: ${leakedResult.source}\n` +
          `Time before close: ${Math.round(msToClose/1000)}s\n` +
          `Betting on ${betColor}...`,
          'success'
        );
        
        await executeRaceBets(betColor, targetIssue);
        state.predictedForIssue[targetIssue] = true;
      }
      
      // Generate predictions whenever we have 10 results (fallback for when no leak)
      if (state.history.length >= 10 && !leakedResult) {
        const prediction = predictNext();
        const advanced = getAdvancedPrediction();
        
        if (advanced) {
          state.advancedPrediction = advanced;
          console.log(`🎯 Advanced Prediction: ${advanced.prediction} (${advanced.confidence} confidence, score: ${advanced.score}%)`);
          
          // High confidence alert
          if (advanced.confidence === 'high' || advanced.confidence === 'very-high') {
            sendDiscordAlert(
              `**🎯 HIGH CONFIDENCE PREDICTION!**\n` +
              `Prediction: **${advanced.prediction}**\n` +
              `Confidence: **${advanced.confidence.toUpperCase()}** (Score: ${advanced.score}%)  \n` +
              `Methods: ${advanced.methods.pattern} | Recent: ${advanced.methods.recentTrend}`,
              'warning'
            );
          }
        }
      }
      
      console.log(`  ${Math.round(msToClose/1000)}s to current round close`);
      
    } catch (e) {
      console.error('Monitor error:', e.message);
    }
    
    // Fast polling - check every 50ms when close to draw close, slower otherwise
    if (!raceWindow) {
      await sleep(msToClose < 5000 ? 100 : 50);
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
    race_wins: state.raceWins,
    history: state.history.slice(-10),  // Last 10 results for UI
    advancedPrediction: state.advancedPrediction  // High-accuracy prediction
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

// === Advanced High-Accuracy Prediction Endpoint ===
app.get('/api/advanced-predict', (req, res) => {
  const advanced = getAdvancedPrediction();
  if (!advanced) {
    return res.json({
      error: 'Insufficient data (need 10 results)',
      available: state.history.length,
      required: 10,
      tip: 'Collecting results from ongoing races...'
    });
  }
  res.json(advanced);
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
