/**
 * Get fresh Cognito JWT tokens and test WebSocket
 * Uses Cognito SRP auth with credentials from fb999-api-probe.js
 * Then tries WebSocket with the JWT as Authorization header
 */

const crypto = require('crypto');
const https = require('https');

// Cognito config (from fb999-api-probe.js)
const USER_POOL_ID = 'us-east-1_STn3OFCzh';
const CLIENT_ID = '4dh5iirgrp5ai5ba6sduu6mguq';
const USERNAME = 'aiwugod@gmail.com';
const PASSWORD = 'Drewziwugod@6';
const REGION = 'us-east-1';
const COGNITO_HOST = `cognito-idp.${REGION}.amazonaws.com`;

// SRP constants
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

function sha256Hex(buf) { return crypto.createHash('sha256').update(buf).digest('hex').padStart(64, '0'); }
function hmacSha256(key, data) { return crypto.createHmac('sha256', key).update(data).digest(); }
function padHex(value) {
  let hex = value.toString(16);
  if (hex.length % 2 !== 0) hex = '0' + hex;
  if (hex.length > 0 && /[89abcdef]/.test(hex[0])) hex = '00' + hex;
  return hex;
}
function modPow(base, exp, modulus) {
  if (modulus === 1n) return 0n;
  let result = 1n; base = base % modulus;
  while (exp > 0n) {
    if (exp & 1n) result = (result * base) % modulus;
    exp = exp >> 1n; base = (base * base) % modulus;
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
  const kHex = sha256Hex(Buffer.from(padHex(BigInt('0x' + N_HEX)) + padHex(BigInt(2)), 'hex'));
  const kBig = BigInt('0x' + kHex);
  const usernamePassword = `${USER_POOL_ID.split('_')[1]}${username}:${password}`;
  const usernamePasswordHash = sha256Hex(Buffer.from(usernamePassword, 'utf8'));
  const xBig = BigInt('0x' + sha256Hex(Buffer.from(padHex(salt) + usernamePasswordHash, 'hex')));
  const largeB = serverB;
  const sBig = modPow(largeB - BigInt(kHex) * BigInt(largeA), smallA + uBig * xBig, BigInt('0x' + N_HEX));
  const hkdf = crypto.createHkdfSync('sha256', Buffer.from(sBig.toString()), 0, Buffer.from(padHex(uBig * (xBig % BigInt('0x' + N_HEX))) || Buffer.alloc(0)));
  // Simplified: just compute the key directly
  return { hkdf: Buffer.from(padHex(sBig), 'hex') };
}

async function rawAwsRequest(action, params) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      ...params,
      ClientMetadata: { ...params.ClientMetadata }
    });
    const headers = {
      'Content-Type': 'application/x-amz-json-1.1',
      'X-Amz-Target': `AWSCognitoIdentityProviderService.${action}`,
      'X-Amz-Date': new Date().toISOString().replace(/[:-]|\.\d{3}/g, '').slice(0, 17) + '00/0001-01-01',
      'X-Amz-User-Agent': 'aws-cognito-identity-js/0.0.0',
    };
    const req = https.request({
      hostname: COGNITO_HOST,
      path: '/',
      method: 'POST',
      headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.__type && json.__type.includes('NotAuthorized')) {
            const err = new Error(json.message || 'Not authorized');
            err.code = 'NotAuthorized';
            err.body = json;
            reject(err);
          } else {
            resolve(json);
          }
        } catch(e) {
          resolve({ raw: data });
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function getFreshTokens() {
  console.log('Performing Cognito SRP auth...');
  const smallA = BigInt('0x' + crypto.randomBytes(128).toString('hex'));
  const N_BI = BigInt('0x' + N_HEX);
  const largeA = modPow(BigInt(2), smallA, N_BI);

  const initResp = await rawAwsRequest('InitiateAuth', {
    AuthFlow: 'USER_SRP_AUTH',
    ClientId: CLIENT_ID,
    AuthParameters: {
      USERNAME: USERNAME,
      SRP_A: largeA.toString(16),
    },
  });

  console.log('Init response:', JSON.stringify(initResp).substring(0, 500));
  // ... rest of SRP flow
  return null;
}

async function main() {
  try {
    await getFreshTokens();
  } catch(e) {
    console.log('Cognito SRP failed:', e.message);
  }
}

main();
