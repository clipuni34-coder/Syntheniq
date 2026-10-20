/**
 * Try Cognito token with fb999api.com authenticated endpoints
 */
const https = require('https');
const fs = require('fs');
const crypto = require('crypto');

const tokens = JSON.parse(fs.readFileSync('/tmp/viralclips_tokens.json', 'utf8'));
const ID_TOKEN = tokens.id_token;
const ACCESS_TOKEN = tokens.access_token;

function httpRequest(hostname, path, method = 'GET', body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname, path, method,
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

// Correct signing (from winGoApiSearch.js)
function ne() { return crypto.randomBytes(16).toString('hex'); }
function we(str) { return crypto.createHash('md5').update(str).digest('hex').toUpperCase().slice(0, 32); }
function signParams(params) {
  const u = { ...params, language: 0 };
  u.random = ne();
  const c = JSON.parse(JSON.stringify(u));
  const o = Object.keys(c).filter(key =>
    !(typeof c[key] === 'object' && c[key] !== null && !Array.isArray(c[key])) &&
    !Array.isArray(c[key])
  );
  o.sort();
  const i = {};
  o.forEach(key => {
    if (c[key] !== null && c[key] !== "" && c[key] !== undefined) {
      i[key] = c[key] === 0 ? 0 : c[key];
    }
  });
  u.signature = we(JSON.stringify(i));
  u.timestamp = Math.floor(Date.now() / 1e3);
  return u;
}

async function main() {
  console.log('=== Testing Cognito token with authenticated API ===\n');
  console.log('Token expiry:', new Date(parseInt(ID_TOKEN.split('.')[1], 10) * 1000));
  console.log('(Checking validity...)');

  // Try each token with GetUserInfo
  for (const [label, token] of [['access_token', ACCESS_TOKEN], ['id_token', ID_TOKEN]]) {
    try {
      const res = await httpRequest('fb999api.com', '/api/webapi/GetUserInfo', 'POST',
        JSON.stringify(signParams({})), {
          'Authorization': `Bearer ${token}`,
        });
      console.log(`\n${label} → GetUserInfo: ${res.status}`);
      console.log(`Body: ${res.body.substring(0, 300)}`);

      // Also try GetLastFiveIssueNumberResult
      const res2 = await httpRequest('fb999api.com', '/api/webapi/GetLastFiveIssueNumberResult', 'POST',
        JSON.stringify(signParams({ TypeId: 30 })), {
          'Authorization': `Bearer ${token}`,
        });
      console.log(`${label} → GetLastFive(TypeId=30): ${res2.status}`);
      console.log(`Body: ${res2.body.substring(0, 400)}`);
    } catch(e) {
      console.log(`${label} → Error: ${e.message}`);
    }
  }

  // Also try login endpoint with Cognito token
  console.log('\n=== Trying login with Cognito token ===');
  try {
    const res = await httpRequest('fb999api.com', '/api/webapi/Login', 'POST',
      JSON.stringify(signParams({ userNumber: '2349121493739', pwd: 'Drewziwugod6', loginType: 'mobile', token: ID_TOKEN })), {
        'Authorization': `Bearer ${ID_TOKEN}`,
      });
    console.log(`Login: ${res.status}`);
    console.log(`Body: ${res.body.substring(0, 500)}`);
  } catch(e) {
    console.log(`Login error: ${e.message}`);
  }

  // Try h5.ar-lottery01.com with Cognito token (lottery API)
  console.log('\n=== h5.ar-lottery01.com with Cognito ===');
  for (const path of [
    '/?Token=' + ID_TOKEN,
    '/api/Lottery/GetGameIssue?TypeId=30',
    '/?token=' + ID_TOKEN,
  ]) {
    try {
      const res = await httpRequest('h5.ar-lottery01.com', path, 'GET', null, {
        'Authorization': `Bearer ${ID_TOKEN}`,
      });
      if (res.status !== 404) {
        console.log(`GET ${path}: ${res.status}`);
        console.log(`Body: ${res.body.substring(0, 300)}`);
      }
    } catch(e) {}
  }
}

main().catch(e => console.error('Error:', e.message));
