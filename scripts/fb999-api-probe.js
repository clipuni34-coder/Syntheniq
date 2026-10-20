#!/usr/bin/env node
/**
 * fb999-api-probe.js
 *
 * Uses the refresh_token to get fresh JWT tokens from Cognito,
 * then probes fb999 API endpoints to extract WinGo prediction/data.
 *
 * Usage: node scripts/fb999-api-probe.js
 */

'use strict';

const crypto = require('crypto');
const https = require('https');
const fs = require('fs');

// Cognito config
const USER_POOL_ID = 'us-east-1_STn3OFCzh';
const CLIENT_ID = '4dh5iirgrp5ai5ba6sduu6mguq';
const USERNAME = 'aiwugod@gmail.com';
const PASSWORD = 'Drewziwugod@6';
const REGION = 'us-east-1';
const COGNITO_HOST = `cognito-idp.${REGION}.amazonaws.com`;
const COGNITO_ENDPOINT = `https://${COGNITO_HOST}/`;

// API config from window.CONFIG
const API_BASE = 'https://fb999api.com';
const MERCHANT_ID = '6666004';
const TENANT = 'ar004';
const GAME_CODE = 'WinGo_30S';
const LOTTERY = 'WinGo';

// Load existing tokens
let existingTokens;
try {
  existingTokens = JSON.parse(fs.readFileSync('/tmp/viralclips_tokens.json', 'utf8'));
  console.log('Loaded existing tokens from /tmp/viralclips_tokens.json');
} catch (e) {
  console.log('No existing tokens found');
  existingTokens = {};
}

// Crypto helpers
function sha256Hex(buf) {
  const h = crypto.createHash('sha256').update(buf).digest();
  return Buffer.from(h).toString('hex').padStart(64, '0');
}

function hmacSha256(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest();
}

function padHex(value) {
  let hex = value.toString(16);
  if (hex.length % 2 !== 0) hex = '0' + hex;
  if (hex.length > 0 && /[89abcdef]/.test(hex[0])) {
    hex = '00' + hex;
  }
  return hex;
}

function modPow(base, exp, modulus) {
  if (modulus === 1n) return 0n;
  let result = 1n;
  base = base % modulus;
  while (exp > 0n) {
    if (exp & 1n) result = (result * base) % modulus;
    exp = exp >> 1n;
    base = (base * base) % modulus;
  }
  return result;
}

function generateRandomSmallA() {
  const hexRandom = crypto.randomBytes(128).toString('hex');
  return BigInt('0x' + hexRandom);
}

const N_HEX =
  'FFFFFFFFFFFFFFFFC90FDAA22168C234C4C6628B80DC1CD1' +
  '29024E088A67CC74020BBEA63B139B22514A08798E3404DD' +
  'EF9519B3CD3A431B302B0A6DF25F14374FE1356D6D51C245' +
  'E485B576625E7EC6F44C42E9A637ED6B0BFF5CB6F406B7ED' +
  'EE386BFB5A899FA5AE9F24117C4B1FE649286651ECE45B3D' +
  'C2007CB8A163BF0598DA48361C55D39A69163FA8FD24CF5F' +
  '83655D23DCA3AD961C62F356208552BB9ED529077096966D' +
  '670C354E4ABC9804F1746C08CA18217C32905E462E36CE3B' +
  'E39E772C180E86039B2783A2EC07A28FB5C55DF06F4C52C9' +
  'DE2BCBF6955817183995497CEA956AE515D2261898FA0510' +
  '15728E5A8AAAC42DAD33170D04507A33A85521ABDF1CBA64' +
  'ECFB850458DBEF0A8AEA71575D060C7DB3970F85A6E1E4C7' +
  'ABF5AE8CDB0933D71E8C94E04A25619DCEE3D2261AD2EE6B' +
  'F12FFA06D98A0864D87602733EC86A64521F2B18177B200C' +
  'BBE117577A615D6C770988C0BAD946E208E24FA074E5AB31' +
  '43DB5BFCE0FD108E4B82D120A93AD2CAFFFFFFFFFFFFFFFF';

const N_BI = BigInt('0x' + N_HEX);
const G_BI = 2n;
const POOL_NAME = USER_POOL_ID.split('_')[1];

