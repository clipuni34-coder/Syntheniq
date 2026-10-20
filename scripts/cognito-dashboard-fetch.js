#!/usr/bin/env node
/**
 * cognito-dashboard-fetch.js
 *
 * 1. Authenticates with AWS Cognito Identity Provider:
 *    - Primary: AWS SDK v3 (@aws-sdk/client-cognito-identity-provider)
 *    - Fallback: raw HTTPS POST to https://cognito-idp.us-east-1.amazonaws.com/
 *      with manual AWS Signature V4 signing.
 *    Since the client uses Amplify's default USER_SRP_AUTH flow (not USER_PASSWORD_AUTH),
 *    a full SRP (Secure Remote Password) protocol implementation is included.
 * 2. Captures session tokens (AccessToken, IdToken, RefreshToken).
 * 3. Fetches https://clip.opus.pro/dashboard using those tokens as cookies +
 *    Authorization header.
 * 4. Saves the dashboard HTML to /tmp/viralclips_dash_auth.html.
 * 5. Captures response cookies from the dashboard.
 *
 * Usage:  node scripts/cognito-dashboard-fetch.js
 */

'use strict';

const crypto = require('crypto');
const https = require('https');
const fs = require('fs');

// ── Configuration ───────────────────────────────────────────────────
const USER_POOL_ID    = 'us-east-1_STn3OFCzh';
const CLIENT_ID       = '4dh5iirgrp5ai5ba6sduu6mguq';
const USERNAME        = 'aiwugod@gmail.com';
const PASSWORD        = 'Drewziwugod@6';
const REGION          = 'us-east-1';
const COGNITO_SERVICE = 'cognito-idp';
const COGNITO_HOST    = `cognito-idp.${REGION}.amazonaws.com`;
const COGNITO_ENDPOINT = `https://${COGNITO_HOST}/`;
const DASHBOARD_URL   = 'https://clip.opus.pro/dashboard';
const OUTPUT_FILE     = '/tmp/viralclips_dash_auth.html';

const BROWSER_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/120.0.0.0 Safari/537.36';

const ANON_CREDENTIALS = {
  accessKeyId:     'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  sessionToken:    undefined,
};

// ── AWS SDK detection ───────────────────────────────────────────────
let sdkAvailable = false;
let CognitoIdentityProviderClient, InitiateAuthCommand, RespondToAuthChallengeCommand;
try {
  ({ CognitoIdentityProviderClient, InitiateAuthCommand, RespondToAuthChallengeCommand } =
    require('@aws-sdk/client-cognito-identity-provider'));
  sdkAvailable = true;
} catch (e) {
  console.warn('[SDK] @aws-sdk/client-cognito-identity-provider not found; will use raw HTTPS.');
}

// ── SRP parameters (from amazon-cognito-identity-js) ────────────────
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

const N_BI   = BigInt('0x' + N_HEX);
const G_BI   = 2n;
const G_HEX  = '2';

const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const WEEK_NAMES  = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

// ── Crypto helpers (using Node's built-in crypto) ──────────────────

/** SHA-256 hash returning a hex string, padded to 64 chars. */
function sha256Hex(buf) {
  const h = crypto.createHash('sha256').update(buf).digest();
  return Buffer.from(h).toString('hex').padStart(64, '0');
}

/** HMAC-SHA256 returning a Buffer. */
function hmacSha256(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest();
}

/**
 * Pad a positive BigInt to a two's-complement even-length hex string.
 * Matches the behaviour of BigInteger.padHex() for non-negative values.
 */
function padHex(value) {
  let hex = value.toString(16);
  if (hex.length % 2 !== 0) hex = '0' + hex;
  // If the most-significant bit of the first byte is set, prepend "00"
  if (hex.length > 0 && /[89abcdef]/.test(hex[0])) {
    hex = '00' + hex;
  }
  return hex;
}

/** Modular exponentiation: base^exp mod modulus (square-and-multiply). */
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

/** Generate a random 128-byte integer as BigInt. */
function generateRandomSmallA() {
  const hexRandom = crypto.randomBytes(128).toString('hex');
  return BigInt('0x' + hexRandom);
}

