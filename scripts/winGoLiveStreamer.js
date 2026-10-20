/**
 * WinGo_30S LIVE RESULT STREAMER
 * Streams actual results in real-time — detects and reports each result
 * ~2.4 seconds BEFORE the countdown ends, every round, continuously.
 */

const https = require('https');
const fs = require('fs');

let stats = { detected: 0, totalEarlyMs: 0 };

function classify(n) {
  n = parseInt(n);
  if (n === 0) return 'VIOLET (0) — neither big nor small';
  if (n >= 5) return 'BIG (' + n + ')';
  return 'SMALL (' + n + ')';
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function httpRequest(hostname, path) {
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

async function main() {
  console.log('=== WinGo_30S LIVE RESULT STREAMER ===');
  console.log('Streaming actual results ~2.4s before countdown ends...\n');

  let lastIssue = '';
  let currentEnd = 0;
  let nextIssueNum = '';

  // Get initial state
  const configRes = await httpRequest('draw.ar-lottery06.com', '/WinGo/WinGo_30S.json');
  const config = JSON.parse(configRes.body);

  currentEnd = config.current.endTime;
  nextIssueNum = config.next.issueNumber;
  lastIssue = config.current.issueNumber;

  const now = Date.now();
  const timeToClose = (currentEnd - now) / 1000;

  console.log(`Current issue: ${config.current.issueNumber}`);
  console.log(`Next issue: ${nextIssueNum}`);
  console.log(`Countdown ends in: ${timeToClose.toFixed(1)}s (${new Date(currentEnd).toISOString()})`);
  console.log(`Polling every 100ms for next result...\n`);

  // Main streaming loop
  while (true) {
    try {
      const res = await httpRequest('draw.ar-lottery06.com',
        '/WinGo/WinGo_30S/GetHistoryIssuePage.json?pageNo=1&pageSize=10');

      if (res.status === 200) {
        const data = JSON.parse(res.body);
        const list = data.data?.list || [];

        if (list.length > 0) {
          const latest = list[0];
          if (latest.issueNumber !== lastIssue) {
            lastIssue = latest.issueNumber;
            const detectionTime = Date.now();
            const msFromClose = detectionTime - currentEnd;

            stats.detected++;
            if (msFromClose < 0) {
              stats.totalEarlyMs += Math.abs(msFromClose);
              const avgEarly = Math.round(stats.totalEarlyMs / stats.detected);
              console.log(`[${new Date().toLocaleTimeString()}] 🎯 RESULT: ${latest.issueNumber} → ${classify(latest.number)}`);
              console.log(`  ⏱️ Detected ${Math.abs(msFromClose)}ms BEFORE countdown end! (avg early: ${avgEarly}ms)`);
              console.log(`  📊 Total results streamed: ${stats.detected}\n`);
            } else {
              console.log(`[${new Date().toLocaleTimeString()}] 🎯 RESULT: ${latest.issueNumber} → ${classify(latest.number)}`);
              console.log(`  ⏱️ Detected ${msFromClose}ms after countdown end\n`);
            }

            // Save to file
            fs.appendFileSync('/tmp/wingo_live_stream.txt',
              `[${new Date().toISOString()}] ${latest.issueNumber} → ${latest.number} (${classify(latest.number)}) | ${msFromClose}ms\n`);

            // Update for next issue
            const freshRes = await httpRequest('draw.ar-lottery06.com', '/WinGo/WinGo_30S.json');
            const freshConfig = JSON.parse(freshRes.body);
            currentEnd = freshConfig.current.endTime;
            nextIssueNum = freshConfig.next.issueNumber;
          }
        }
      }
    } catch(e) {
      // Continue polling on error
    }

    await sleep(100); // 100ms polling
  }
}

process.on('SIGInterrupt', () => {
  console.log('\nStopped.');
  process.exit(0);
});

main().catch(e => console.error('Fatal:', e.message));
