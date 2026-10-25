const https = require('https');

const API_KEY = 'rnd_tAQ4HS1i8Y9ArJ8YUONjdvkVnXn0';
const SERVICE_ID = 'srv-dbeq6ulg1s2s73dec9ag';
const BASE = 'api.render.com';

const headers = {
  'Accept': 'application/json',
  'User-Agent': 'Mozilla/5.0',
  'Authorization': `Bearer ${API_KEY}`,
  'Content-Type': 'application/json'
};

function apiRequest(path, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: BASE,
      path,
      method,
      headers
    };
    
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: data, parsed: JSON.parse(data) });
        } catch(e) {
          resolve({ status: res.statusCode, body: data, parsed: null });
        }
      });
    });
    req.on('error', reject);
    if (body) {
      const bodyStr = JSON.stringify(body);
      req.setHeader('Content-Length', Buffer.byteLength(bodyStr));
      req.write(bodyStr);
    }
    req.end();
  });
}

async function main() {
  console.log('=== Step 1: List current deploys ===\n');
  const deploys = await apiRequest(`/v1/services/${SERVICE_ID}/deploys`);
  console.log('Deploy list status:', deploys.status);
  if (deploys.parsed) {
    console.log('Recent deploys:');
    const list = deploys.parsed.deploys || deploys.parsed.list || deploys.parsed;
    if (Array.isArray(list)) {
      list.slice(0, 5).forEach(d => {
        console.log(`  - ${d.id || d.deployId} | ${d.status} | commit: ${(d.commitId || d.commit || '').substring(0, 7)} | createdAt: ${d.createdAt}`);
      });
    }
    console.log('Full:', JSON.stringify(deploys.parsed, null, 2).substring(0, 2000));
  }

  console.log('\n=== Step 2: Trigger deploy with cache clear ===\n');
  const deploy = await apiRequest(`/v1/services/${SERVICE_ID}/deploys`, 'POST', {
    clearCache: 'clear'
  });
  console.log('Deploy trigger status:', deploy.status);
  if (deploy.parsed) {
    console.log('Deploy response:', JSON.stringify(deploy.parsed, null, 2));
  } else {
    console.log('Raw:', deploy.body);
  }

  console.log('\n=== Step 3: Trigger fresh build ===\n');
  // Also trigger a build from the specific commit
  const latestCommit = deploy.parsed?.commitId || '91fb3a6';
  console.log('Latest commit from deploy response:', latestCommit);

  console.log('\n=== Step 4: Check service status ===\n');
  const service = await apiRequest(`/v1/services/${SERVICE_ID}`);
  console.log('Service status:', service.status);
  if (service.parsed) {
    console.log('Service:', JSON.stringify(service.parsed.serviceDetails || service.parsed, null, 2).substring(0, 1000));
  }
}

main().catch(e => console.error('Error:', e));
