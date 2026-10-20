/**
 * Comprehensive token finder for fb999.com
 * Checks ALL possible storage locations and key names
 */

const https = require('https');
const fs = require('fs');

// Read the tokens file we generated earlier via Cognito
let cognitoTokens = null;
try {
  cognitoTokens = JSON.parse(fs.readFileSync('/tmp/viralclips_tokens.json', 'utf8'));
  console.log('Cognito tokens available:', Object.keys(cognitoTokens));
} catch(e) {
  console.log('No Cognito tokens file');
}

// Function to check all storage locations
console.log('=== Token Finder for fb999 ===\n');

// Method 1: Check if /tmp/fb999_login_response.json exists
console.log('1. Checking /tmp/fb999_login_response.json...');
try {
  const loginData = JSON.parse(fs.readFileSync('/tmp/fb999_login_response.json', 'utf8'));
  if (loginData.data?.token) {
    console.log('  ✓ Found login response JWT!');
    console.log('  Token:', loginData.data.token.substring(0, 60) + '...');
    console.log('  Saving to /tmp/jwt_token.txt');
    fs.writeFileSync('/tmp/jwt_token.txt', loginData.data.token);
  }
} catch(e) {
  console.log('  ✗ Not found');
}

// Method 2: Use Cognito token for API access
console.log('\n2. Trying Cognito token for authenticated API...');

const ACCESS_TOKEN = cognitoTokens?.access_token;

async function testAPI(token, label) {
  // Test GetLastFiveIssueNumberResult with TypeId=30
  const crypto = require('crypto');
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

  return new Promise((resolve) => {
    const body = JSON.stringify(signParams({ TypeId: 30 }));
    const req = https.request({
      hostname: 'fb999api.com',
      path: '/api/webapi/GetLastFiveIssueNumberResult',
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        console.log(`  ${label} → API: ${res.status}`);
        console.log(`  Response: ${data.substring(0, 200)}`);
        
        if (res.status === 200) {
          try {
            const json = JSON.parse(data);
            if (json.code === 0 && json.data) {
              console.log('  ✓ API ACCESS WORKING!');
              if (json.data.number) {
                const nums = typeof json.data.number === 'string' ? json.data.number.split(',') : json.data.number;
                console.log('  Last 5 results:', nums.join(', '));
              }
              fs.writeFileSync('/tmp/working_token.txt', token);
              fs.writeFileSync('/tmp/api_results.json', JSON.stringify(json.data, null, 2));
            } else {
              console.log('  Code:', json.code, 'Msg:', json.msg);
            }
          } catch(e) { console.log('  Parse error:', e.message); }
        }
        resolve();
      });
    });
    req.on('error', (e) => { console.log('  Error:', e.message); resolve(); });
    req.write(body);
    req.end();
  });
}

// Test with Cognito token
if (ACCESS_TOKEN) {
  console.log('  Testing with Cognito access_token...');
  testAPI(ACCESS_TOKEN, 'Cognito access_token').then(() => {
    // Also test with id_token
    if (cognitoTokens.id_token && cognitoTokens.id_token !== ACCESS_TOKEN) {
      console.log('\n  Testing with Cognito id_token...');
      return testAPI(cognitoTokens.id_token, 'Cognito id_token');
    }
  }).then(() => {
    console.log('\n=== Summary ===');
    console.log('If API access worked, token saved to /tmp/working_token.txt');
    console.log('API results saved to /tmp/api_results.json');
    console.log('\nNext step: Use this token with winGoLive.js for real-time streaming');
  });
} else {
  console.log('  No Cognito tokens available');
  console.log('\n  Please provide the JWT token from:');
  console.log('  1. Chrome DevTools → Application → Local Storage → ar_token');
  console.log('  2. Or Console: localStorage.getItem("ar_token")');
}
