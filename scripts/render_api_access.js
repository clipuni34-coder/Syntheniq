const https = require('https');
const querystring = require('querystring');

// Credentials provided: clipuni34@gmail.com / Drewziwugod@6
// Render API approach: try to find service by name

// Step 1: We need the Render API key
// It's typically obtained from the dashboard
// But since we can't access the dashboard, we'll need to try the API directly

// Step 2: Try to list services (this won't work without auth, but let's try)

console.log('=== Attempting Render API Access ===\n');

// Render API for listing services
const options = {
  hostname: 'api.render.com',
  path: '/v1/services',
  method: 'GET',
  headers: {
    'Accept': 'application/json',
    'User-Agent': 'Mozilla/5.0'
  }
};

const req = https.request(options, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    console.log('Status:', res.statusCode);
    console.log('Response:', data.substring(0, 500));
  });
});

req.on('error', e => console.error('Error:', e.message));
req.end();

// Alternative: Try Render CLI
console.log('\n=== Render CLI Alternative ===');
console.log('We can try installing render-cli and using it');
console.log('npm install -g @render-oss/cli');
console.log('render login --email clipuni34@gmail.com --password "Drewziwugod@6"');
console.log('render deploy --service wingo-racer --clear-cache');
