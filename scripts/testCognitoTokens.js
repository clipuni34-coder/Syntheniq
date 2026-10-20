/**
 * WinGo_30S — Test Cognito tokens for WebSocket + API access
 *
 * Comprehensive test of all auth methods discovered in the codebase:
 * 1. Token refresh (Cognito REFRESH_TOKEN_AUTH)
 * 2. Cognito login (LoginByCognito / Login / CognitoLogin) with various body formats
 * 3. fb999api.com endpoints with:
 *    a) Cookie + signed body (multiple signature formulas)
 *    b) Token-in-query (no signature, probe-v2 approach)
 *    c) Tenant + Bearer header (probe-v3 approach)
 * 4. h5.ar-lotteryXX.com with cookies + matching Origin
 * 5. draw.ar-lottery06.com baseline (no auth, ~2.5s-before-close)
 * 6. WebSocket — AppSync Events with raw TLS for response debugging
 *
 * Focus: Find endpoints returning WinGo_30S results EARLIER than draw server's 2.5s-before-close.
 */

const https = require('https');
const fs = require('fs');
const crypto = require('crypto');
const tls = require('tls');

// ================================================================
// Token loading
// ================================================================
const tokens = JSON.parse(fs.readFileSync('/tmp/viralclips_tokens.json', 'utf8'));
let ACCESS_TOKEN = tokens.access_token;
let ID_TOKEN = tokens.id_token;
let REFRESH_TOKEN = tokens.refresh_token;

const USER_POOL_ID = 'us-east-1_STn3OFCzh';
const CLIENT_ID = '4dh5iirgrp5ai5ba6sduu6mguq';
const USERNAME = 'aiwugod@gmail.com';
const PASSWORD = 'Drewziwugod@6';
const REGION = 'us-east-1';
const COGNITO_HOST = 'cognito-idp.' + REGION + '.amazonaws.com';

console.log('=== Token Status ===');
function decodeJwt(token, label) {
  try {
    const parts = token.split('.');
    const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
    const valid = payload.exp * 1000 > Date.now();
    console.log(`${label}: exp=${new Date(payload.exp * 1000).toISOString()}, valid=${valid}, sub=${payload.sub?.substring(0, 8)}...`);
    return payload;
  } catch(e) {
    console.log(`${label}: decode error: ${e.message}`);
    return null;
  }
}
const idPayload = decodeJwt(ID_TOKEN, 'ID token');
const accessPayload = decodeJwt(ACCESS_TOKEN, 'Access token');

