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
  console.log('=== Triggering fresh deploy with cache clear ===\n');

  const body = JSON.stringify({ clearCache: 'clear' });
  
  const req = https.request({
    hostname: BASE,
    path: `/v1/services/${SERVICE_ID}/deploys`,
    method: 'POST',
    headers: {
      ...headers,
      'Content-Length': Buffer.byteLength(body)
    }
  }, (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
      try {
        const parsed = JSON.parse(data);
        console.log('Status:', res.statusCode);
        console.log('Deploy response:', JSON.stringify(parsed, null, 2));
        
        if (parsed.id || parsed.deployId) {
          const deployId = parsed.id || parsed.deployId;
          console.log('\nNew Deploy ID:', deployId);
          console.log('Commit:', parsed.commitId);
          console.log('Status:', parsed.status);
        }
      } catch(e) {
        console.log('Raw:', data);
      }
    });
  });

  req.on('error', e => console.error('Error:', e.message));
  req.write(body);
  req.end();
}

triggerDeploy();
