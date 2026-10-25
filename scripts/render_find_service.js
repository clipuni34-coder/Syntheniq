const https = require('https');

const API_KEY = 'rnd_tAQ4HS1i8Y9ArJ8YUONjdvkVnXn0';
const BASE = 'api.render.com';

const headers = {
  'Accept': 'application/json',
  'User-Agent': 'Mozilla/5.0',
  'Authorization': `Bearer ${API_KEY}`
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
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function main() {
  console.log('=== Finding wingo-racer service ===\n');
  
  // List all services
  const services = await apiRequest('/v1/services');
  console.log('Services status:', services.status);
  
  if (services.status === 200 && services.parsed) {
    console.log('Response:', JSON.stringify(services.parsed, null, 2));
  } else {
    console.log('Raw:', services.body.substring(0, 500));
  }
}

main().catch(e => console.error('Error:', e));
