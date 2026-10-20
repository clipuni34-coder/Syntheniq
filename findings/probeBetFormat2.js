const https = require('https');
const crypto = require('crypto');
const fs = require('fs');

const JWT = JSON.parse(fs.readFileSync('/tmp/fb999_login_response.json', 'utf8')).data.token;

function ne() { return crypto.randomBytes(16).toString('hex'); }
function we(s) { return crypto.createHash('md5').update(s).digest('hex').toUpperCase().slice(0, 32); }
function signParams(p) {
  const u = { ...p, language: 0 }; u.random = ne();
  const c = JSON.parse(JSON.stringify(u));
  const o = Object.keys(c).filter(k => !(typeof c[k] === 'object' && c[k] !== null && !Array.isArray(c[k])) && !Array.isArray(c[k]));
  o.sort();
  const i = {};
  o.forEach(k => { if (c[k] !== null && c[k] !== '' && c[k] !== undefined) i[k] = c[k] === 0 ? 0 : c[k]; });
  u.signature = we(JSON.stringify(i)); u.timestamp = Math.floor(Date.now() / 1e3); return u;
}
function post(host, path, body, extra = {}) {
  return new Promise((res, rej) => {
    const h = { 'Content-Type': 'application/json', 'Accept': '*/*', 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15', 'Referer': 'https://fb999.com/', 'Origin': 'https://fb999.com', 'ar-origin': 'https://fb999.com', ...extra };
    h['Content-Length'] = Buffer.byteLength(body);
    const r = https.request({ hostname: host, path, method: 'POST', headers: h, timeout: 8000 }, q => {
      let d = ''; q.on('data', c => d += c); q.on('end', () => res({ status: q.statusCode, body: d, headers: q.headers }));
    });
    r.on('error', rej); r.on('timeout', () => { r.destroy(); rej(new Error('timeout')); });
    r.write(body); r.end();
  });
}
function get(host, path) {
  return new Promise((res, rej) => {
    https.request({ hostname: host, path, method: 'GET', headers: { 'User-Agent': 'Mozilla/5.0' } }, q => {
      let d = ''; q.on('data', c => d += c); q.on('end', () => res({ status: q.statusCode, body: d }));
    }).on('error', rej).end();
  });
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
  const cfg = JSON.parse((await get('draw.ar-lottery06.com', '/WinGo/WinGo_30S.json')).body);
  const iss = cfg.current.issueNumber;
  console.log('currentIssue:', iss, '| msToClose:', cfg.current.endTime - Date.now());

  console.log('\n=== SERVER SelectType broad scan ===');
  const pool = ['0','1','2','3','4','5','6','7','8','9','10','11','12','100','101','102','103','104','105','106',
    'red','green','violet','Red','Green','Violet','RED','GREEN','VIOLET','Big','Small','big','small',
    'BigSmall_Big','BigSmall_Small','Color_Red','Color_Green','Color_Violet','Num_0'];
  for (const st of pool) {
    const body = JSON.stringify(signParams({ TypeId: 30, lottery: 'WinGo', gameCode: 'WinGo_30S', issueNumber: iss, BetCount: 1, Amount: 1, SelectType: st }));
    try {
      const r = await post('fb999api.com', '/api/webapi/GameBetting', body, { Authorization: 'Bearer ' + JWT, Cookie: 'ar_token=' + JWT });
      let j = null; try { j = JSON.parse(r.body); } catch (e) {}
      console.log('SelectType=' + JSON.stringify(st).padEnd(18) + ' -> status=' + r.status + ' code=' + (j ? j.code : '?') + ' msg=' + (j ? (j.msg || '').substring(0, 50) : r.body.substring(0, 80)));
    } catch (e) { console.log('SelectType=' + st + ' ERR ' + e.message); }
    await sleep(60);
  }

  console.log('\n=== SERVER: betContent param (no SelectType) ===');
  for (const cb of ['BigSmall_Big','Color_Red','Num_5']) {
    const body = JSON.stringify(signParams({ TypeId: 30, lottery: 'WinGo', gameCode: 'WinGo_30S', issueNumber: iss, BetCount: 1, Amount: 1, betContent: cb }));
    try { const r = await post('fb999api.com', '/api/webapi/GameBetting', body, { Authorization: 'Bearer ' + JWT, Cookie: 'ar_token=' + JWT }); console.log('betContent='+cb+' -> '+r.body.substring(0,120)); }
    catch (e) { console.log('betContent='+cb+' ERR '+e.message); }
    await sleep(60);
  }

  console.log('\n=== FRONTEND /Lottery/WinGoBet auth variants (h5 host) ===');
  const fbody = JSON.stringify(signParams({ issueNumber: iss, amount: 1, betMultiple: 1, betContent: 'BigSmall_Big' }));
  const variants = [
    { hdr: { Authorization: 'Bearer ' + JWT, Cookie: 'ar_token=' + JWT } },
    { hdr: { Cookie: 'ar_token=' + JWT } },
    { hdr: { Authorization: 'Bearer ' + JWT } },
  ];
  const path0 = '/api/Lottery/WinGoBet';
  for (const v of variants) {
    try { const r = await post('h5.ar-lottery06.com', path0, fbody, v); console.log('h5' + path0 + ' hdr=' + JSON.stringify(Object.keys(v.hdr)) + ' -> status=' + r.status + ' body=' + r.body.substring(0, 120)); }
    catch (e) { console.log('ERR ' + e.message); }
    await sleep(60);
  }
})().catch(e => console.error('FATAL', e.message));