function getNowString() {
  const now = new Date();
  const weekDay = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][now.getUTCDay()];
  const month = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][now.getUTCMonth()];
  const day = now.getUTCDate();
  const hours = String(now.getUTCHours()).padStart(2, '0');
  const minutes = String(now.getUTCMinutes()).padStart(2, '0');
  const seconds = String(now.getUTCSeconds()).padStart(2, '0');
  const year = now.getUTCFullYear();
  return `${weekDay} ${month} ${day} ${hours}:${minutes}:${seconds} UTC ${year}`;
}

function computeSrpValues({ smallA, largeA, serverB, salt, username, password }) {
  const uHex = sha256Hex(Buffer.from(padHex(largeA) + padHex(serverB), 'hex'));
  const uBig = BigInt('0x' + uHex);
  const kHex = sha256Hex(Buffer.from(padHex(N_BI) + padHex(G_BI), 'hex'));
  const kBig = BigInt('0x' + kHex);
  const usernamePassword = `${POOL_NAME}${username}:${password}`;
  const usernamePasswordHash = sha256Hex(Buffer.from(usernamePassword, 'utf8'));
  const xBig = BigInt('0x' + sha256Hex(Buffer.from(padHex(salt) + usernamePasswordHash, 'hex')));
  const gModPowX = modPow(G_BI, xBig, N_BI);
  let base = serverB - kBig * gModPowX;
  base = ((base % N_BI) + N_BI) % N_BI;
  const exponent = smallA + uBig * xBig;
  const sValue = modPow(base, exponent, N_BI);
  const infoBitsBuffer = Buffer.concat([
    Buffer.from('Caldera Derived Key', 'utf8'),
    Buffer.from([0x01]),
  ]);
  const ikm = Buffer.from(padHex(sValue), 'hex');
  const saltHkdf = Buffer.from(padHex(uBig), 'hex');
  const prk = hmacSha256(saltHkdf, ikm);
  const okm = hmacSha256(prk, infoBitsBuffer);
  const hkdf = okm.slice(0, 16);
  return { hkdf, uHex };
}

function computeSignature(hkdf, secretBlockB64, poolName, username, dateNow) {
  const concatBuffer = Buffer.concat([
    Buffer.from(poolName, 'utf8'),
    Buffer.from(username, 'utf8'),
    Buffer.from(secretBlockB64, 'base64'),
    Buffer.from(dateNow, 'utf8'),
  ]);
  const sig = hmacSha256(hkdf, concatBuffer);
  return Buffer.from(sig).toString('base64');
}

