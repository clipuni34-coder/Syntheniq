const https = require('https');

// Render API key can be found at https://dashboard.render.com/account/api-keys
// Service ID is in the URL: https://dashboard.render.com/web-services/<SERVICE_ID>

// Let's try to list services via Render API (will fail without auth)
const options = {
  hostname: 'api.render.com',
  path: '/v1/services',
  method: 'GET',
  headers: {
    'Accept': 'application/json',
    'User-Agent': 'Mozilla/5.0',
    'Authorization': 'Bearer RENDER_API_KEY'
  }
};

console.log('=== Render API Options ===\n');
console.log('1. Get API Key: https://dashboard.render.com/account/api-keys');
console.log('2. Find Service ID: https://dashboard.render.com/web-services/<SERVICE_ID>');
console.log('3. Trigger deploy with cache clear: POST https://api.render.com/v1/services/<SERVICE_ID>/deploys');
console.log('   Body: { "clearCache": "clear" }');

console.log('\n=== Trying Render login to get session ===\n');

// Step 1: Try to get CSRF token from Render login page
const loginOptions = {
  hostname: 'dashboard.render.com',
  path: '/login',
  method: 'GET',
  headers: {
    'Accept': 'text/html',
    'User-Agent': 'Mozilla/5.0'
  }
};

const req = https.request(loginOptions, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    console.log('Login page status:', res.statusCode);
    
    // Look for CSRF token
    const csrfMatch = data.match(/csrf-token["']?\s*content=["']([^"']+)["']/i);
    const csrfMeta = data.match(/csrf[_-]token["']?\s*content=["']([^"']+)["']/i);
    
    const cookies = res.headers['set-cookie'];
    console.log('Cookies:', cookies);
    console.log('CSRF:', csrfMeta || csrfMatch);
    
    // Look for service ID patterns in the HTML
    const serviceIds = [...data.matchAll(/web-services\/([a-f0-9-]+)/gi)];
    console.log('\nService IDs found:', serviceIds.map(m => m[1]));
  });
});

req.on('error', e => console.error('Error:', e.message));
req.end();
