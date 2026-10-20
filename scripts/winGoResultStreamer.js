/**
 * WinGo_30S — Result Streamer (Production Ready, Fixed)
 * 
 * • Sends PREDICTION ~12s before countdown end
 * • Detects ACTUAL RESULT ~2.5s before countdown end via 100ms polling
 * • No auth required — uses draw.ar-lottery06.com only
 * • Runs continuously
 */

const https = require('https');
const fs = require('fs');

function httpRequest(hostname, path) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path, method: 'GET' }, (res) => {
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

let history = [];
try {
  const h = JSON.parse(fs.readFileSync('/tmp/wingo_history.json', 'utf8'));
  history = h.results || [];
} catch(e) {}

let resultsCount = 0;
let correctCount = 0;
let totalPredictions = 0;
const predictions = new Map();

function predict(history) {
  const nonViolet = [];
  for (const r of history) {
    const cat = classify(r.number);
    if (!cat.startsWith('VIOLET')) {
      nonViolet.push({ cat: cat.startsWith('BIG') ? 'big' : 'small' });
    }
  }
  if (nonViolet.length === 0) return { bigSmall: 'small', confidence: 0.50, strategy: 'default', streak: 'none×0' };

  let streakColor = nonViolet[0].cat;
  let streakLen = 1;
  for (let i = 1; i < nonViolet.length && nonViolet[i].cat === streakColor; i++) streakLen++;

  let predicted, confidence, strategy;
  if (streakLen >= 4) { predicted = streakColor; confidence = 0.75; strategy = 'strong-momentum'; }
  else { predicted = streakColor === 'big' ? 'small' : 'big'; confidence = 0.60; strategy = `reversal-${streakLen}`; }

  return { bigSmall: predicted, confidence, strategy, streak: `${streakColor}×${streakLen}` };
}

async function main() {
  console.log('=== WinGo_30S Result Streamer ===');
  console.log('• Prediction ~12s before close | Result detection ~2.5s before close');
  console.log('• No auth • draw.ar-lottery06.com only\n');

  let lastResultIssue = '';
  let predictedIssue = '';

  // Get initial state
  let config = JSON.parse((await httpRequest('draw.ar-lottery06.com', '/WinGo/WinGo_30S.json')).body);
  console.log(`Monitoring. Round ${config.current.issueNumber} → ${config.next.issueNumber}`);

  while (true) {
    try {
      config = JSON.parse((await httpRequest('draw.ar-lottery06.com', '/WinGo/WinGo_30S.json')).body);

      const curIssue = config.current.issueNumber;
      const curEnd = config.current.endTime;
      const nextIssue = config.next.issueNumber;
      const timeToClose = (curEnd - Date.now()) / 1000;

      // === 1. MAKE PREDICTION ~12s before close ===
      if (timeToClose > 12 && timeToClose <= 13 && predictedIssue !== nextIssue) {
        predictedIssue = nextIssue;

        // Get fresh history for prediction
        const histRes = await httpRequest('draw.ar-lottery06.com',
          '/WinGo/WinGo_30S/GetHistoryIssuePage.json?pageNo=1&pageSize=10');
        const recent = JSON.parse(histRes.body).data?.list || [];

        // Merge with persistent history
        for (const r of recent) {
          if (!history.find(h => h.issueNumber === r.issueNumber)) history.unshift(r);
        }
        history = history.slice(0, 30);

        const pred = predict(history);
        const predEntry = { ...pred, forIssue: nextIssue };
        predictions.set(nextIssue, predEntry);
        totalPredictions++;

        console.log(`\n[${new Date().toLocaleTimeString()}] 🔮 PREDICTION for ${nextIssue}: ${pred.bigSmall.toUpperCase()}`);
        console.log(`  Confidence: ${pred.confidence} | Strategy: ${pred.strategy} | Streak: ${pred.streak}`);

        fs.appendFileSync('/tmp/wingo_stream.txt',
          `[${new Date().toISOString()}] PREDICT: ${nextIssue} → ${pred.bigSmall.toUpperCase()} | conf=${pred.confidence} | ${pred.strategy}\n`);
      }

      // === 2. DETECT ACTUAL RESULT (~2.5s before close) ===
      const histRes = await httpRequest('draw.ar-lottery06.com',
        '/WinGo/WinGo_30S/GetHistoryIssuePage.json?pageNo=1&pageSize=10');

      if (histRes.status === 200) {
        const data = JSON.parse(histRes.body);
        const list = data.data?.list || [];

        if (list.length > 0 && list[0].issueNumber !== lastResultIssue) {
          const latest = list[0];
          lastResultIssue = latest.issueNumber;
          const msFromClose = Date.now() - curEnd;
          resultsCount++;

          // Check if prediction was correct
          let predResult = '';
          const predEntry = predictions.get(latest.issueNumber);
          if (predEntry) {
            const actualCat = classify(latest.number);
            const actual = actualCat.startsWith('BIG') ? 'big' : actualCat.startsWith('SMALL') ? 'small' : 'violet';
            predResult = predEntry.bigSmall === actual ? '✓ CORRECT' : actual === 'violet' ? '⚠ VIOLET (unwinnable)' : '✗ WRONG';
            if (predResult === '✓ CORRECT') correctCount++;
            predictions.delete(latest.issueNumber);
          }

          console.log(`[${new Date().toLocaleTimeString()}] 🎯 RESULT: ${latest.issueNumber} → ${classify(latest.number)}`);
          console.log(`  ${Math.abs(msFromClose)}ms ${msFromClose < 0 ? 'BEFORE' : 'AFTER'} countdown end`);
          if (predResult) console.log(`  ${predResult}`);

          fs.appendFileSync('/tmp/wingo_stream.txt',
            `[${new Date().toISOString()}] RESULT: ${latest.issueNumber} → ${latest.number} (${classify(latest.number)}) | ${msFromClose}ms | ${predResult || ''}\n`);

          history.unshift({ issueNumber: latest.issueNumber, number: latest.number });
          history = history.slice(0, 30);
          fs.writeFileSync('/tmp/wingo_history.json', JSON.stringify({ results: history }, null, 2));
        }
      }
    } catch(e) {
      console.log(`Error: ${e.message}`);
    }

    await sleep(100);
  }
}

process.on('SIGINT', () => {
  console.log(`\n\n=== Summary: ${resultsCount} results detected, ${totalPredictions} predictions, ${correctCount} correct (${Math.round(correctCount/Math.max(resultsCount,1)*100)}%) ===`);
  process.exit(0);
});

main().catch(e => console.error('Fatal:', e.message));
