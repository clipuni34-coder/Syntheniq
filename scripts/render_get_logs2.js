const https = require('https');

const API_KEY = 'rnd_tAQ4HS1i8Y9ArJ8YUONjdvkVnXn0';
const SERVICE_ID = 'srv-dbeq6ulg1s2s73dec9ag';
const DEPLOY_ID = 'dep-dbes9dm7bikc73bi46f0';
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
      res.on('end', () => resolve(data));
    }).on('error', () => resolve('(error)')).end();
  });
}

(async () => {
  console.log('=== Deploy Logs ===');
  console.log(await req(`/v1/services/${SERVICE_ID}/deploys/${DEPLOY_ID}/logs`));
  console.log('\n=== Service Status ===');
  console.log(await req(`/v1/services/${SERVICE_ID}`));
})();