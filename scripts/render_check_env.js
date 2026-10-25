const https = require('https');

const API_KEY = 'rnd_tAQ4HS1i8Y9ArJ8YUONjdvkVnXn0';
const SERVICE_ID = 'srv-dbeq6ulg1s2s73dec9ag';
const BASE = 'api.render.com';

const headers = {
  'Accept': 'application/json',
  'Authorization': `Bearer ${API_KEY}`
};

function req(path, method = 'GET') {
  return new Promise((resolve) => {
    const r = https.request({ hostname: BASE, path, method, headers }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    r.on('error', () => resolve({ status: 0, body: '(error)' }));
    r.end();
  });
}

(async () => {
  // Get service env vars
  const s = await req(`/v1/services/${SERVICE_ID}`);
  const svc = JSON.parse(s.body);
  console.log('Env vars:', JSON.stringify(svc.envVars || svc.serviceDetails?.envVars || 'none', null, 2));
  console.log('\nFull keys:', Object.keys(svc));
})();