/**
 * Compute the SRP password claim key (HKDF from the SRP shared secret S).
 * Mirrors AuthenticationHelper.getPasswordAuthenticationKey + computehkdf.
 *
 * @param {bigint} smallA        -- client private ephemeral
 * @param {bigint} largeA        -- client public (A = g^a mod N)
 * @param {bigint} serverB       -- server public (B)
 * @param {bigint} salt          -- salt (from Cognito)
 * @param {string} username      -- USER_ID_FOR_SRP returned by Cognito
 * @param {string} password      -- user password
 * @returns {{ hkdf: Buffer, uHex: string }} -- derived HKDF (16 bytes) and U value
 */
function computeSrpValues({ smallA, largeA, serverB, salt, username, password, poolName }) {
  // U = SHA256(padHex(A) + padHex(B))  — as hex string, then parsed
  const uHex = sha256Hex(Buffer.from(padHex(largeA) + padHex(serverB), 'hex'));
  const uBig = BigInt('0x' + uHex);

  // k = SHA256(padHex(N) + padHex(g))  — computed once, can be cached
  const kHex = sha256Hex(Buffer.from(padHex(N_BI) + padHex(G_BI), 'hex'));
  const kBig = BigInt('0x' + kHex);

  // x = SHA256(padHex(salt) + SHA256(poolName + ":" + username + ":" + password))
  const usernamePassword = `${poolName}${username}:${password}`;
  const usernamePasswordHash = sha256Hex(Buffer.from(usernamePassword, 'utf8'));
  const xBig = BigInt('0x' + sha256Hex(Buffer.from(padHex(salt) + usernamePasswordHash, 'hex')));

  // S = (B - k * g^x)^(a + U * x) mod N
  const gModPowX = modPow(G_BI, xBig, N_BI);      // g^x mod N
  let base = serverB - kBig * gModPowX;
  base = ((base % N_BI) + N_BI) % N_BI;            // normalise to [0, N-1]
  const exponent = smallA + uBig * xBig;
  const sValue = modPow(base, exponent, N_BI);

  // HKDF (Cognito variant)
  const infoBitsBuffer = Buffer.concat([
    Buffer.from('Caldera Derived Key', 'utf8'),
    Buffer.from([0x01]),
  ]);
  const ikm = Buffer.from(padHex(sValue), 'hex');
  const saltHkdf = Buffer.from(padHex(uBig), 'hex');
  const prk = hmacSha256(saltHkdf, ikm);            // = HMAC-SHA256(salt, ikm)
  const okm = hmacSha256(prk, infoBitsBuffer);       // = HMAC-SHA256(prk, info)
  const hkdf = okm.slice(0, 16);                       // first 16 bytes

  return { hkdf, uHex };
}

/**
 * Compute the PASSWORD_CLAIM_SIGNATURE.
 * Mirrors the signature computation in authenticateUserDefaultAuth.
 *
 * @param {Buffer} hkdf          -- 16-byte HKDF from computeSrpValues
 * @param {string} secretBlockB64 -- base64 SECRET_BLOCK from Cognito challenge
 * @param {string} poolName      -- user pool name (e.g. "STn3OFCzh")
 * @param {string} username      -- USER_ID_FOR_SRP
 * @param {string} dateNow       -- formatted date string
 */
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

/** Format current UTC time as "ddd MMM D HH:mm:ss UTC YYYY". */
function getNowString() {
  const now = new Date();
  const weekDay = WEEK_NAMES[now.getUTCDay()];
  const month   = MONTH_NAMES[now.getUTCMonth()];
  const day     = now.getUTCDate();
  const hours   = String(now.getUTCHours()).padStart(2, '0');
  const minutes = String(now.getUTCMinutes()).padStart(2, '0');
  const seconds = String(now.getUTCSeconds()).padStart(2, '0');
  const year    = now.getUTCFullYear();
  return `${weekDay} ${month} ${day} ${hours}:${minutes}:${seconds} UTC ${year}`;
}