function sigV4Sign({ method, path, query, headers, body, accessKeyId, secretAccessKey, date, region, service }) {
  const amzDate = date;
  const dateStamp = date.substring(0, 8);
  const lowerHeaders = {};
  for (const k of Object.keys(headers)) {
    lowerHeaders[k.toLowerCase()] = headers[k];
  }
  const headerKeys = Object.keys(lowerHeaders).sort();
  const canonicalHeadersStr = headerKeys
    .map((k) => `${k}:${String(lowerHeaders[k]).trim()}`)
    .join('\n');
  const signedHeaders = headerKeys.join(';');
  const payloadHash = sha256Hex(Buffer.from(body || ''));
  const canonicalRequest = [method, path, query || '', canonicalHeadersStr + '\n', signedHeaders, payloadHash].join('\n');
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256Hex(Buffer.from(canonicalRequest)),
  ].join('\n');
  const kDate = hmacSha256('AWS4' + secretAccessKey, dateStamp);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, service);
  const kSigning = hmacSha256(kService, 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  return `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

function rawHttpsRequest(action, params) {
  return new Promise((resolve, reject) => {
    const now = new Date();
    const amzDate =
      now.getUTCFullYear().toString() +
      String(now.getUTCMonth() + 1).padStart(2, '0') +
      String(now.getUTCDate()).padStart(2, '0') +
      'T' +
      String(now.getUTCHours()).padStart(2, '0') +
      String(now.getUTCMinutes()).padStart(2, '0') +
      String(now.getUTCSeconds()).padStart(2, '0') +
      'Z';
    const body = JSON.stringify(params);
    const headers = {
      'Content-Type': 'application/x-amz-json-1.1',
      'X-Amz-Target': `AWSCognitoIdentityProviderService.${action}`,
      'X-Amz-Date': amzDate,
      'X-Amz-User-Agent': 'aws-sdk-js/3.0',
      Host: COGNITO_HOST,
    };
    headers.Authorization = sigV4Sign({
      method: 'POST',
      path: '/',
      query: '',
      headers,
      body,
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      date: amzDate,
      region: REGION,
      service: 'cognito-idp',
    });
    const req = https.request(COGNITO_ENDPOINT, { method: 'POST', headers }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsed);
          } else {
            const err = new Error(`${action} HTTP ${res.statusCode}: ${data}`);
            err.statusCode = res.statusCode;
            err.body = parsed;
            reject(err);
          }
        } catch (e) {
          const err = new Error(`Failed to parse ${action} response: ${e.message}\nRaw: ${data}`);
          reject(err);
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// Try refresh token first, then fall back to full SRP auth
async function getFreshTokens() {
  console.log('\n=== Getting Fresh Tokens ===');

  // Try refresh token first
  if (existingTokens.refresh_token) {
    console.log('Attempting token refresh...');
    try {
      const result = await rawHttpsRequest('InitiateAuth', {
        AuthFlow: 'REFRESH_TOKEN_AUTH',
        ClientId: CLIENT_ID,
        AuthParameters: {
          REFRESH_TOKEN: existingTokens.refresh_token,
        },
      });
      console.log('Refresh succeeded!');
      return {
        access_token: result.AuthenticationResult.AccessToken,
        id_token: result.AuthenticationResult.IdToken,
        refresh_token: existingTokens.refresh_token,
        expires_in: result.AuthenticationResult.ExpiresIn,
      };
    } catch (e) {
      console.log(`Refresh failed: ${e.message}. Falling back to full auth.`);
    }
  }

  // Full SRP auth
  console.log('Performing full USER_SRP_AUTH flow...');
  const smallA = generateRandomSmallA();
  const largeA = modPow(G_BI, smallA, N_BI);
  const initResp = await rawHttpsRequest('InitiateAuth', {
    AuthFlow: 'USER_SRP_AUTH',
    ClientId: CLIENT_ID,
    AuthParameters: {
      USERNAME: USERNAME,
      SRP_A: largeA.toString(16),
    },
  });

  const challengeName = initResp.ChallengeName;
  const challengeParams = initResp.ChallengeParameters;
  const session = initResp.Session;

  const serverB = BigInt('0x' + challengeParams.SRP_B);
  const salt = BigInt('0x' + challengeParams.SALT);
  const secretBlock = challengeParams.SECRET_BLOCK;
  const userIdForSrp = challengeParams.USER_ID_FOR_SRP;

  const { hkdf } = computeSrpValues({
    smallA,
    largeA,
    serverB,
    salt,
    username: userIdForSrp,
    password: PASSWORD,
  });

  const dateNow = getNowString();
  const signature = computeSignature(hkdf, secretBlock, POOL_NAME, userIdForSrp, dateNow);

  const challengeResp = await rawHttpsRequest('RespondToAuthChallenge', {
    ChallengeName: 'PASSWORD_VERIFIER',
    ClientId: CLIENT_ID,
    ChallengeResponses: {
      USERNAME: userIdForSrp,
      PASSWORD_CLAIM_SECRET_BLOCK: secretBlock,
      TIMESTAMP: dateNow,
      PASSWORD_CLAIM_SIGNATURE: signature,
    },
    Session: session,
  });

  console.log('Full auth succeeded!');
  return {
    access_token: challengeResp.AuthenticationResult.AccessToken,
    id_token: challengeResp.AuthenticationResult.IdToken,
    refresh_token: challengeResp.AuthenticationResult.RefreshToken || existingTokens.refresh_token,
    expires_in: challengeResp.AuthenticationResult.ExpiresIn,
  };
}

// API request helper with HMAC signing
function createApiRequest(method, path, token, body = null, queryString = '') {
  return new Promise((resolve, reject) => {
    const timestamp = Date.now().toString();
    const nonce = crypto.randomBytes(16).toString('hex');
    const urlPath = queryString ? `${path}?${queryString}&token=${token}&timestamp=${timestamp}&nonce=${nonce}` : `${path}?token=${token}&timestamp=${timestamp}&nonce=${nonce}`;
    
    const headers = {
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': 'https://fb999.com/',
      'Origin': 'https://fb999.com',
    };

    const bodyData = body ? JSON.stringify(body) : '';
    if (body) {
      headers['Content-Type'] = 'application/json';
    }

    const req = https.request({
      hostname: 'fb999api.com',
      path: urlPath,
      method: method,
      headers: headers,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          statusText: res.statusText,
          headers: Object.fromEntries(res.headers.entries ? res.headers.entries() : []),
          body: data,
          url: `https://fb999api.com${urlPath}`,
        });
      });
    });
    req.on('error', reject);
    if (body) req.write(bodyData);
    req.end();
  });
}

