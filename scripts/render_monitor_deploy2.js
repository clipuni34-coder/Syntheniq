const https = require('https');

const API_KEY = 'rnd_tAQ4HS1i8Y9ArJ8YUONjdvkVnXn0';
const SERVICE_ID = 'srv-dbeq6ulg1s2s73dec9ag';
const DEPLOY_ID = 'dep-dbes9dm7bikc73bi46f0';
const BASE = 'api.render.com';

const headers = {
  'Accept': 'application/json',
  'Authorization': `Bearer ${API_KEY}`
};

function checkDeploy() {
  return new Promise((resolve, reject) => {
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
          console.log('Deploy status:', parsed.status);
          console.log('Commit:', parsed.commitId?.substring(0, 7));
          console.log('UpdatedAt:', parsed.updatedAt);
          console.log('FinishedAt:', parsed.finishedAt);
          if (parsed.build) {
            console.log('Build status:', parsed.build.status);
            if (parsed.build.errorMessage) {
              console.log('BUILD ERROR:', parsed.build.errorMessage);
            }
          }
          resolve(parsed);
        } catch(e) {
          console.log('Raw:', data.substring(0, 1000));
          resolve(null);
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function monitor() {
  console.log(`Monitoring deploy ${DEPLOY_ID}...\n`);

  for (let i = 0; i < 30; i++) {
    const deploy = await checkDeploy();

    if (deploy && (deploy.status === 'succeeded' || deploy.status === 'build_failed' || deploy.status === 'failed' || deploy.status === 'ready')) {
      console.log('\n=== FINAL STATUS ===');
      console.log('Deploy status:', deploy.status);
      if (deploy.build) {
        console.log('Build status:', deploy.build.status);
        if (deploy.build.errorMessage) {
          console.log('Error:', deploy.build.errorMessage);
        }
        if (deploy.build.logsUrl || deploy.build.logUrl) {
          console.log('Logs URL:', deploy.build.logsUrl || deploy.build.logUrl);
        }
      }
      break;
    }

    console.log(`[${new Date().toISOString()}] Still building... waiting 5s`);
    await new Promise(r => setTimeout(r, 5000));
  }
}

monitor().catch(e => console.error('Error:', e));