// ── AWS SigV4 (for raw-HTTPS fallback) ──────────────────────────────

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

  const canonicalRequest = [
    method,
    path,
    query || '',
    canonicalHeadersStr + '\n',
    signedHeaders,
    payloadHash,
  ].join('\n');

  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256Hex(Buffer.from(canonicalRequest)),
  ].join('\n');

  const kDate    = hmacSha256('AWS4' + secretAccessKey, dateStamp);
  const kRegion  = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, service);
  const kSigning = hmacSha256(kService, 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');

  return `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

// ── Cognito authentication ──────────────────────────────────────────

const POOL_NAME = USER_POOL_ID.split('_')[1]; // e.g. "STn3OFCzh"

/**
 * Execute the USER_SRP_AUTH flow with a Cognito Identity Provider client.
 *
 * @param {object} idp  -- CognitoIdentityProviderClient or a raw-HTTPS wrapper
 * @param {function(string, object): Promise<object>} initiate  -- send InitiateAuth
 * @param {function(string, object): Promise<object>} respond   -- send RespondToAuthChallenge
 * @returns {Promise<object>}  -- AuthenticationResult
 */
async function srpAuthFlow(initiate, respond) {
  // Step 1: generate client ephemeral key pair
  const smallA = generateRandomSmallA();
  const largeA = modPow(G_BI, smallA, N_BI); // A = g^a mod N

  // Step 2: InitiateAuth with USER_SRP_AUTH
  const initResp = await initiate('InitiateAuth', {
    AuthFlow: 'USER_SRP_AUTH',
    ClientId: CLIENT_ID,
    AuthParameters: {
      USERNAME: USERNAME,
      SRP_A: largeA.toString(16),
    },
  });

  // If auth succeeded immediately (rare for SRP), return
  if (initResp.AuthenticationResult || initResp.authenticationResult) {
    return initResp;
  }

  // Step 3: Handle challenge
  const challengeName = initResp.ChallengeName || initResp.challengeName;
  const challengeParams = initResp.ChallengeParameters || initResp.challengeParameters || {};
  const session = initResp.Session || initResp.session;

  if (challengeName !== 'PASSWORD_VERIFIER') {
    return {
      __challenge: challengeName,
      ChallengeParameters: challengeParams,
      Session: session,
      __message: `Unexpected challenge: ${challengeName}`,
    };
  }

  const serverB = BigInt('0x' + challengeParams.SRP_B);
  const salt    = BigInt('0x' + challengeParams.SALT);
  const secretBlock = challengeParams.SECRET_BLOCK;
  const userIdForSrp = challengeParams.USER_ID_FOR_SRP;

  // Step 4: Compute SRP proof
  const { hkdf } = computeSrpValues({
    smallA,
    largeA,
    serverB,
    salt,
    username: userIdForSrp,
    password: PASSWORD,
    poolName: POOL_NAME,
  });

  const dateNow = getNowString();
  const signature = computeSignature(hkdf, secretBlock, POOL_NAME, userIdForSrp, dateNow);

  // Step 5: RespondToAuthChallenge with PASSWORD_VERIFIER
  const challengeResp = await respond('RespondToAuthChallenge', {
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

  return challengeResp;
}

// -- SDK transport ---------------------------------------------------

async function sdkInitiateAuth(action, params) {
  // action is 'InitiateAuth' or 'RespondToAuthChallenge'
  const Command = action === 'InitiateAuth'
    ? InitiateAuthCommand
    : RespondToAuthChallengeCommand;
  const client = new CognitoIdentityProviderClient({
    region: REGION,
    credentials: ANON_CREDENTIALS,
  });
  const resp = await client.send(new Command(params));
  return resp;
}

// -- Raw HTTPS transport (with SigV4) --------------------------------

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
      accessKeyId: ANON_CREDENTIALS.accessKeyId,
      secretAccessKey: ANON_CREDENTIALS.secretAccessKey,
      date: amzDate,
      region: REGION,
      service: COGNITO_SERVICE,
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

/**
 * Full cognito auth: tries SDK first, falls back to raw HTTPS.
 * Both use the USER_SRP_AUTH flow.
 */
async function authenticateCognito() {
  if (sdkAvailable) {
    try {
      const result = await srpAuthFlow(
        (action, params) => sdkInitiateAuth(action, params),
        (action, params) => sdkInitiateAuth(action, params),
      );
      return { method: 'AWS SDK (USER_SRP_AUTH + SRP)', result };
    } catch (e) {
      console.warn(`[SDK] Cognito auth failed: ${e.message}. Falling back to raw HTTPS.`);
    }
  }
  // Raw HTTPS fallback
  const result = await srpAuthFlow(
    (action, params) => rawHttpsRequest(action, params),
    (action, params) => rawHttpsRequest(action, params),
  );
  return { method: 'Raw HTTPS (SigV4 + USER_SRP_AUTH + SRP)', result };
}

// ── Dashboard fetch ────────────────────────────────────────────────

function parseSetCookies(setCookieHeader) {
  if (!setCookieHeader) return [];
  const arr = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  return arr.map((raw) => {
    const parts = raw.split(';');
    const [pair, ...attrs] = parts.map((p) => p.trim());
    const eqIdx = pair.indexOf('=');
    const name = eqIdx >= 0 ? pair.substring(0, eqIdx) : pair;
    const value = eqIdx >= 0 ? pair.substring(eqIdx + 1) : '';
    return { name, value, attributes: attrs, raw: raw };
  });
}

async function fetchDashboard(tokens) {
  const cookiePairs = [];
  // Cognito token cookie names (Amplify / common patterns)
  if (tokens.IdToken)      cookiePairs.push({ name: 'id_token',      value: tokens.IdToken });
  if (tokens.AccessToken)  cookiePairs.push({ name: 'access_token',  value: tokens.AccessToken });
  if (tokens.RefreshToken) cookiePairs.push({ name: 'refresh_token', value: tokens.RefreshToken });
  if (tokens['id_token'])     cookiePairs.push({ name: 'idToken',     value: tokens['id_token'] });
  if (tokens['access_token']) cookiePairs.push({ name: 'accessToken',  value: tokens['access_token'] });
  if (tokens['refresh_token']) cookiePairs.push({ name: 'refreshToken', value: tokens['refresh_token'] });

  const cookieHeader = cookiePairs.map((c) => `${c.name}=${c.value}`).join('; ');
  const bearerToken  = tokens.AccessToken || tokens.access_token || tokens.IdToken || tokens.id_token || '';

  const headers = {
    'User-Agent':      BROWSER_UA,
    'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5',
    'Referer':         'https://clip.opus.pro/',
    'Connection':      'keep-alive',
    'Upgrade-Insecure-Requests': '1',
  };

  if (bearerToken) headers['Authorization'] = `Bearer ${bearerToken}`;
  if (cookieHeader) headers['Cookie'] = cookieHeader;

  console.log('      Request Cookie header: ' +
    (cookieHeader ? cookieHeader.substring(0, 80) + '...' : '(none)'));
  console.log('      Request Authorization: ' +
    (bearerToken ? 'Bearer ' + bearerToken.substring(0, 40) + '...' : '(none)'));

  const res = await fetch(DASHBOARD_URL, {
    method: 'GET',
    headers,
    redirect: 'follow',
  });

  const html = await res.text();
  const responseCookies = parseSetCookies(res.headers.get('set-cookie'));

  return {
    status: res.status,
    statusText: res.statusText,
    html,
    responseCookies,
    requestCookies: cookiePairs,
    allResponseHeaders: Object.fromEntries(res.headers.entries()),
  };
}

// ── Main ───────────────────────────────────────────────────────────

async function main() {
  console.log('=== Cognito Authentication + Dashboard Fetch ===\n');
  console.log(`  UserPoolId : ${USER_POOL_ID}`);
  console.log(`  ClientId   : ${CLIENT_ID}`);
  console.log(`  Username   : ${USERNAME}`);
  console.log(`  Region     : ${REGION}`);
  console.log(`  Dashboard  : ${DASHBOARD_URL}`);
  console.log(`  SDK avail  : ${sdkAvailable}`);

  // ── Step 1: Authenticate ──
  console.log('\n[1/4] Authenticating with Cognito (USER_SRP_AUTH)...');
  let authResult;
  try {
    const { method, result } = await authenticateCognito();
    console.log(`      Auth method: ${method}`);

    const ar = result.AuthenticationResult || result.authenticationResult || {};
    const tokens = {
      AccessToken:  ar.AccessToken  || ar.access_token,
      IdToken:      ar.IdToken      || ar.id_token,
      RefreshToken: ar.RefreshToken || ar.refresh_token,
      ExpiresIn:    ar.ExpiresIn    || ar.expires_in,
      TokenType:    ar.TokenType    || ar.token_type,
    };

    console.log('      Auth status: SUCCESS');
    console.log('\n      Tokens captured:');
    console.log('        AccessToken : ' +
      (tokens.AccessToken ? tokens.AccessToken.substring(0, 40) + '...' : '(none)'));
    console.log('        IdToken     : ' +
      (tokens.IdToken ? tokens.IdToken.substring(0, 40) + '...' : '(none)'));
    console.log('        RefreshToken: ' +
      (tokens.RefreshToken ? tokens.RefreshToken.substring(0, 40) + '...' : '(none)'));
    console.log('        ExpiresIn   : ' + (tokens.ExpiresIn || '(unspecified)'));
    console.log('        TokenType   : ' + (tokens.TokenType || '(unspecified)'));

    // Decode JWT payloads for verification
    if (tokens.IdToken) {
      try {
        const parts = tokens.IdToken.split('.');
        const payload = JSON.parse(
          Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString()
        );
        console.log('\n      IdToken JWT payload (key claims):');
        console.log('        iss  : ' + (payload.iss || '(none)'));
        console.log('        aud  : ' + (payload.aud || '(none)'));
        console.log('        sub  : ' + (payload.sub || '(none)'));
        console.log('        email: ' + (payload.email || '(none)'));
        console.log('        token_use: ' + (payload.token_use || '(none)'));
        console.log('        auth_time: ' + (payload.auth_time || '(none)'));
      } catch (e) {
        console.log('        (Could not decode IdToken JWT)');
      }
    }

    authResult = { success: true, tokens, result, method };
  } catch (e) {
    console.log('      Auth status: FAILED');
    console.log('      Error: ' + e.message);
    if (e.body) {
      console.log('      Response body: ' + JSON.stringify(e.body));
    }
    authResult = { success: false, error: e.message, method: 'N/A' };
  }

  // ── Step 2: Fetch dashboard ──
  console.log('\n[2/4] Fetching dashboard...');
  const tokens = authResult.success ? authResult.tokens : {};
  let dashboardResult;
  try {
    dashboardResult = await fetchDashboard(tokens);
    console.log(`      Dashboard HTTP status: ${dashboardResult.status} ${dashboardResult.statusText}`);
  } catch (e) {
    console.log('      Dashboard fetch FAILED: ' + e.message);
    dashboardResult = { status: 0, statusText: 'FAILED', error: e.message, html: null, responseCookies: [] };
  }

  // ── Step 3: Save HTML ──
  console.log('\n[3/4] Saving dashboard HTML...');
  if (dashboardResult.html) {
    fs.writeFileSync(OUTPUT_FILE, dashboardResult.html, 'utf8');
    console.log(`      Saved to: ${OUTPUT_FILE} (${dashboardResult.html.length} bytes)`);
  } else {
    console.log('      No HTML to save (fetch failed or opaque response)');
  }

  // ── Step 4: Cookie summary ──
  console.log('\n[4/4] Cookie summary...');
  console.log('      Request cookies sent (from Cognito tokens):');
  const reqCookies = dashboardResult.requestCookies || [];
  if (reqCookies.length === 0) {
    console.log('        (none — no tokens available)');
  } else {
    reqCookies.forEach((c) => {
      console.log('        ' + c.name + '=' + c.value.substring(0, 40) + '...');
    });
  }
  console.log('      Response cookies (Set-Cookie from dashboard):');
  const respCookies = dashboardResult.responseCookies || [];
  if (respCookies.length === 0) {
    console.log('        (none)');
  } else {
    respCookies.forEach((c) => {
      console.log('        ' + c.name + '=' + c.value.substring(0, 40) + '...');
    });
  }

  // ── Final summary ──
  console.log('\n=== Summary ===');
  console.log('  Auth method : ' + (authResult.method || 'N/A'));
  console.log('  Auth status : ' + (authResult.success ? 'SUCCESS' : 'FAILED'));
  console.log('  Dashboard   : ' + dashboardResult.status + ' ' + dashboardResult.statusText);
  if (dashboardResult.html) {
    console.log('  HTML file   : ' + OUTPUT_FILE + ' (' + dashboardResult.html.length + ' bytes)');
  }
  const respCount = dashboardResult.responseCookies ? dashboardResult.responseCookies.length : 0;
  console.log('  Cookies     : ' + respCount + ' received in response');
}

main().catch((e) => {
  console.error('Fatal error:', e);
  process.exit(1);
});
