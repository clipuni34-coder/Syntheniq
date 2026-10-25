const https = require('https');

const API_KEY = 'rnd_tAQ4HS1i8Y9ArJ8YUONjdvkVnXn0';
const SERVICE_ID = 'srv-dbeq6ulg1s2s73dec9ag';
const DEPLOY_ID = 'dep-dbercbbrjlhs738kv77g';
const BASE = 'api.render.com';

const headers = {
  'Accept': 'application/json',
  'Authorization': `Bearer ${API_KEY}`
};

function checkStatus() {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: BASE,
      path: `/v1/services/${SERVICE_ID}/deploys/${DEPLOY_ID}`,
      method: 'GET',
      headers
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const status = parsed.status || 'unknown';
          const build = parsed.build ? `build:${parsed.build.status}` : '';
          console.log(`[${new Date().toISOString()}] Status: ${status} ${build}`);
          
          if (status === 'succeeded' || status === 'ready') {
            console.log('\n✅ DEPLOY SUCCEEDED');
            console.log('Commit:', parsed.commitId?.substring(0, 7));
            console.log('URL:', parsed.url || 'https://wingo-racer.onrender.com');
            resolve('done');
          } else if (status === 'build_failed' || status === 'update_failed' || status === 'failed' || status === 'canceled') {
            console.log('\n❌ DEPLOY FAILED');
            console.log('Status:', status);
            if (parsed.build) {
              console.log('Build error:', parsed.build.errorMessage);
            }
            console.log('Full:', JSON.stringify(parsed, null, 2).substring(0, 1000));
            resolve('done');
          } else {
            resolve('continue');
          }
        } catch(e) {
          console.log('Parse error, raw:', data.substring(0, 200));
          resolve('continue');
        }
      });
    });
    req.on('error', () => resolve('continue'));
    req.end();
  });
}

async function monitor() {
  for (let i = 0; i < 40; i++) {
    const result = await checkStatus();
    if (result === 'done') { process.exit(0); }
    await new Promise(r => setTimeout(r, 3000));
  }
  console.log('\nTimeout - checking final status');
  const final = await checkStatus();
  process.exit(0);
}

monitor();
