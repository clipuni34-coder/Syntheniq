const https = require('https');
const fs = require('fs');

function httpRequest(hostname, path, method = 'GET', body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path, method,
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

const HOST = 'draw.ar-lottery06.com';

async function fetchConfig() {
  const r = await httpRequest(HOST, '/WinGo/WinGo_30S.json');
  return JSON.parse(r.body);
}

async function fetchHistory() {
  const r = await httpRequest(HOST, '/WinGo/WinGo_30S/GetHistoryIssuePage.json?pageNo=1&pageSize=10');
  const data = JSON.parse(r.body);
  return data.data?.list || [];
}

function ts() { return new Date().toISOString().slice(11, 23); }

(async () => {
  const log = [];
  let lastHist0 = '';
  let lastCur = '';
  const startTime = Date.now();
  console.error(`[${ts()}] probe start`);
  for (let i = 0; i < 400; i++) {
    try {
      const [cfg, hist] = await Promise.all([fetchConfig(), fetchHistory()]);
      const now = Date.now();
      const cur = cfg.current;
      const curEndMs = cur.endTime - now;
      const h0 = hist[0] || {};
      const h0iss = h0.issueNumber || '?';
      const curIss = cur.issueNumber || '?';
      const nextIss = cfg.next.issueNumber || '?';
      // print on any change in cur issue or hist[0]
      const key = curIss + '|' + h0iss;
      if (key !== (lastCur + '|' + lastHist0)) {
        const rel = (curEndMs / 1000).toFixed(1);
        const line = `[${ts()}] cur=${curIss.slice(-6)} curEnd${rel<0?'+':''}${rel}s next=${nextIss.slice(-6)} hist0=${h0iss.slice(-6)} num=${h0.number||'?'} prev=${cfg.previous.issueNumber.slice(-6)}`;
        console.error(line);
        log.push(line);
        lastCur = curIss; lastHist0 = h0iss;
      }
    } catch (e) {
      console.error(`[${ts()}] ERR: ${e.message}`);
    }
    await new Promise(r => setTimeout(r, 100));
    if (Date.now() - startTime > 38000) break;
  }
  console.error(`[${ts()}] probe end (${(Date.now()-startTime)/1000}s)`);
  fs.writeFileSync('/tmp/probe_log.txt', log.join('\n'));
})();
