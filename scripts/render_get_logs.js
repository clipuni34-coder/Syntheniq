const https = require('https');

const API_KEY = 'rnd_tAQ4HS1i8Y9ArJ8YUONjdvkVnXn0';
const SERVICE_ID = 'srv-dbeq6ulg1s2s73dec9ag';
const DEPLOY_ID = 'dep-dber786bs3rs73c9n4sg';
const BASE = 'api.render.com';

const headers = {
  'Accept': 'application/json',
  'Authorization': `Bearer ${API_KEY}`
};

async function getLogs() {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: BASE,
      path: `/v1/services/${SERVICE_ID}/deploys/${DEPLOY_ID}/logs`,
      method: 'GET',
      headers
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        console.log('Log status:', res.statusCode);
        resolve(data);
      });
    });
    req.on('error', () => resolve('(error fetching logs)'));
    req.end();
  });
}

async function getEvents() {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: BASE,
      path: `/v1/services/${SERVICE_ID}/events?type=deploy&limit=10`,
      method: 'GET',
      headers
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        console.log('Events status:', res.statusCode);
        resolve(data);
      });
    });
    req.on('error', () => resolve('(error fetching events)'));
    req.end();
  });
}

async function getStatus() {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: BASE,
      path: `/v1/services/${SERVICE_ID}`,
      method: 'GET',
      headers
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', () => resolve('(error)'));
    req.end();
  });
}

(async () => {
  console.log('=== Deploy Logs ===');
  const logs = await getLogs();
  console.log(logs.substring(0, 3000));

  console.log('\n=== Service Status ===');
  const status = await getStatus();
  console.log(status.substring(0, 2000));

  console.log('\n=== Recent Events ===');
  const events = await getEvents();
  console.log(events.substring(0, 2000));
})();
