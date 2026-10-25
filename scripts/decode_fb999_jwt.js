const fs = require('fs');
const path = require('path');

const LOGIN_FILE = path.resolve(__dirname, '../findings/fb999_login_response.json');

function decodeJwt(jwt) {
  const parts = String(jwt).split('.');
  if (parts.length < 2) return null;
  const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(Buffer.from(b64, 'base64').toString());
}

function extractTokenFromUrl(url) {
  const u = new URL(url);
  return u.searchParams.get('Token');
}

function fmtExp(v) {
  if (v == null) return '(none)';
  const t = typeof v === 'string' ? parseInt(v, 10) : v;
  if (Number.isNaN(t)) return String(v);
  return `${new Date(t * 1000).toISOString()}  (exp=${t})`;
}

function fmtClaim(label, value) {
  console.log(`  ${label}: ${value == null ? '(none)' : JSON.stringify(value)}`);
}

function dumpToken(name, token) {
  console.log('\n' + '='.repeat(70));
  console.log(`TOKEN: ${name}`);
  console.log('='.repeat(70));
  if (!token) {
    console.log('  (token not found)');
    return;
  }
  console.log(`  raw (first 60 chars): ${token.substring(0, 60)}...`);
  let payload;
  try {
    payload = decodeJwt(token);
  } catch (e) {
    console.log('  Could not decode JWT:', e.message);
    return;
  }
  console.log('  --- FULL PAYLOAD ---');
  console.log('  ' + JSON.stringify(payload, null, 2).split('\n').join('\n  '));
  console.log('  --- KEY CLAIMS ---');
  fmtClaim('subject/userId', payload.sub || payload.userId || payload.UserId);
  console.log(`  expiration: ${fmtExp(payload.exp)}`);
  fmtClaim('issuer (iss)', payload.iss);
  fmtClaim('audience (aud)', payload.aud);
  fmtClaim('role claims (role/roles/scope/scopes)', payload.role || payload.roles || payload.scope || payload.scopes || payload['http://schemas.microsoft.com/ws/2008/06/identity/claims/role']);
  fmtClaim('token_use', payload.token_use || payload['token_use']);
  fmtClaim('custom claims', payload);
  const expired = payload.exp && (typeof payload.exp === 'string' ? parseInt(payload.exp, 10) : payload.exp) * 1000 < Date.now();
  if (payload.exp) {
    console.log(`  status: ${expired ? 'EXPIRED' : 'NOT YET EXPIRED (relative to local clock)'}`);
  }
}

const raw = fs.readFileSync(LOGIN_FILE, 'utf8');
const login = JSON.parse(raw);
const data = login.data || login;

const mainToken = data.token;
const wsToken = extractTokenFromUrl(data.webSocketUrl);
const lotteryToken = extractTokenFromUrl(data.lotteryLoginUrl);

dumpToken('1. Main access token (login.data.token)', mainToken);
dumpToken('2. WebSocket token (webSocketUrl ?Token=)', wsToken);
dumpToken('3. Lottery login URL token (lotteryLoginUrl ?Token=)', lotteryToken);