async function main() {
  console.log('=== FB999 API Probe ===');
  console.log(`API Base: ${API_BASE}`);
  console.log(`Merchant ID: ${MERCHANT_ID}`);
  console.log(`Game Code: ${GAME_CODE}`);
  console.log(`Lottery: ${LOTTERY}\n`);

  // Step 1: Get fresh tokens
  let tokens;
  try {
    tokens = await getFreshTokens();
    console.log('\nTokens obtained:');
    console.log(`  access_token: ${tokens.access_token?.substring(0, 50)}...`);
    console.log(`  id_token: ${tokens.id_token?.substring(0, 50)}...`);
    console.log(`  refresh_token: ${tokens.refresh_token?.substring(0, 50)}...`);
    console.log(`  expires_in: ${tokens.expires_in}`);

    // Save fresh tokens
    fs.writeFileSync('/tmp/viralclips_tokens.json', JSON.stringify(tokens, null, 2));
    console.log('\nSaved fresh tokens to /tmp/viralclips_tokens.json');
  } catch (e) {
    console.error('Failed to get tokens:', e.message);
    if (e.body) console.error('Response:', JSON.stringify(e.body));
    return;
  }

  // Step 2: Probe API endpoints
  const token = tokens.id_token || tokens.access_token;
  if (!token) {
    console.error('No token available for API requests');
    return;
  }

  // Decode JWT to verify
  try {
    const parts = token.split('.');
    const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
    console.log('\nJWT Payload:');
    console.log(`  sub: ${payload.sub}`);
    console.log(`  email: ${payload.email}`);
    console.log(`  token_use: ${payload.token_use}`);
    console.log(`  exp: ${new Date(payload.exp * 1000).toISOString()}`);
  } catch (e) {
    console.log('Could not decode JWT');
  }

  // Test various API endpoints
  const endpoints = [
    { method: 'GET', path: '/api/lottery/getLotteryIssue', query: `gameCode=${GAME_CODE}` },
    { method: 'GET', path: '/api/lottery/getHistoryIssue', query: `lottery=${LOTTERY}&gameCode=${GAME_CODE}` },
    { method: 'GET', path: '/api/lottery/getUserByToken', query: '' },
    { method: 'GET', path: '/api/user/getUserInfo', query: '' },
    { method: 'GET', path: '/api/auth/userInfo', query: '' },
    { method: 'POST', path: '/api/lottery/getHistoryIssue', body: { lottery: LOTTERY, gameCode: GAME_CODE, page: 1, pageSize: 100 } },
    { method: 'GET', path: '/api/lottery/getWinGoConfig', query: `gameCode=${GAME_CODE}` },
    { method: 'GET', path: '/api/lottery/getRecentIssue', query: `gameCode=${GAME_CODE}` },
    { method: 'GET', path: '/api/lottery/getIssue', query: `gameCode=${GAME_CODE}` },
  ];

  console.log('\n=== Probing API Endpoints ===\n');

  for (const endpoint of endpoints) {
    try {
      console.log(`Testing: ${endpoint.method} ${endpoint.path}`);
      const result = await createApiRequest(
        endpoint.method,
        endpoint.path,
        token,
        endpoint.body || null,
        endpoint.query
      );
      console.log(`  Status: ${result.status}`);
      if (result.status >= 200 && result.status < 300) {
        console.log(`  Success! Response:`);
        console.log(`  ${result.body.substring(0, 500)}`);
        // Save successful responses
        const fileName = endpoint.path.replace(/\//g, '_').replace(/api/g, '') + '_' + Date.now() + '.json';
        fs.writeFileSync(`/tmp/fb999_${fileName}`, result.body);
        console.log(`  Saved to /tmp/fb999_${fileName}`);
      } else {
        console.log(`  Failed: ${result.body.substring(0, 200)}`);
      }
    } catch (e) {
      console.log(`  Error: ${e.message}`);
    }
    console.log('');
  }
}

main().catch((e) => {
  console.error('Fatal error:', e);
  process.exit(1);
});
