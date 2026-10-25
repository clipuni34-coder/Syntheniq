#!/usr/bin/env node
/**
 * Refresh Cognito token and obtain fresh fb999.com JWT.
 */
'use strict';

const https = require('https');
const crypto = require('crypto');
const fs = require('fs');

const USER_POOL_ID = 'us-east-1_STn3OFCzh';
const CLIENT_ID = '4dh5iirgrp5ai5ba6sduu6mguq';
const USERNAME = 'aiwugod@gmail.com';
const PASSWORD = 'Drewziwugod@6';
const REGION = 'us-east-1';
const COGNITO_HOST = `cognito-idp.${REGION}.amazonaws.com`;
const COGNITO_ENDPOINT = `https://${COGNITO_HOST}/`;

let existingTokens = {};
try {
  existingTokens = JSON.parse(fs.readFileSync('/tmp/viralclips_tokens.json', 'utf8'));
  console.log('Loaded existing tokens from /tmp/viralclips_tokens.json');
} catch (e) {
  console.log('No existing tokens found');
}

function httpsReq(hostname, path, method, body, headers = {}, port = 443) {
  return new Promise((resolve, reject) => {
    const mergedHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/json, text/plain, */*',
      ...headers,
    };
    if (body) mergedHeaders['Content-Type'] = 'application/json;charset=UTF-8';
    const req = https.request({ hostname, port, path, method, headers: mergedHeaders }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    });
    req.setTimeout(15000);
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function getAmzDate() {
  const now = new Date();
  return now.getUTCFullYear().toString() +
    String(now.getUTCMonth() + 1).padStart(2, '0') +
    String(now.getUTCDate()).padStart(2, '0') +
    'T' +
    String(now.getUTCHours()).padStart(2, '0') +
    String(now.getUTCMinutes()).padStart(2, '0') +
    String(now.getUTCSeconds()).padStart(2, '0') +
    'Z';
}

function ne() { return crypto.randomBytes(16).toString('hex'); }
function we(str) { return crypto.createHash('md5').update(str).digest('hex').toUpperCase().slice(0, 32); }
function signParams(params) {
  const u = { ...params, language: 0 };
  u.random = ne();
  const c = JSON.parse(JSON.stringify(u));
  const o = Object.keys(c).filter(key =>
    !(typeof c[key] === 'object' && c[key] !== null && !Array.isArray(c[key])) && !Array.isArray(c[key]));
  o.sort();
  const i = {};
  o.forEach(key => { if (c[key] !== null && c[key] !== "" && c[key] !== undefined) i[key] = c[key] === 0 ? 0 : c[key]; });
  u.signature = we(JSON.stringify(i));
  u.timestamp = Math.floor(Date.now() / 1e3);
  return u;
}

async function refreshCognito() {
  console.log('\n=== Step 1: Refreshing Cognito Token ===\n');
  if (!existingTokens.refresh_token) {
    console.log('No refresh_token available');
    return false;
  }

  try {
    const amzDate = getAmzDate();
    const body = {
      AuthFlow: 'REFRESH_TOKEN_AUTH',
      ClientId: CLIENT_ID,
      AuthParameters: {
        REFRESH_TOKEN: existingTokens.refresh_token,
      },
    };
    const headers = {
      'Content-Type': 'application/x-amz-json-1.1',
      'X-Amz-Target': 'AWSCognitoIdentityProviderService.InitiateAuth',
      'X-Amz-Date': amzDate,
      'X-Amz-User-Agent': 'aws-cognito-identity-js/0.0.0',
    };

    const res = await httpsReq(COGNITO_HOST, '/', 'POST', JSON.stringify(body), headers);
    console.log(`Refresh status: ${res.status}`);
    console.log(`Body: ${res.body.substring(0, 600)}`);

    if (res.status === 200) {
      const json = JSON.parse(res.body);
      if (json.AuthenticationResult) {
        const newTokens = {
          access_token: json.AuthenticationResult.AccessToken,
          id_token: json.AuthenticationResult.IdToken,
          refresh_token: json.AuthenticationResult.RefreshToken || existingTokens.refresh_token,
          expires_in: json.AuthenticationResult.ExpiresIn,
        };
        fs.writeFileSync('/tmp/viralclips_tokens.json', JSON.stringify(newTokens, null, 2));
        const payload = JSON.parse(Buffer.from(newTokens.access_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
        console.log('*** TOKENS REFRESHED ***');
        console.log(`New access_token expires: ${new Date(payload.exp * 1000).toISOString()}`);
        console.log('Saved to /tmp/viralclips_tokens.json');
        return newTokens;
      }
    }
    console.log('Refresh did not succeed.');
    return false;
  } catch (e) {
    console.log('Refresh error:', e.message);
    return false;
  }
}

async function tryCognitoLogin(idToken) {
  console.log('\n=== Step 2: fb999 Login via Cognito Token ===\n');
  const cookie = `id_token=${idToken}; access_token=${idToken}`;
  const attempts = [
    { name: 'LoginByCognito', path: '/api/webapi/LoginByCognito', body: { idToken, token: idToken, language: 0 } },
    { name: 'CognitoLogin', path: '/api/webapi/CognitoLogin', body: { idToken, token: idToken, language: 0 } },
    { name: 'Login (idToken)', path: '/api/webapi/Login', body: { idToken, token: idToken, language: 0 } },
    { name: 'LoginByCognito (Bearer)', path: '/api/webapi/LoginByCognito', body: { idToken, token: idToken, language: 0 }, useBearer: true },
  ];

  for (const attempt of attempts) {
    try {
      console.log(`[${attempt.name}] POST ${attempt.path}`);
      const headers = {};
      if (attempt.useBearer) headers['Authorization'] = `Bearer ${idToken}`;
      else headers['Cookie'] = cookie;
      const res = await httpsReq('fb999api.com', attempt.path, 'POST', JSON.stringify(attempt.body), headers);
      console.log(`  Status: ${res.status}`);
      if (res.body.length > 0) {
        console.log(`  Body: ${res.body.substring(0, 500)}`);
        try {
          const json = JSON.parse(res.body);
          if ((json.code === 0 || res.status === 200) && json.data && json.data.token) {
            console.log('  *** LOGIN SUCCESS! ***');
            fs.writeFileSync('/tmp/fb999_login_response.json', JSON.stringify(json, null, 2));
            console.log('  Saved to /tmp/fb999_login_response.json');
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

async function tryLoginByPhone() {
  console.log('\n=== Step 3: Direct Phone Login ===\n');
  const username = '2349121493739';
  const pwd = 'Drewziwugod6';
  const loginType = 'mobile';

  console.log('[Simple POST] /api/webapi/Login');
  try {
    const body = JSON.stringify({ userNumber: username, pwd, loginType });
    const res = await httpsReq('fb999api.com', '/api/webapi/Login', 'POST', body);
    console.log(`  Status: ${res.status}`);
    console.log(`  Body: ${res.body.substring(0, 500)}`);
    const json = JSON.parse(res.body);
    if (json.code === 0 && json.data && json.data.token) {
      console.log('  *** LOGIN SUCCESS! ***');
      fs.writeFileSync('/tmp/fb999_login_response.json', JSON.stringify(json, null, 2));
      console.log('  Saved to /tmp/fb999_login_response.json');
      return json.data;
    } else {
      console.log('  Code:', json.code, 'Msg:', json.msg);
    }
  } catch(e) {
    console.log('  Error:', e.message);
  }
  return null;
}

async function main() {
  let tokens = existingTokens;
  let idToken = existingTokens.id_token;

  // Step 1: Refresh Cognito
  const refreshed = await refreshCognito();
  if (refreshed) {
    tokens = refreshed;
    idToken = tokens.id_token;
  }

  // Step 2: Try fb999 login with Cognito token
  const loginData = await tryCognitoLogin(idToken);
  if (loginData) {
    console.log('\n=== SUCCESS: Both tokens obtained ===');
    return;
  }

  // Step 3: Fallback - direct phone login (only one attempt to avoid lockout)
  const phoneLogin = await tryLoginByPhone();
  if (phoneLogin) {
    console.log('\n=== SUCCESS: fb999 JWT obtained via phone login ===');
    return;
  }

  // Check existing fb999 token
  try {
    const existing = JSON.parse(fs.readFileSync('/tmp/fb999_login_response.json', 'utf8'));
    if (existing.data && existing.data.token) {
      console.log('\nUsing existing fb999 login response (token may be expired)');
      console.log('Token:', existing.data.token.substring(0, 60) + '...');
    }
  } catch(e) {}

  console.log('\n=== Could not obtain fresh tokens. Will try with existing ones. ===');
}

main().catch(e => console.error('Fatal:', e.message));
