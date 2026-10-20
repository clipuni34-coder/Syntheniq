/**
 * Direct login to fb999.com API to get fresh JWT
 * Tries the login endpoint with credentials
 */

const https = require('https');
const crypto = require('crypto');
const fs = require('fs');

// Correct signing from winGoApiSearch.js
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

function httpRequest(hostname, path, method = 'POST', body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname, path, method,
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', ...headers }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function main() {
  console.log('=== Direct Login to fb999api.com ===\n');
  
  // Credentials
  const username = '2349121493739';  // Full phone format
  const pwd = 'Drewziwugod6';
  const loginType = 'mobile';  // "mobile" since it's a phone number
  
  console.log('Credentials:');
  console.log('  Username:', username);
  console.log('  LoginType:', loginType);
  
  // Try 1: Simple POST without signing
  console.log('\n--- Attempt 1: Simple POST ---');
  try {
    const body = JSON.stringify({ userNumber: username, pwd, loginType });
    const res = await httpRequest('fb999api.com', '/api/webapi/Login', 'POST', body);
    console.log('Status:', res.status);
    console.log('Body:', res.body.substring(0, 500));
    
    // Check for JWT in response
    try {
      const json = JSON.parse(res.body);
      if (json.data?.token) {
        console.log('✓ JWT found in response!');
        fs.writeFileSync('/tmp/fb999_login_response.json', JSON.stringify(json, null, 2));
        console.log('Saved to /tmp/fb999_login_response.json');
        return;
      }
      if (json.code === 0) console.log('Code 0 but no token:', JSON.stringify(json.data).substring(0, 200));
      else console.log('Response:', JSON.stringify(json).substring(0, 300));
    } catch(e) { console.log('Body:', res.body.substring(0, 300)); }
  } catch(e) {
    console.log('Error:', e.message);
  }
  
  // Try 2: POST with signed params
  console.log('\n--- Attempt 2: POST with signed params ---');
  try {
    const signed = signParams({ userNumber: username, pwd, loginType });
    const res = await httpRequest('fb999api.com', '/api/webapi/Login', 'POST', JSON.stringify(signed));
    console.log('Status:', res.status);
    console.log('Body:', res.body.substring(0, 500));
    
    try {
      const json = JSON.parse(res.body);
      if (json.data?.token) {
        console.log('✓ JWT found in response!');
        fs.writeFileSync('/tmp/fb999_login_response.json', JSON.stringify(json, null, 2));
        console.log('Saved to /tmp/fb999_login_response.json');
        return;
      }
      if (json.code === 0) console.log('Code 0 but no token:', JSON.stringify(json.data).substring(0, 200));
      else console.log('Response:', JSON.stringify(json).substring(0, 300));
    } catch(e) { console.log('Body:', res.body.substring(0, 300)); }
  } catch(e) {
    console.log('Error:', e.message);
  }
  
  // Try 3: Different field names
  console.log('\n--- Attempt 3: Different field names ---');
  const fieldVariants = [
    { username, pwd, loginType },
    { userNumber: username, passWord: pwd, loginType },
    { username, password: pwd, loginType },
    { userName: username, pwd, loginType },
    { account: username, pwd, loginType },
    { loginName: username, pwd, loginType },
    { mobile: username, pwd, loginType },
    { phone: username, pwd, loginType },
    { userAccount: username, pwd, loginType },
    { username: '9121493739', pwd, loginType },  // Without country code
  ];
  
  for (const variant of fieldVariants) {
    try {
      const signed = signParams(variant);
      const res = await httpRequest('fb999api.com', '/api/webapi/Login', 'POST', JSON.stringify(signed), {
        'Content-Type': 'application/json',
      });
      
      if (res.status === 200) {
        try {
          const json = JSON.parse(res.body);
          if (json.data?.token) {
            console.log('✓ JWT FOUND!', Object.keys(variant)[0]);
            fs.writeFileSync('/tmp/fb999_login_response.json', JSON.stringify(json, null, 2));
            console.log('Saved!');
            return;
          }
          if (json.code === 0) {
            console.log(`${Object.keys(variant)[0]}: code=0, data=`, JSON.stringify(json.data).substring(0, 200));
          } else if (json.code === 13) {
            console.log(`${Object.keys(variant)[0]}: code=13 (validation error) — params don't match`);
          } else {
            console.log(`${Object.keys(variant)[0]}: code=${json.code}, msg=${json.msg || 'N/A'}`);
          }
        } catch(e) { console.log(`${Object.keys(variant)[0]}: non-JSON response: ${res.body.substring(0,150)}`); }
      }
    } catch(e) {
      // Skip errors
    }
  }
  
  // Try 4: h5.ar-lottery06.com login
  console.log('\n--- Attempt 4: h5.ar-lottery06.com Login ---');
  const h5Variants = [
    { userNumber: username, pwd, loginType },
    { username, password: pwd, loginType },
    { userNumber: '9121493739', pwd, loginType },
  ];
  
  for (const v of h5Variants) {
    for (const endpoint of ['/api/login', '/api/Login', '/api/webapi/Login', '/api/user/login', '/api/auth/login', '/api/Member/Login']) {
      try {
        const res = await httpRequest('h5.ar-lottery06.com', endpoint, 'POST', JSON.stringify(v), {
          'Content-Type': 'application/json',
        });
        if (res.status !== 404 && res.status !== 405) {
          console.log(`${endpoint} (${Object.keys(v)[0]}): status=${res.status}, body=${res.body.substring(0, 200)}`);
        }
        if (res.status === 200) {
          try {
            const json = JSON.parse(res.body);
            if (json.token || json.data?.token) {
              console.log('✓ TOKEN FOUND at', endpoint);
              const file = json.token ? json : (json.data?.token ? json : json);
              fs.writeFileSync('/tmp/fb999_login_response.json', JSON.stringify(file, null, 2));
              return;
            }
          } catch(e) {}
        }
      } catch(e) {}
    }
  }
  
  console.log('\n=== Login failed — all attempts exhausted ===');
  console.log('Will continue with draw server only (no auth required)');
}

main().catch(e => console.error('Error:', e.message));
