#!/usr/bin/env node
/**
 * Probe multiple candidate draw server hostnames to see if any alternate
 * CDN / server has the WinGo result config available earlier than the
 * primary (draw.ar-lottery06.com).
 *
 * Each host is hit with a GET /WinGo/WinGo_30S.json. We record which hosts
 * respond 200 and report the current round timing (issue + ms-to-close) so
 * they can be compared.
 */

const https = require('https');

const CONFIG_PATH = '/WinGo/WinGo_30S.json';

// 10 candidate draw server hostnames (numbered shard variants of ar-lottery).
const HOSTS = [
  'draw.ar-lottery01.com',
  'draw.ar-lottery02.com',
  'draw.ar-lottery03.com',
  'draw.ar-lottery04.com',
  'draw.ar-lottery05.com',
  'draw.ar-lottery06.com',
  'draw.ar-lottery07.com',
  'draw.ar-lottery08.com',
  'draw.ar-lottery09.com',
  'draw.ar-lottery10.com',
];

function httpRequest(hostname, path, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname,
      path,
      method: 'GET',
      timeout: timeoutMs,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15',
      },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

function ts() { return new Date().toISOString().slice(11, 23); }

async function probe(host) {
  const t0 = Date.now();
  try {
    const res = await httpRequest(host, CONFIG_PATH);
    const ms = Date.now() - t0;
    if (res.status !== 200) {
      return { host, ok: false, status: res.status, ms, detail: `HTTP ${res.status}`, body: res.body.slice(0, 120) };
    }
    let cfg;
    try { cfg = JSON.parse(res.body); }
    catch (e) {
      return { host, ok: false, status: res.status, ms, detail: 'Invalid JSON', body: res.body.slice(0, 120) };
    }
    const cur = cfg.current || {};
    const now = Date.now();
    const msToClose = cur.endTime ? cur.endTime - now : null;
    return {
      host,
      ok: true,
      status: res.status,
      ms,
      issueNumber: cur.issueNumber || '?',
      endTime: cur.endTime || null,
      msToClose,
      serviceNowTime: cfg.serviceNowTime || null,
      raw: res.body.slice(0, 200),
    };
  } catch (e) {
    return { host, ok: false, status: null, ms: Date.now() - t0, detail: e.message, body: '' };
  }
}

(async () => {
  console.log(`[${ts()}] Probing ${HOSTS.length} draw server hosts for ${CONFIG_PATH}...\n`);
  console.log('Host'.padEnd(26) + 'Status  RTT     Issue                 msToClose  Detail');
  console.log('-'.repeat(110));

  const results = await Promise.all(HOSTS.map(h => probe(h)));

  let responding = 0;
  for (const r of results) {
    responding += r.ok ? 1 : 0;
    let detail = '';
    let issue = '-';
    let msToClose = '-';
    if (r.ok) {
      issue = r.issueNumber || '-';
      msToClose = r.msToClose == null ? '-' : `${r.msToClose}ms`;
      detail = 'CONFIG OK';
    } else {
      detail = r.detail || (r.status ? `HTTP ${r.status}` : 'no response');
      if (r.body) detail += ` | ${r.body.slice(0, 60)}`;
    }
    const status = r.status == null ? '---' : String(r.status);
    const rtt = r.ms == null ? '---' : `${r.ms}ms`;
    console.log(
      r.host.padEnd(26) +
      status.padEnd(8) +
      rtt.padEnd(8) +
      String(issue).slice(-20).padEnd(22) +
      String(msToClose).padEnd(11) +
      detail,
    );
  }

  console.log('\n' + '='.repeat(60));
  console.log(`Responding hosts: ${responding}/${HOSTS.length}`);

  // Show current round timing for any host that returned a config.
  const valid = results.filter(r => r.ok && r.msToClose != null);
  if (valid.length) {
    console.log('\n--- Current round timing per responding host ---');
    for (const r of valid) {
      const endTime = r.endTime ? new Date(r.endTime).toISOString() : '?';
      const sign = r.msToClose < 0 ? 'CLOSED ' : 'OPEN  ';
      console.log(`  ${r.host.padEnd(26)} round=${String(r.issueNumber).slice(-10)} endTime=${endTime} ${sign}${r.msToClose}ms to close`);
    }
  } else {
    console.log('No host returned a parseable round config.');
  }

  process.exit(0);
})().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
