const https = require('https');
const fs = require('fs');
const crypto = require('crypto');
const tokens = JSON.parse(fs.readFileSync('/tmp/viralclips_tokens.json', 'utf8'));
const TOKEN = tokens.access_token;
function ne() { return crypto.randomBytes(16).toString('hex'); }
function we(str) { return crypto.createHash('md5').update(str).digest('hex').toUpperCase().slice(0, 32); }
function signParams(params) {
  const u = { ...params, language: 0 };
  u.random = ne();
  const c = JSON.parse(JSON.stringify(u));
  const o = Object.keys(c).filter(key => !(typeof c[key] === 'object' && c[key] !== null && !Array.isArray(c[key])) && !Array.isArray(c[key]));
  o.sort();
  const i = {};
  o.forEach(key => { if (c[key] !== null && c[key] !== "" && c[key] !== undefined) i[key] = c[key] === 0 ? 0 : c[key]; });
  u.signature = we(JSON.stringify(i));
  u.timestamp = Math.floor(Date.now() / 1e3);
  return u;
}
function httpRequest(hostname, path, method = 'GET', body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path, method, headers: { 'Accept': 'application/json', 'Content-Type': 'application/json', ...headers } }, (res) => {
      let data = ''; res.on('data', c => data += c); res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}
(async () => {
  console.log('token expires_in:', tokens.expires_in);
  const res = await httpRequest('fb999api.com', '/api/webapi/GetLastFiveIssueNumberResult', 'POST', JSON.stringify(signParams({ TypeId: 30 })), { 'Authorization': `Bearer ${TOKEN}` });
  console.log('API status:', res.status);
  console.log('API body:', res.body.slice(0, 600));
})();
