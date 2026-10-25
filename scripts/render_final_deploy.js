const https = require('https');

const API_KEY = 'rnd_tAQ4HS1i8Y9ArJ8YUONjdvkVnXn0';
const SERVICE_ID = 'srv-dbeq6ulg1s2s73dec9ag';
const BASE = 'api.render.com';

const headers = {
  'Accept': 'application/json',
  'Authorization': `Bearer ${API_KEY}`,
  'Content-Type': 'application/json'
};

async function triggerDeploy() {
  return new Promise((resolve) => {
    const body = JSON.stringify({ clearCache: 'clear', commitId: 'a0acc33' });
    const req = https.request({
      hostname: BASE,
      path: `/v1/services/${SERVICE_ID}/deploys`,
      method: 'POST',
      headers: { ...headers, 'Content-Length': Buffer.byteLength(body) }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          console.log('Deploy triggered:', JSON.stringify(parsed, null, 2));
          resolve(parsed.id || parsed.deployId);
        } catch(e) {
          console.log('Raw:', data);
          resolve(null);
        }
      });
    });
    req.on('error', e => { console.error(e); resolve(null); });
    req.write(body);
    req.end();
  });
}

async function monitor(deployId) {
  for (let i = 0; i < 50; i++) {
    const status = await new Promise((resolve) => {
      const req = https.request({
        hostname: BASE,
        path: `/v1/services/${SERVICE_ID}/deploys/${deployId}`,
        method: 'GET',
        headers
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            const s = parsed.status || 'unknown';
            const build = parsed.build ? ` build:${parsed.build.status}` : '';
            console.log(`[${new Date(new Date().getTime()-5*60*1000).toISOString()}] Deploy: ${s}${build}${parsed.commitId ? ` (${parsed.commitId.substring(0,7)})` : ''}`);
            
            if (s === 'succeeded' || s === 'ready' || s === 'build_failed' || s === 'update_failed' || s === 'failed') {
              console.log('\n=== TERMINAL STATUS: ' + s + ' ===');
              if (s === 'succeeded') {
                console.log('✅ DEPLOY SUCCEEDED');
              } else {
                console.log('❌ FAILED');
                if (parsed.build) {
                  console.log('Build error:', parsed.build.errorMessage);
                }
              }
              resolve('done');
              return;
            }
            resolve('continue');
          } catch(e) {
            console.log('Parse error');
            resolve('continue');
          }
        });
      });
      req.on('error', () => resolve('continue'));
      req.end();
    });
    
    if (status === 'done') process.exit(0);
    await new Promise(r => setTimeout(r, 3000));
  }
  console.log('Timeout');
  process.exit(0);
}

(async () => {
  const deployId = await triggerDeploy();
  if (deployId) {
    await monitor(deployId);
  }
})();
