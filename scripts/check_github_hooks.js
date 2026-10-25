const https = require('https');

console.log('=== Trying to access Render dashboard API ===\n');

// Render uses SSO/OAuth - let's try to find the service ID different ways

// The service might be accessible at:
// https://dashboard.onrender.com/web-services/<id>
// or
// https://dashboard.render.com/web-services/<id>

// Let's try fetching the wingo-racer service by name
// Render's API: GET /v1/services?name=wingo-racer

// First, let's try a different approach - check if there's a deploy hook
// or if we can trigger a deploy via webhook

// Actually, let me check if there's a GitHub webhook configured
const options = {
  hostname: 'api.github.com',
  path: '/repos/clipuni34-coder/Syntheniq/hooks',
  method: 'GET',
  headers: {
    'Accept': 'application/vnd.github.v3+json',
    'User-Agent': 'node.js'
  }
};

const req = https.request(options, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    console.log('GitHub hooks status:', res.statusCode);
    try {
      const hooks = JSON.parse(data);
      if (Array.isArray(hooks)) {
        hooks.forEach(h => {
          console.log(`Hook: ${h.name} - ${h.config?.url} - events: ${h.events?.join(', ')}`);
        });
      } else {
        console.log('Response:', data.substring(0, 500));
      }
    } catch(e) {
      console.log('Parse error:', e.message);
      console.log('Raw:', data.substring(0, 500));
    }
  });
});

req.on('error', e => console.error('Error:', e.message));
req.end();
