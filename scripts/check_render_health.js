const https = require('https');

const SERVICE_URL = 'https://wingo-racer.onrender.com';

async function checkHealth() {
  return new Promise((resolve) => {
    https.get(SERVICE_URL + '/health', {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        console.log('Status:', res.statusCode);
        console.log('Headers:', JSON.stringify(res.headers, null, 2));
        console.log('Body:', data.substring(0, 500));
        resolve(res.statusCode === 200);
      });
    }).on('error', (e) => {
      console.log('Error:', e.message);
      resolve(false);
    });
  });
}

async function checkRoot() {
  return new Promise((resolve) => {
    https.get(SERVICE_URL + '/api/status', {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        console.log('\n=== /api/status ===');
        console.log('Status:', res.statusCode);
        try {
          const parsed = JSON.parse(data);
          console.log('Response:', JSON.stringify(parsed, null, 2));
        } catch {
          console.log('Body:', data.substring(0, 500));
        }
        resolve();
      });
    }).on('error', (e) => {
      console.log('Error:', e.message);
      resolve();
    });
  });
}

(async () => {
  console.log('=== Checking Render service health ===\n');
  await checkHealth();
  await checkRoot();
})();
