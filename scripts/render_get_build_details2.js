const https = require('https');

const API_KEY = 'rnd_tAQ4HS1i8Y9ArJ8YUONjdvkVnXn0';
const SERVICE_ID = 'srv-dbeq6ulg1s2s73dec9ag';
const BASE = 'api.render.com';

const headers = {
  'Accept': 'application/json',
  'Authorization': `Bearer ${API_KEY}`
};

function req(path) {
  return new Promise((resolve) => {
    https.request({ hostname: BASE, path, method: 'GET', headers }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    }).on('error', () => resolve({ status: 0, body: '(error)' })).end();
  });
}

(async () => {
  // Get latest deploy
  const d = await req(`/v1/services/${SERVICE_ID}/deploys?limit=3`);
  console.log('Deploys:', d.body.substring(0, 3000));
})();