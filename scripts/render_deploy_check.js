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
    const body = JSON.stringify({ clearCache: 'clear' });
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
          console.log('Deploy ID:', parsed.id || parsed.deployId);
          resolve(parsed.id || parsed.deployId);
        } catch(e) {
          console.log('Raw:', data);
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
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
            console.log(`[${new Date().toISOString()}] Status: ${parsed.status || 'unknown'}${parsed.build ? ' build:' + parsed.build.status : ''}`);
            if (['succeeded','ready','build_failed','update_failed','failed','canceled'].includes(parsed.status)) {
              console.log('\n=== FINAL: ' + parsed.status + ' ===');
              if (parsed.status === 'succeeded') {
                console.log('✅ DEPLOY SUCCEEDED');
                // Quick health check
                setTimeout(() => {
                  https.get('https://wingo-racer.onrender.com/', res => {
                    let data = '';
                    res.on('data', c => data += c);
                    res.on('end', () => {
                      console.log('\nRoot endpoint check:');
                      console.log('Status:', res.statusCode);
                      console.log('Body:', data.substring(0, 300));
                    });
                  }).on('error', e => console.log('Health check error:', e.message));
                }, 10000);
              }
              resolve('done');
            } else { resolve('continue'); }
          } catch(e) { resolve('continue'); }
        });
      });
      req.on('error', () => resolve('continue'));
      req.end();
    });
    if (status === 'done') { setTimeout(() => process.exit(0), 15000); return; }
    await new Promise(r => setTimeout(r, 3000));
  }
  console.log('Timeout');
  process.exit(0);
}

(async () => {
  const deployId = await triggerDeploy();
  if (deployId) await monitor(deployId);
})();
