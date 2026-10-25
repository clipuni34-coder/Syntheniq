const https = require('https');

const API_KEY = 'rnd_tAQ4HS1i8Y9ArJ8YUONjdvkVnXn0';
const SERVICE_ID = 'srv-dbeq6ulg1s2s73dec9ag';
const DEPLOY_ID = 'dep-dbercbbrjlhs738kv77g';
const BASE = 'api.render.com';

const headers = {
  'Accept': 'application/json',
  'Authorization': `Bearer ${API_KEY}`
};

function apiRequest(path, description) {
  return new Promise((resolve, reject) => {
    console.log(`\n>>> ${description}: ${path}`);
    const req = https.request({
      hostname: BASE,
      path,
      method: 'GET',
      headers
    }, (res) => {
      console.log(`    Status: ${res.statusCode}`);
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        console.log(`    Response length: ${data.length}`);
        try {
          resolve(JSON.parse(data));
        } catch(e) {
          resolve({ raw: data, parseError: true });
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

(async () => {
  // Try to get the full deploys list
  let cursor = null;
  const allDeploys = [];

  while (true) {
    let path = `/v1/services/${SERVICE_ID}/deploys?limit=50`;
    if (cursor) path += `&cursor=${cursor}`;
    const deploys = await apiRequest(path, 'Deploys list (page)');
    if (Array.isArray(deploys)) {
      allDeploys.push(...deploys);
      console.log(`    Got ${deploys.length} deploys`);
      
      // Check if there's a cursor for more results
      if (deploys.length === 50) {
        // Render uses cursor-based pagination
        console.log('    May have more deploys, continuing...');
        // Check the last deploy for a cursor (Render returns cursor differently)
        // The deploys array might have cursor in response headers or as a property
      } else {
        break;
      }
    } else {
      console.log('    Unexpected response');
      break;
    }
    if (!cursor) break; // safety
  }

  console.log(`\n=== All Deploys (${allDeploys.length}) ===`);
  allDeploys.forEach(d => {
    console.log(JSON.stringify(d));
  });

  // Try service logs (recent)
  console.log('\n>>> Service logs');
  const logs = await apiRequest(`/v1/services/${SERVICE_ID}/logs?limit=1000`, 'Service logs');

  // Try events
  console.log('\n>>> Events');
  const events = await apiRequest(`/v1/services/${SERVICE_ID}/events?type=deploy&limit=20`, 'Events');
  console.log(`    Events:`, JSON.stringify(events).substring(0, 3000));
})();
