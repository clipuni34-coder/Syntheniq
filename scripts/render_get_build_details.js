const https = require('https');

const API_KEY = 'rnd_tAQ4HS1i8Y9ArJ8YUONjdvkVnXn0';
const SERVICE_ID = 'srv-dbeq6ulg1s2s73dec9ag';
const DEPLOY_ID = 'dep-dbercbbrjlhs738kv77g';
const BASE = 'api.render.com';

const headers = {
  'Accept': 'application/json',
  'Authorization': `Bearer ${API_KEY}`
};

// Try to get build logs
function getDeployDetails() {
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
          console.log('Full deploy object:', JSON.stringify(parsed, null, 2));
          
          // Check for build ID to get logs
          if (parsed.buildId || parsed.build) {
            console.log('\nBuild ID:', parsed.buildId || parsed.build?.id);
          }
          if (parsed.buildDetails) {
            console.log('\nBuild details:', parsed.buildDetails);
          }
        } catch(e) {
          console.log('Raw:', data);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.end();
  });
}

// Also get the latest builds
async function getBuilds() {
  console.log('\n=== Checking recent builds ===');
  const req = https.request({
    hostname: BASE,
    path: `/v1/services/${SERVICE_ID}/builds?limit=5`,
    method: 'GET',
    headers
  }, (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
      try {
        const parsed = JSON.parse(data);
        console.log('\nBuilds:', JSON.stringify(parsed, null, 2));
      } catch(e) {
        console.log('Raw:', data.substring(0, 1000));
      }
    });
  });
  req.on('error', (e) => console.error('Error:', e));
  req.end();
}

(async () => {
  await getDeployDetails();
  await getBuilds();
})();
