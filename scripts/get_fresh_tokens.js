#!/usr/bin/env node
/**
 * Clean Cognito SRP auth to get fresh tokens (no SigV4 Authorization header needed for unauthenticated APIs)
 */
'use strict';

const crypto = require('crypto');
const https = require('https');
const fs = require('fs');

const USER_POOL_ID = 'us-east-1_STn3OFCzh';
const CLIENT_ID = '4dh5iirgrp5ai5ba6sduu6mguq';
const USERNAME = 'aiwugod@gmail.com';
const PASSWORD = 'Drewziwugod@6';
const REGION = 'us-east-1';
const COGNITO_HOST = `cognito-idp.${REGION}.amazonaws.com`;

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

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex').padStart(64, '0');
}

function hmacSha256(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest();
}

function padHex(value) {
  let hex = value.toString(16);
  if (hex.length % 2 !== 0) hex = '0' + hex;
  if (hex.length > 0 && /[89abcdef]/.test(hex[0])) hex = '00' + hex;
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

function cognitoRequest(action, params) {
  return new Promise((resolve, reject) => {
    const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '').slice(0, 17) + 'Z';
    const body = JSON.stringify(params);
    const headers = {
      'Content-Type': 'application/x-amz-json-1.1',
      'X-Amz-Target': `AWSCognitoIdentityProviderService.${action}`,
      'X-Amz-Date': amzDate,
      'X-Amz-User-Agent': 'aws-cognito-identity-js/0.0.0',
    };
    const req = https.request({ hostname: COGNITO_HOST, path: '/', method: 'POST', headers }, (res) => {
      let data = '';
      res.on('data', c => data += c);
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
    req.setTimeout(15000);
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function getFreshTokens() {
  // Try refresh first
  let existingTokens = {};
  try {
    existingTokens = JSON.parse(fs.readFileSync('/tmp/viralclips_tokens.json', 'utf8'));
  } catch(e) {}

  if (existingTokens.refresh_token) {
    console.log('Trying refresh token...');
    try {
      const result = await cognitoRequest('InitiateAuth', {
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
      console.log(`Refresh failed: ${e.message}. Falling back to SRP.`);
    }
  }

  // Full SRP auth
  console.log('Performing full USER_SRP_AUTH flow...');
  const smallA = BigInt('0x' + crypto.randomBytes(128).toString('hex'));
  const largeA = modPow(G_BI, smallA, N_BI);

  const initResp = await cognitoRequest('InitiateAuth', {
    AuthFlow: 'USER_SRP_AUTH',
    ClientId: CLIENT_ID,
    AuthParameters: {
      USERNAME: USERNAME,
      SRP_A: largeA.toString(16),
    },
  });

  console.log('Init response:', JSON.stringify(initResp).substring(0, 500));
  const challengeName = initResp.ChallengeName;
  const challengeParams = initResp.ChallengeParameters;
  const session = initResp.Session;

  const serverB = BigInt('0x' + challengeParams.SRP_B);
  const salt = BigInt('0x' + challengeParams.SALT);
  const secretBlock = challengeParams.SECRET_BLOCK;
  const userIdForSrp = challengeParams.USER_ID_FOR_SRP;

  const { hkdf } = computeSrpValues({
    smallA, largeA, serverB, salt,
    username: userIdForSrp, password: PASSWORD,
  });

  const dateNow = getNowString();
  const signature = computeSignature(hkdf, secretBlock, POOL_NAME, userIdForSrp, dateNow);

  const challengeResp = await cognitoRequest('RespondToAuthChallenge', {
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

async function main() {
  try {
    const tokens = await getFreshTokens();
    console.log('\nTokens obtained:');
    console.log(`  access_token: ${tokens.access_token?.substring(0, 50)}...`);
    console.log(`  id_token: ${tokens.id_token?.substring(0, 50)}...`);

    const payload = JSON.parse(Buffer.from(tokens.access_token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
    console.log(`  access_token expires: ${new Date(payload.exp * 1000).toISOString()}`);

    fs.writeFileSync('/tmp/viralclips_tokens.json', JSON.stringify(tokens, null, 2));
    console.log('\nSaved fresh tokens to /tmp/viralclips_tokens.json');

    // Now try fb999 login via Cognito endpoints
    const idToken = tokens.id_token;
    console.log('\n=== Trying fb999 login via Cognito id_token ===');
    const cookie = `id_token=${idToken}; access_token=${tokens.access_token}`;

    const loginAttempts = [
      { name: 'LoginByCognito', path: '/api/webapi/LoginByCognito', body: { idToken, token: idToken, language: 0 } },
      { name: 'CognitoLogin', path: '/api/webapi/CognitoLogin', body: { idToken, token: idToken, language: 0 } },
    ];

    for (const attempt of loginAttempts) {
      try {
        console.log(`[${attempt.name}] POST ${attempt.path}`);
        const body = JSON.stringify(attempt.body);
        const req = https.request({
          hostname: 'fb999api.com', path: attempt.path, method: 'POST',
          headers: {
            'Content-Type': 'application/json;charset=UTF-8',
            'Accept': 'application/json, text/plain, */*',
            'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15',
            'Referer': 'https://fb999.com/',
            'Origin': 'https://fb999.com',
            'Cookie': cookie,
            'ar-origin': 'https://fb999.com',
          },
        }, (res) => {
          let data = '';
          res.on('data', c => data += c);
          res.on('end', () => {
            console.log(`  Status: ${res.statusCode}`);
            console.log(`  Body: ${data.substring(0, 600)}`);
            try {
              const json = JSON.parse(data);
              if (json.code === 0 && json.data && json.data.token) {
                console.log('  *** fb999 LOGIN SUCCESS! ***');
                fs.writeFileSync('/tmp/fb999_login_response.json', JSON.stringify(json, null, 2));
                console.log('  Saved to /tmp/fb999_login_response.json');
              } else {
                console.log('  Code:', json.code, 'Msg:', json.msg);
              }
            } catch(e) { console.log('  Parse error:', e.message); }
          });
        });
        req.setTimeout(15000);
        req.on('error', e => console.log('  Error:', e.message));
        req.write(body);
        req.end();
        // Wait for response
        await new Promise(r => setTimeout(r, 1000));
        req.destroy();
      } catch(e) {
        console.log(`  Error: ${e.message}`);
      }
    }
  } catch(e) {
    console.error('Cognito auth failed:', e.message);
    if (e.body) console.error('Response:', JSON.stringify(e.body));
  }
}

main();