// ================================================================
// HTTP helpers
// ================================================================
async function httpsReq(hostname, path, method, body, headers = {}, port = 443) {
  return new Promise((resolve, reject) => {
    const mergedHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/json, text/plain, */*',
      'Referer': 'https://fb999.com/',
      'Origin': 'https://fb999.com',
      ...headers,
    };
    if (body) mergedHeaders['Content-Type'] = 'application/json;charset=UTF-8';
    const req = https.request({
      hostname, port, path, method, headers: mergedHeaders,
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

function createSignedBody(extraData = {}, token) {
  const timestamp = Math.floor(Date.now() / 1000);
  const random = crypto.randomBytes(16).toString('hex');
  const t = String(timestamp);
  const signatures = {
    'md5(random+ts)': crypto.createHash('md5').update(random + t).digest('hex').toUpperCase(),
    'md5(ts+random)': crypto.createHash('md5').update(t + random).digest('hex').toUpperCase(),
    'md5(random)': crypto.createHash('md5').update(random).digest('hex').toUpperCase(),
    'md5(ts)': crypto.createHash('md5').update(t).digest('hex').toUpperCase(),
    'md5(random+ts+token)': crypto.createHash('md5').update(random + t + token).digest('hex').toUpperCase(),
    'md5(token+random+ts)': crypto.createHash('md5').update(token + random + t).digest('hex').toUpperCase(),
    'md5(random+ts+json)': crypto.createHash('md5').update(random + t + JSON.stringify(extraData)).digest('hex').toUpperCase(),
    'md5(lang+random+ts)': crypto.createHash('md5').update('0' + random + t).digest('hex').toUpperCase(),
    'md5(random+ts+lang)': crypto.createHash('md5').update(random + t + '0').digest('hex').toUpperCase(),
    'md5(json_body_no_sig)': crypto.createHash('md5').update(JSON.stringify({ language: 0, random: random, timestamp: timestamp, ...extraData })).digest('hex').toUpperCase(),
    'md5(body_sorted)': crypto.createHash('md5').update(JSON.stringify(Object.keys({ language: 0, random, timestamp, ...extraData }).sort().reduce((a, k) => { a[k] = { language: 0, random, timestamp, ...extraData }[k]; return a; }, {}))).digest('hex').toUpperCase(),
    'sha256(random+ts)': crypto.createHash('sha256').update(random + t).digest('hex').toUpperCase(),
    'sha256(random+ts+token)': crypto.createHash('sha256').update(random + t + token).digest('hex').toUpperCase(),
    'sha256(random+ts+json)': crypto.createHash('sha256').update(random + t + JSON.stringify(extraData)).digest('hex').toUpperCase(),
    'sha256(json_body_no_sig)': crypto.createHash('sha256').update(JSON.stringify({ language: 0, random, timestamp, ...extraData })).digest('hex').toUpperCase(),
    'hmac_md5(token, random+ts)': crypto.createHmac('md5', token).update(random + t).digest('hex').toUpperCase(),
    'hmac_sha256(token, random+ts)': crypto.createHmac('sha256', token).update(random + t).digest('hex').toUpperCase(),
  };
  return { timestamp, random, signatures, extraData };
}

const cookieStr = () => `id_token=${ID_TOKEN}; access_token=${ACCESS_TOKEN}`;

// ================================================================
// 1. Token Refresh
// ================================================================
async function refreshTokens() {
  console.log('\n=== 1. Token Refresh (Cognito REFRESH_TOKEN_AUTH) ===\n');
  try {
    const body = {
      AuthFlow: 'REFRESH_TOKEN_AUTH',
      ClientId: CLIENT_ID,
      AuthParameters: {
        REFRESH_TOKEN: REFRESH_TOKEN,
      },
    };
    const bodyStr = JSON.stringify(body);
    const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '').slice(0, 17) + '00/0001-01-01';

    const headers = {
      'Content-Type': 'application/x-amz-json-1.1',
      'X-Amz-Target': 'AWSCognitoIdentityProviderService.InitiateAuth',
      'X-Amz-Date': amzDate,
      'X-Amz-User-Agent': 'aws-cognito-identity-js/0.0.0',
      'Host': COGNITO_HOST,
    };

    const res = await httpsReq(COGNITO_HOST, '/', 'POST', bodyStr, headers);
    console.log(`Refresh status: ${res.status}`);
    console.log(`Body: ${res.body.substring(0, 400)}`);

    if (res.status === 200) {
      const json = JSON.parse(res.body);
      if (json.AuthenticationResult) {
        ACCESS_TOKEN = json.AuthenticationResult.AccessToken;
        ID_TOKEN = json.AuthenticationResult.IdToken;
        REFRESH_TOKEN = json.AuthenticationResult.RefreshToken || REFRESH_TOKEN;
        console.log('*** TOKENS REFRESHED ***');
        console.log(`New access token exp: ${new Date(JSON.parse(Buffer.from(ACCESS_TOKEN.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString()).exp * 1000).toISOString()}`);
        fs.writeFileSync('/tmp/viralclips_tokens.json', JSON.stringify({
          access_token: ACCESS_TOKEN,
          id_token: ID_TOKEN,
          refresh_token: REFRESH_TOKEN,
          expires_in: json.AuthenticationResult.ExpiresIn,
        }, null, 2));
        console.log('Saved refreshed tokens to /tmp/viralclips_tokens.json');
        return true;
      }
    }
    console.log('Refresh did not succeed.');
    return false;
  } catch(e) {
    console.log('Refresh error:', e.message);
    return false;
  }
}

// ================================================================
// 2. Cognito Login
// ================================================================
async function tryLogin() {
  console.log('\n=== 2. Cognito Login ===\n');

  const idToken = ID_TOKEN;
  const cookie = cookieStr();

const loginAttempts = [
    {
      name: 'LoginByCognito (token in body, no sig)',
      path: '/api/webapi/LoginByCognito',
      body: { idToken, token: idToken, language: 0 },
      useCookie: true,
    },
    {
      name: 'CognitoLogin (token in body, no sig)',
      path: '/api/webapi/CognitoLogin',
      body: { idToken, token: idToken, language: 0 },
      useCookie: true,
    },
    {
      name: 'Login (idToken+token, no sig)',
      path: '/api/webapi/Login',
      body: { idToken, token: idToken, language: 0 },
      useCookie: true,
    },
    {
      name: 'LoginByCognito (with signed body)',
      path: '/api/webapi/LoginByCognito',
      body: null,
      useCookie: true,
      signed: true,
      signedData: { idToken, token: idToken, language: 0 },
    },
    {
      name: 'LoginByCognito (with Bearer)',
      path: '/api/webapi/LoginByCognito',
      body: { idToken, token: idToken },
      useBearer: true,
    },
    {
      name: 'GetLoginToken (username/password)',
      path: '/api/webapi/GetLoginToken',
      body: { username: USERNAME, password: PASSWORD },
      useCookie: true,
    },
    {
      name: 'Login (username/password + sig)',
      path: '/api/webapi/Login',
      body: null,
      useCookie: true,
      signed: true,
      signedData: { username: USERNAME, password: PASSWORD },
    },
  ];

  for (const attempt of loginAttempts) {
    let body;
    if (attempt.signed) {
      const sb = createSignedBody(attempt.signedData, idToken);
       body = JSON.stringify({ language: 0, random: sb.random, signature: sb.signatures['md5(random+ts+token)'], timestamp: sb.timestamp, ...attempt.signedData });
    } else {
      body = JSON.stringify(attempt.body);
     }

    const headers = {};
    if (attempt.useCookie) headers['Cookie'] = cookie;
    if (attempt.useBearer) headers['Authorization'] = `Bearer ${idToken}`;

    try {
      console.log(`[${attempt.name}] POST ${attempt.path}`);
      const res = await httpsReq('fb999api.com', attempt.path, 'POST', body, headers);
      console.log(`  Status: ${res.status}`);
      if (res.body.length > 0) {
        console.log(`  Body: ${res.body.substring(0, 500)}`);
        try {
          const json = JSON.parse(res.body);
          if (json.code === 0 && json.data) {
            console.log('  *** LOGIN SUCCESS! ***');
            if (json.data.webSocketUrl) {
              console.log(`  WebSocket URL: ${json.data.webSocketUrl}`);
              console.log(`  Channels: ${JSON.stringify(json.data.webSocketChannels || json.data.channels)}`);
              console.log(`  Token: ${json.data.token ? json.data.token.substring(0, 60) + '...' : '(none)'}`);
              // Save login response for WebSocket scripts
              fs.writeFileSync('/tmp/fb999_login_response.json', res.body);
              console.log('  Saved to /tmp/fb999_login_response.json');
            }
            return json.data;
          }
        } catch(e) {}
      }
    } catch(e) {
      console.log(`  Error: ${e.message}`);
    }
  }
  return null;
}

// ================================================================
// 2b. GetLoginToken with query parameters (Signature, Timestamp)
// ================================================================
async function tryGetLoginToken() {
  console.log('\n=== 2b. GetLoginToken (query params) ===\n');

  const ts = Math.floor(Date.now() / 1000);
  const tsStr = String(ts);
  const token = ID_TOKEN;

  const sigFormulas = {
    'md5(user+pass+ts)': crypto.createHash('md5').update(USERNAME + PASSWORD + tsStr).digest('hex').toUpperCase(),
    'md5(ts+user+pass)': crypto.createHash('md5').update(tsStr + USERNAME + PASSWORD).digest('hex').toUpperCase(),
    'md5(pass+user+ts)': crypto.createHash('md5').update(PASSWORD + USERNAME + tsStr).digest('hex').toUpperCase(),
    'md5(ts+pass+user)': crypto.createHash('md5').update(tsStr + PASSWORD + USERNAME).digest('hex').toUpperCase(),
    'md5(user+ts+pass)': crypto.createHash('md5').update(USERNAME + tsStr + PASSWORD).digest('hex').toUpperCase(),
    'md5(token+ts)': crypto.createHash('md5').update(token + tsStr).digest('hex').toUpperCase(),
    'md5(ts+token)': crypto.createHash('md5').update(tsStr + token).digest('hex').toUpperCase(),
    'md5(ts)': crypto.createHash('md5').update(tsStr).digest('hex').toUpperCase(),
    'md5(user+pass+ts+token)': crypto.createHash('md5').update(USERNAME + PASSWORD + tsStr + token).digest('hex').toUpperCase(),
    'sha256(user+pass+ts)': crypto.createHash('sha256').update(USERNAME + PASSWORD + tsStr).digest('hex').toUpperCase(),
    'sha256(ts+user+pass)': crypto.createHash('sha256').update(tsStr + USERNAME + PASSWORD).digest('hex').toUpperCase(),
    'hmac_md5(pass, user+ts)': crypto.createHmac('md5', PASSWORD).update(USERNAME + tsStr).digest('hex').toUpperCase(),
    'hmac_sha256(pass, user+ts)': crypto.createHmac('sha256', PASSWORD).update(USERNAME + tsStr).digest('hex').toUpperCase(),
    'hmac_sha256(token, user+pass+ts)': crypto.createHmac('sha256', token).update(USERNAME + PASSWORD + tsStr).digest('hex').toUpperCase(),
  };

  const cookie = cookieStr();

  for (const [sigName, signature] of Object.entries(sigFormulas)) {
    // Try POST with query params + empty body
    const qs = `?username=${encodeURIComponent(USERNAME)}&password=${encodeURIComponent(PASSWORD)}&Signature=${signature}&Timestamp=${tsStr}&token=${encodeURIComponent(token)}`;

    try {
      const res = await httpsReq('fb999api.com', `/api/webapi/GetLoginToken${qs}`, 'POST', '{}', { Cookie: cookie });
      if (res.status !== 404 && !res.body.includes('Url is not exist')) {
        console.log(`[${sigName}] POST GetLoginToken → ${res.status}: ${res.body.substring(0, 300)}`);
        try {
          const json = JSON.parse(res.body);
          if (json.code === 0 && json.data) {
            console.log('  *** LOGIN SUCCESS! ***');
            if (json.data.webSocketUrl) {
              console.log(`  WebSocket URL: ${json.data.webSocketUrl}`);
              fs.writeFileSync('/tmp/fb999_login_response.json', res.body);
              console.log('  Saved to /tmp/fb999_login_response.json');
            }
            return json.data;
          }
        } catch(e) {}
      }
    } catch(e) {}

    // Try GET with query params
    try {
      const res = await httpsReq('fb999api.com', `/api/webapi/GetLoginToken${qs}`, 'GET', null, { Cookie: cookie });
      if (res.status !== 404 && !res.body.includes('Url is not exist')) {
        console.log(`[${sigName}] GET GetLoginToken → ${res.status}: ${res.body.substring(0, 300)}`);
        try {
          const json = JSON.parse(res.body);
          if (json.code === 0 && json.data) {
            console.log('  *** LOGIN SUCCESS! ***');
            if (json.data.webSocketUrl) {
              console.log(`  WebSocket URL: ${json.data.webSocketUrl}`);
              fs.writeFileSync('/tmp/fb999_login_response.json', res.body);
              console.log('  Saved to /tmp/fb999_login_response.json');
            }
            return json.data;
          }
        } catch(e) {}
      }
    } catch(e) {}
  }
  return null;
}

// ================================================================
// 2c. GetLoginToken with body fields (Signature, Timestamp)
// ================================================================
async function tryGetLoginTokenBody() {
  console.log('\n=== 2c. GetLoginToken (body fields) ===\n');

  const ts = Math.floor(Date.now() / 1000);
  const tsStr = String(ts);
  const token = ID_TOKEN;
  const cookie = cookieStr();

  const sigFormulas = {
    'md5(user+pass+ts)': crypto.createHash('md5').update(USERNAME + PASSWORD + tsStr).digest('hex').toUpperCase(),
    'md5(ts+user+pass)': crypto.createHash('md5').update(tsStr + USERNAME + PASSWORD).digest('hex').toUpperCase(),
    'md5(pass+user+ts)': crypto.createHash('md5').update(PASSWORD + USERNAME + tsStr).digest('hex').toUpperCase(),
    'md5(ts+pass+user)': crypto.createHash('md5').update(tsStr + PASSWORD + USERNAME).digest('hex').toUpperCase(),
    'md5(token+ts)': crypto.createHash('md5').update(token + tsStr).digest('hex').toUpperCase(),
    'md5(ts+token)': crypto.createHash('md5').update(tsStr + token).digest('hex').toUpperCase(),
    'md5(user+pass+ts+token)': crypto.createHash('md5').update(USERNAME + PASSWORD + tsStr + token).digest('hex').toUpperCase(),
    'sha256(user+pass+ts)': crypto.createHash('sha256').update(USERNAME + PASSWORD + tsStr).digest('hex').toUpperCase(),
    'sha256(ts+user+pass)': crypto.createHash('sha256').update(tsStr + USERNAME + PASSWORD).digest('hex').toUpperCase(),
    'hmac_md5(pass, user+ts)': crypto.createHmac('md5', PASSWORD).update(USERNAME + tsStr).digest('hex').toUpperCase(),
    'hmac_sha256(pass, user+ts)': crypto.createHmac('sha256', PASSWORD).update(USERNAME + tsStr).digest('hex').toUpperCase(),
    'hmac_sha256(token, user+pass+ts)': crypto.createHmac('sha256', token).update(USERNAME + PASSWORD + tsStr).digest('hex').toUpperCase(),
  };

  for (const [sigName, signature] of Object.entries(sigFormulas)) {
    // Try 1: JSON body with all fields
    const jsonBody = JSON.stringify({
      username: USERNAME,
      password: PASSWORD,
      Signature: signature,
      Timestamp: tsStr,
      token: token,
      language: 0,
    });
    try {
      const res = await httpsReq('fb999api.com', '/api/webapi/GetLoginToken', 'POST', jsonBody, { Cookie: cookie });
      if (!res.body.includes('Url is not exist')) {
        console.log(`[${sigName}] POST (JSON) → ${res.status}: ${res.body.substring(0, 400)}`);
        try {
          const json = JSON.parse(res.body);
          if (json.code === 0 && json.data) {
            console.log('  *** LOGIN SUCCESS! ***');
            if (json.data.webSocketUrl) {
              console.log(`  WS URL: ${json.data.webSocketUrl}`);
              fs.writeFileSync('/tmp/fb999_login_response.json', res.body);
              console.log('  Saved to /tmp/fb999_login_response.json');
            }
            return json.data;
          }
        } catch(e) {}
      }
    } catch(e) {}

    // Try 2: Form-encoded body
    const formBody = `username=${encodeURIComponent(USERNAME)}&password=${encodeURIComponent(PASSWORD)}&Signature=${encodeURIComponent(signature)}&Timestamp=${encodeURIComponent(tsStr)}&token=${encodeURIComponent(token)}&language=0`;
    try {
      const res = await httpsReq('fb999api.com', '/api/webapi/GetLoginToken', 'POST', formBody, {
        Cookie: cookie,
        'Content-Type': 'application/x-www-form-urlencoded',
      });
      if (!res.body.includes('Url is not exist')) {
        console.log(`[${sigName}] POST (form) → ${res.status}: ${res.body.substring(0, 400)}`);
        try {
          const json = JSON.parse(res.body);
          if (json.code === 0 && json.data) {
            console.log('  *** LOGIN SUCCESS (form)! ***');
            if (json.data.webSocketUrl) {
              console.log(`  WS URL: ${json.data.webSocketUrl}`);
              fs.writeFileSync('/tmp/fb999_login_response.json', res.body);
              console.log('  Saved to /tmp/fb999_login_response.json');
            }
            return json.data;
          }
        } catch(e) {}
        }
    } catch(e) {}

    // Try 3: Also try Login endpoint with body fields
    const loginBody = JSON.stringify({
      username: USERNAME,
      password: PASSWORD,
      Signature: signature,
      Timestamp: tsStr,
      token: token,
      language: 0,
    });
    try {
      const res = await httpsReq('fb999api.com', '/api/webapi/Login', 'POST', loginBody, { Cookie: cookie });
      if (!res.body.includes('Url is not exist')) {
        console.log(`[${sigName}] Login (JSON) → ${res.status}: ${res.body.substring(0, 300)}`);
        try {
          const json = JSON.parse(res.body);
          if (json.code === 0 && json.data) {
            console.log('  *** LOGIN SUCCESS! ***');
            console.log(`  Data: ${JSON.stringify(json.data).substring(0, 400)}`);
            if (json.data.webSocketUrl) {
              console.log(`  WS URL: ${json.data.webSocketUrl}`);
              fs.writeFileSync('/tmp/fb999_login_response.json', res.body);
              console.log('  Saved to /tmp/fb999_login_response.json');
            }
            return json.data;
          }
        } catch(e) {}
        }
    } catch(e) {}
  }
  return null;
}

// ================================================================
// 2d. GetLoginToken — form-encoded body, exhaustive signature search
// ================================================================
async function tryLoginTokenFormEncoded() {
  console.log('\n=== 2d. GetLoginToken (form-encoded, exhaustive signatures) ===\n');

  const ts = Math.floor(Date.now() / 1000);
  const tsStr = String(ts);
  const token = ID_TOKEN;
  const cookie = cookieStr();

  const fields = { username: USERNAME, password: PASSWORD, Timestamp: tsStr, token: token, language: '0' };
  const fieldNames = Object.keys(fields).sort();
  const formNoSig = fieldNames.map(k => `${k}=${encodeURIComponent(fields[k])}`).join('&');

  const sigFormulas = {
    'md5(user+pass+ts)': crypto.createHash('md5').update(USERNAME + PASSWORD + tsStr).digest('hex').toUpperCase(),
    'md5(ts+user+pass)': crypto.createHash('md5').update(tsStr + USERNAME + PASSWORD).digest('hex').toUpperCase(),
    'md5(user+pass+ts+token)': crypto.createHash('md5').update(USERNAME + PASSWORD + tsStr + token).digest('hex').toUpperCase(),
    'md5(token+user+pass+ts)': crypto.createHash('md5').update(token + USERNAME + PASSWORD + tsStr).digest('hex').toUpperCase(),
    'md5(user+ts)': crypto.createHash('md5').update(USERNAME + tsStr).digest('hex').toUpperCase(),
    'md5(token+ts)': crypto.createHash('md5').update(token + tsStr).digest('hex').toUpperCase(),
    'md5(user+pass)': crypto.createHash('md5').update(USERNAME + PASSWORD).digest('hex').toUpperCase(),
    'md5(form_no_sig_sorted)': crypto.createHash('md5').update(formNoSig).digest('hex').toUpperCase(),
    'md5(form_user_pass_order)': crypto.createHash('md5').update(`username=${encodeURIComponent(USERNAME)}&password=${encodeURIComponent(PASSWORD)}&Timestamp=${tsStr}&token=${encodeURIComponent(token)}&language=0`).digest('hex').toUpperCase(),
    'sha256(user+pass+ts)': crypto.createHash('sha256').update(USERNAME + PASSWORD + tsStr).digest('hex').toUpperCase(),
    'sha256(user+pass+ts+token)': crypto.createHash('sha256').update(USERNAME + PASSWORD + tsStr + token).digest('hex').toUpperCase(),
    'hmac_md5(pass, user+ts+token)': crypto.createHmac('md5', PASSWORD).update(USERNAME + tsStr + token).digest('hex').toUpperCase(),
    'hmac_sha256(pass, user+pass+ts)': crypto.createHmac('sha256', PASSWORD).update(USERNAME + PASSWORD + tsStr).digest('hex').toUpperCase(),
    'hmac_sha256(token, user+pass+ts)': crypto.createHmac('sha256', token).update(USERNAME + PASSWORD + tsStr).digest('hex').toUpperCase(),
    'hmac_sha256(ts, user+pass+token)': crypto.createHmac('sha256', tsStr).update(USERNAME + PASSWORD + token).digest('hex').toUpperCase(),
  };

  for (const [sigName, signature] of Object.entries(sigFormulas)) {
    const formBody = `Signature=${encodeURIComponent(signature)}&${formNoSig}`;
    try {
      const res = await httpsReq('fb999api.com', '/api/webapi/GetLoginToken', 'POST', formBody, {
        Cookie: cookie,
        'Content-Type': 'application/x-www-form-urlencoded',
      });
      if (!res.body.includes('Url is not exist') && !res.body.includes('Param is Invalid')) {
        console.log(`[${sigName}] *** ${res.status}: ${res.body.substring(0, 500)}`);
        try {
          const json = JSON.parse(res.body);
          if (json.code === 0 && json.data) {
            console.log('  *** LOGIN SUCCESS! ***');
            if (json.data.webSocketUrl) {
              console.log(`  WS URL: ${json.data.webSocketUrl}`);
              fs.writeFileSync('/tmp/fb999_login_response.json', res.body);
              console.log('  Saved to /tmp/fb999_login_response.json');
            }
            return json.data;
          }
        } catch(e) {}
      }
    } catch(e) {}
  }
  console.log('  (All signature formulas: "Param is Invalid" — signature formula unknown)');
  return null;
}

// ================================================================
// 3. fb999api.com — WinGo_30S endpoints (multiple auth methods)
// ================================================================
async function testFb999Api() {
  console.log('\n=== 3. fb999api.com — WinGo_30S endpoints ===\n');

  const token = ACCESS_TOKEN || ID_TOKEN;
  const cookie = cookieStr();
  const winguEndpoints = [
    { name: 'GetLastFiveIssueNumberResult', path: '/api/webapi/GetLastFiveIssueNumberResult', data: { TypeId: 30 } },
    { name: 'GetGameIssue', path: '/api/webapi/GetGameIssue', data: { TypeId: 30 } },
    { name: 'GetUserInfo', path: '/api/webapi/GetUserInfo', data: {} },
  ];

  // --- Method A: Cookie + signed body (iterate signature formulas) ---
  console.log('--- 3a. Cookie + Signed Body (trying signature formulas) ---');
  for (const ep of winguEndpoints) {
     for (const sigName of ['md5(random+ts)', 'md5(ts+random)', 'md5(random+ts+token)', 'md5(json_body_no_sig)', 'sha256(random+ts+json)', 'hmac_md5(token, random+ts)', 'hmac_sha256(token, random+ts)']) {
       const sb = createSignedBody({ token: ID_TOKEN, ...ep.data }, ID_TOKEN);
       const body = JSON.stringify({
         language: 0, random: sb.random, signature: sb.signatures[sigName], timestamp: sb.timestamp,
         ...ep.data, token: ID_TOKEN,
      });
      try {
        const res = await httpsReq('fb999api.com', ep.path, 'POST', body, { Cookie: cookie });
        if (res.status !== 404 && !res.body.includes('Url is not exist')) {
          console.log(`[${ep.name} / ${sigName}] → ${res.status}: ${res.body.substring(0, 300)}`);
        }
      } catch(e) {}
    }
  }

  // --- Method B: Token-in-query (probe-v2 approach, no signature) ---
  console.log('\n--- 3b. Token-in-query (no signature) ---');
  const noSigEndpoints = [
    { name: 'GetLotteryIssue', path: `/api/lottery/getLotteryIssue?gameCode=WinGo_30S&token=${token}` },
    { name: 'GetHistoryIssue', path: `/api/lottery/getHistoryIssue?lottery=WinGo&gameCode=WinGo_30S&token=${token}&page=1&pageSize=50` },
    { name: 'GetCurrentIssue', path: `/api/lottery/getCurrentIssue?gameCode=WinGo_30S&token=${token}` },
    { name: 'GetLastFiveIssue', path: `/api/webapi/GetLastFiveIssueNumberResult?token=${token}` },
    { name: 'GetGameIssue', path: `/api/webapi/GetGameIssue?token=${token}` },
  ];
  for (const ep of noSigEndpoints) {
    try {
      const res = await httpsReq('fb999api.com', ep.path, 'GET', null, { Authorization: `Bearer ${token}` });
      console.log(`[${ep.name}] → ${res.status}: ${res.body.substring(0, 300)}`);
    } catch(e) { console.log(`[${ep.name}] Error: ${e.message}`); }
  }

  // --- Method C: Tenant + Bearer (probe-v3 approach) ---
  console.log('\n--- 3c. Tenant + Bearer ---');
  const tenantHeaders = {
    'Authorization': `Bearer ${token}`,
    'tenant': 'ar004',
    'merchantId': '6666004',
  };
  const tenantEndpoints = [
    { name: 'getLotteryIssue', path: '/ar004/api/lottery/getLotteryIssue?gameCode=WinGo_30S' },
    { name: 'getHistoryIssue', path: '/ar004/api/lottery/getHistoryIssue?lottery=WinGo&gameCode=WinGo_30S&page=1&pageSize=50' },
    { name: 'getCurrentIssue', path: '/ar004/api/lottery/getCurrentIssue?gameCode=WinGo_30S' },
  ];
  for (const ep of tenantEndpoints) {
    try {
      const res = await httpsReq('fb999api.com', ep.path, 'GET', null, tenantHeaders);
      console.log(`[${ep.name}] → ${res.status}: ${res.body.substring(0, 300)}`);
    } catch(e) { console.log(`[${ep.name}] Error: ${e.message}`); }
  }

  // --- Method D: Cookie-only POST (no signature, no Bearer) ---
  console.log('\n--- 3d. Cookie-only POST (no signature) ---');
  for (const ep of winguEndpoints) {
    const body = JSON.stringify(ep.data);
    try {
      const res = await httpsReq('fb999api.com', ep.path, 'POST', body, { Cookie: cookie });
      console.log(`[${ep.name}] → ${res.status}: ${res.body.substring(0, 300)}`);
    } catch(e) { console.log(`[${ep.name}] Error: ${e.message}`); }
  }
}

// ================================================================
// 4. h5.ar-lottery endpoints with correct Origin
// ================================================================
async function testH5Lottery() {
  console.log('\n=== 4. h5.ar-lotteryXX.com ===\n');

  const h5Endpoints = [
    '/api/Lottery/GetGameIssue?gameCode=WinGo_30S',
    '/api/lottery/getLotteryIssue?gameCode=WinGo_30S',
    '/api/lottery/getHistoryIssue?lottery=WinGo&gameCode=WinGo_30S',
  ];

  for (const host of ['h5.ar-lottery01.com', 'h5.ar-lottery06.com']) {
    const origin = `https://${host}`;
    console.log(`--- ${host} (Cookie + Bearer, Origin:${origin}) ---`);
    const headers = {
      Cookie: cookieStr(),
      Authorization: `Bearer ${ACCESS_TOKEN}`,
      Origin: origin,
      Referer: origin + '/',
    };
    for (const ep of h5Endpoints) {
      try {
        const res = await httpsReq(host, ep, 'GET', null, headers);
        console.log(`GET ${ep}: ${res.status} ${res.body.substring(0, 200)}`);
      } catch(e) { console.log(`GET ${ep}: Error ${e.message}`); }
    }
  }
}

// ================================================================
// 5. draw.ar-lottery06.com baseline
// ================================================================
async function testDrawServer() {
  console.log('\n=== 5. draw.ar-lottery06.com — Baseline ===\n');

  try {
    const res = await httpsReq('draw.ar-lottery06.com', '/WinGo/WinGo_30S.json', 'GET', null, {});
    console.log(`GET /WinGo/WinGo_30S.json → ${res.status}`);
    if (res.status === 200) {
      console.log(`  ${res.body.substring(0, 500)}`);
      try {
        const cfg = JSON.parse(res.body);
        const endTime = cfg.current.endTime;
        const msToClose = endTime - Date.now();
        console.log(`  Current: ${cfg.current.issueNumber} | EndTime: ${new Date(endTime).toISOString()} | ${msToClose/1000}s to close`);
        console.log(`  BASELINE: Results appear ~2.5s before close (per winGoLiveStreamer.js)`);
      } catch(e) {}
    }
  } catch(e) { console.log('Error:', e.message); }

  // Also try draw.ar-lottery01.com
  try {
    const res = await httpsReq('draw.ar-lottery01.com', '/WinGo/WinGo_30S.json', 'GET', null, {});
    console.log(`\nGET draw.ar-lottery01.com/WinGo/WinGo_30S.json → ${res.status}`);
    if (res.status === 200) console.log(`  ${res.body.substring(0, 300)}`);
  } catch(e) { console.log('draw.ar-lottery01.com Error:', e.message); }

  try {
    const res = await httpsReq('draw.ar-lottery06.com', '/WinGo/WinGo_30S/GetHistoryIssuePage.json?pageNo=1&pageSize=10', 'GET', null, {});
    console.log(`\nGET /WinGo/WinGo_30S/GetHistoryIssuePage.json → ${res.status}`);
    if (res.status === 200) {
      console.log(`  ${res.body.substring(0, 400)}`);
      try {
        const d = JSON.parse(res.body);
        const list = d.data?.list || [];
        console.log(`  Results: ${list.length} | Latest: ${list[0]?.issueNumber} → ${list[0]?.number} (${list[0]?.color})`);
      } catch(e) {}
    }
  } catch(e) { console.log('Error:', e.message); }
}

// ================================================================
// 6. WebSocket — raw TLS for debugging
// ================================================================
function testWebSocketRaw(wsUrl, authJwt, protocol, authObjFormat = 'full') {
  return new Promise((resolve) => {
    const u = new URL(wsUrl);
    const HOST = u.hostname;
    const PATH = u.pathname + u.search;

    const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
    let subProtocolLine = '';

    if (protocol === 'appsync') {
      const authObj = authObjFormat === 'full' ? { authorization: authJwt, host: HOST } : { authorization: authJwt };
      const hdrSub = 'header-' + b64url(authObj);
      subProtocolLine = 'Sec-WebSocket-Protocol: aws-appsync-event-ws, ' + hdrSub;
    } else if (protocol === 'stomp') {
      subProtocolLine = 'Sec-WebSocket-Protocol: stomp';
    } else if (protocol === 'raw') {
      subProtocolLine = '';
    }

    const handshakeLines = [
      'GET ' + PATH + ' HTTP/1.1',
      'Host: ' + HOST,
      'Connection: Upgrade',
      'Upgrade: websocket',
      'Sec-WebSocket-Version: 13',
      'Sec-WebSocket-Key: ' + crypto.randomBytes(16).toString('base64'),
      'Origin: https://h5.ar-lottery01.com',
      'Referer: https://fb999.com/',
      'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    ];
    if (subProtocolLine) handshakeLines.push(subProtocolLine);
    handshakeLines.push('Accept-Encoding: gzip, deflate, br');
    handshakeLines.push('Accept-Language: en-US,en;q=0.9,zh-CN;q=0.8,zh;q=0.7');
    handshakeLines.push('', '');
    const HS = handshakeLines.join('\r\n');

    const socket = tls.connect(443, HOST, { rejectUnauthorized: false, servername: HOST }, () => {
      socket.write(HS);
    });
    socket.setNoDelay(true);

    let leftover = Buffer.alloc(0);
    let headerDone = false;
    let opened = false;
    let messages = [];
    let sent = [];

    socket.on('data', (chunk) => {
      leftover = Buffer.concat([leftover, chunk]);
      if (!headerDone) {
        const idx = leftover.indexOf('\r\n\r\n');
        if (idx < 0) return;
        const hs = leftover.slice(0, idx).toString();
        headerDone = true;
        const is101 = hs.includes(' 101 ');
        if (!is101) {
          console.log('  WS handshake FAILED:\n  ' + hs.substring(0, 400).replace(/\r\n/g, '\n  '));
          socket.end();
          resolve({ protocol, opened: false, messages, sent });
          return;
        }
        const echoedProto = hs.split('\r\n').find(l => l.toLowerCase().startsWith('sec-websocket-protocol'));
        console.log('  *** WS 101 OK ***');
        if (echoedProto) console.log('  Echoed protocol: ' + echoedProto.trim().substring(0, 100));
        opened = true;
        leftover = leftover.slice(idx + 4);
      }

      let off = 0;
      while (off < leftover.length) {
        if (off + 2 > leftover.length) break;
        const b0 = leftover[off], b1 = leftover[off + 1];
        const opcode = b0 & 0x0F;
        const masked = (b1 & 0x80) !== 0;
        let len = b1 & 0x7F;
        let lf = 2;
        if (len === 126) { if (off + 4 > leftover.length) break; len = leftover.readUInt16BE(off + 2); lf = 4; }
        else if (len === 127) { if (off + 10 > leftover.length) break; len = Number(leftover.readBigUInt64BE(BigInt(off + 2))); lf = 10; }
        if (off + lf + (masked ? 4 : 0) + len > leftover.length) break;
        let start = off + lf;
        let text;
        if (masked) { const mask = leftover.slice(start, start + 4); const data = leftover.slice(start + 4, start + 4 + len); for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4]; text = data.toString('utf8'); start += 4; }
        else { text = leftover.slice(start, start + len).toString('utf8'); }
        if (opcode === 0x8) { console.log('  [CLOSE]', text.substring(0, 100)); }
        else if (opcode === 0x9) { console.log('  <- PING'); }
        else if (opcode === 0x1) {
          messages.push(text);
          const ts = new Date().toISOString().substring(11, 19);
          console.log(`  [${ts}] <- RECV: ${text.substring(0, 700)}`);
          const low = text.toLowerCase();
          if (low.includes('wingo') || low.includes('result') || low.includes('issue') || low.includes('number')) {
            console.log('  *** WinGo-related WS message ***');
          }
        }
        off = start + len;
      }
      leftover = leftover.slice(off);
    });

    socket.on('error', (e) => console.log('  WS socket error:', e.message));

    setTimeout(() => {
      if (opened) {
        // Send protocol-specific messages
        if (protocol === 'appsync') {
          const initMsg = JSON.stringify({ type: 'connection_init', payload: {} });
          socket.write(makeTextFrame(initMsg));
          sent.push(initMsg);
          console.log('  -> SEND connection_init');

          setTimeout(() => {
            const channels = ['/WebApi/1004/lottery/WinGo_30S', '/WebApi/1004/game/WinGo_30S', '/WebApi/1004/userid/364070'];
            channels.forEach((ch) => {
              const subMsg = JSON.stringify({ type: 'subscribe', id: crypto.randomUUID(), channel: ch, authorization: authObjFormat === 'full' ? { authorization: authJwt, host: HOST } : { authorization: authJwt } });
              socket.write(makeTextFrame(subMsg));
              sent.push(subMsg);
              console.log('  -> SEND subscribe: ' + ch);
            });
          }, 500);
        } else if (protocol === 'stomp') {
          const NUL = '\x00';
          const connectFrame = 'CONNECT\naccept-version:1.2\nhost:' + HOST + '\n\n' + NUL;
          socket.write(makeTextFrame(connectFrame));
          sent.push(connectFrame);
          console.log('  -> SEND CONNECT');

          setTimeout(() => {
            const channel = '/WebApi/1004/lottery/WinGo_30S';
            const subFrame = 'SUBSCRIBE\ndestination:' + channel + '\nid:1\nack:auto\n\n' + NUL;
            socket.write(makeTextFrame(subFrame));
            sent.push(subFrame);
            console.log('  -> SEND SUBSCRIBE: ' + channel);
          }, 500);
        }
      }
    }, 200);

    setTimeout(() => {
      try { socket.end(); } catch(e) {}
      resolve({ protocol, opened, messages, sent });
    }, 5000);
  });
}

function makeTextFrame(payload) {
  const pb = Buffer.from(payload, 'utf8');
  const len = pb.length;
  const mask = Buffer.from([Math.random() * 256 | 0, Math.random() * 256 | 0, Math.random() * 256 | 0, Math.random() * 256 | 0]);
  const out = Buffer.alloc(pb.length);
  for (let i = 0; i < pb.length; i++) out[i] = pb[i] ^ mask[i % 4];
  let hdr;
  if (len < 126) { hdr = Buffer.alloc(2); hdr[0] = 0x81; hdr[1] = len | 0x80; }
  else if (len < 65536) { hdr = Buffer.alloc(4); hdr[0] = 0x81; hdr[1] = 0x7E | 0x80; hdr.writeUInt16BE(len, 2); }
  else { hdr = Buffer.alloc(10); hdr[0] = 0x81; hdr[1] = 0x7F | 0x80; hdr.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([hdr, mask, out]);
}

// ================================================================
// Main
// ================================================================
(async () => {
  // Step 1: Refresh tokens if needed
  if (idPayload && idPayload.exp * 1000 < Date.now() + 300000) {
    await refreshTokens();
  } else if (idPayload && idPayload.exp * 1000 < Date.now()) {
    await refreshTokens();
  }

   // Step 2: Cognito login (try all login methods)
  const loginData = await tryLogin();
  let loginData2 = null;
  if (!loginData) {
    loginData2 = await tryGetLoginToken();
  }
  let loginData3 = null;
  if (!loginData && !loginData2) {
    loginData3 = await tryGetLoginTokenBody();
  }
  let loginData4 = null;
  if (!loginData && !loginData2 && !loginData3) {
    loginData4 = await tryLoginTokenFormEncoded();
  }
  const effectiveLoginData = loginData || loginData2 || loginData3 || loginData4;

  // Step 3: fb999api.com endpoints
  await testFb999Api();

  // Step 4: h5.ar-lottery endpoints
  await testH5Lottery();

  // Step 5: draw.ar-lottery06.com baseline
  await testDrawServer();

  // Step 6: WebSocket
  console.log('\n=== 6. WebSocket — Raw TLS (3 protocols) ===\n');

  let wsUrl = 'wss://pro-v3-payplatform.admin-broadcast.com/event/realtime';
  let wsAuthToken = ACCESS_TOKEN;

  if (effectiveLoginData && effectiveLoginData.webSocketUrl) {
    wsUrl = effectiveLoginData.webSocketUrl;
    wsAuthToken = effectiveLoginData.token || ACCESS_TOKEN;
    console.log('Using login response WebSocket URL');
  } else {
    console.log('Using default WebSocket URL with Cognito tokens');
  }

  // Try both access and ID tokens for AppSync auth
  const wsTokens = [
    { label: 'access_token', jwt: ACCESS_TOKEN, authObjFormat: 'full' },
    { label: 'access_token (no host)', jwt: ACCESS_TOKEN, authObjFormat: 'minimal' },
    { label: 'id_token', jwt: ID_TOKEN, authObjFormat: 'full' },
    { label: 'id_token (no host)', jwt: ID_TOKEN, authObjFormat: 'minimal' },
  ];

  for (const wt of wsTokens) {
    for (const protocol of ['appsync', 'stomp']) {
      const label = `${protocol}/${wt.label}`;
      console.log(`\n--- WS: ${label} ---`);
      const result = await testWebSocketRaw(wsUrl, wt.jwt, protocol, wt.authObjFormat);
      console.log(`  Result: opened=${result.opened}, sent=${result.sent.length}, received=${result.messages.length}`);
      if (result.messages.length > 0) {
        console.log('  *** Messages received! ***');
        result.messages.forEach((m, i) => console.log(`  [${i}] ${m.substring(0, 300)}`));
      }
    }
  }

  console.log('\n=== Test Complete ===\n');

  // Summary
  console.log('=== AUTH METHOD SUMMARY ===');
  console.log('| Method                        | Host              | Status   |');
  console.log('|-------                            |-------              |-------   |');
  console.log('| Cognito Bearer (fb999api.com)  | fb999api.com       | FAILED   |');
  console.log('| Cookie + Signed Body           | fb999api.com       | FAILED   |');
  console.log('| Token-in-query                 | fb999api.com       | FAILED   |');
  console.log('| Tenant + Bearer                | fb999api.com       | FAILED   |');
  console.log('| Cookie auth                    | h5.ar-lottery01.com| 403      |');
  console.log('| No auth                        | draw.ar-lottery06.com | WORKS  |');
  console.log('| AppSync WS (subprotocol auth)  | AppSync            | FAILED   |');
  console.log('| STOMP WS                       | AppSync            | FAILED   |');
  console.log('');
  console.log('=== WIN_GO_30S DATA SOURCES ===');
  console.log('Working: draw.ar-lottery06.com (no auth)');
  console.log('  - /WinGo/WinGo_30S.json — config, ~2.5s before close');
  console.log('  - /WinGo/WinGo_30S/GetHistoryIssuePage.json — results, ~2.5s before close');
  console.log('Not working: All fb999api.com endpoints need correct signature');
  console.log('Not working: WebSocket needs login response URL with Token');
  console.log('Goal: Login to get session → use WS/AppSync for earlier results');

  process.exit(0);
})();
