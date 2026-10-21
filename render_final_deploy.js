const puppeteer = require('puppeteer');
const fs = require('fs');

const RENDER_EMAIL = 'clipuni34@gmail.com';
const RENDER_PASSWORD = 'Drewziwugod@6';
const WORKSPACE_ID = 'tea-davrdhtg1s2s73bjocvg';

const wait = (ms) => new Promise(r => setTimeout(r, ms));

async function makeGraphQLRequest(page, query, variables = {}) {
  const result = await page.evaluate(async (query, variables) => {
    try {
      const response = await fetch('https://api.render.com/graphql', {
        method: 'POST',
        credentials: 'include',
        headers: { 
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify({ query, variables })
      });
      const text = await response.text();
      return { status: response.status, text };
    } catch (e) {
      return { error: e.message };
    }
  }, query, variables);
  
  return result;
}

async function makeGraphQLRequestWithToken(query, variables = {}) {
  const result = await new Promise((resolve, reject) => {
    const body = JSON.stringify({ query, variables });
    const req = require('https').request({
      hostname: 'api.render.com',
      path: '/graphql',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(body)
      }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
  return result;
}

let apiKey = null;

async function main() {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1440,900', '--ignore-certificate-errors'],
    ignoreHTTPSErrors: true,
  });

  const page = await browser.newPage();

  try {
    // === STEP 1: Login ===
    console.log('=== STEP 1: Logging in to Render ===');
    await page.goto('https://dashboard.render.com/login', {
      waitUntil: 'networkidle2',
      timeout: 30000
    });
    
    await page.type('input[name="email"]', RENDER_EMAIL, { delay: 30 });
    await page.type('input[name="password"]', RENDER_PASSWORD, { delay: 30 });
    
    await Promise.all([
      page.waitForNavigation({ timeout: 15000 }).catch(() => {}),
      page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button[type="submit"], button:not([type])'));
        for (const btn of buttons) {
          if ((btn.textContent || '').toLowerCase().includes('sign in')) { btn.click(); return; }
        }
      })
    ]);
    await wait(5000);
    console.log('Login URL:', page.url());

    // === STEP 2: Create API Key ===
    console.log('\n=== STEP 2: Creating API key ===');
    
    // First try the mutation with the correct name
    const createKeyQuery = `
      mutation CreateApiKey($name: String!) {
        createApiKey(input: { name: $name }) {
          id
          key
          name
          createdAt
          __typename
        }
      }
    `;
    
    const keyResult = await makeGraphQLRequest(page, createKeyQuery, { name: 'wingo-deploy-key' });
    console.log('API Key result:', keyResult.status, keyResult.text?.substring(0, 1000));
    
    if (keyResult.text) {
      try {
        const parsed = JSON.parse(keyResult.text);
        if (parsed.data?.createApiKey?.key) {
          apiKey = parsed.data.createApiKey.key;
          console.log('API KEY CREATED:', apiKey.substring(0, 15) + '...');
          fs.writeFileSync('/tmp/render_api_key_real.txt', apiKey);
        }
        if (parsed.errors) {
          console.log('GraphQL errors:', JSON.stringify(parsed.errors));
        }
      } catch(e) {
        console.log('Parse error:', e.message);
      }
    }
    
    // Also try with ownerId
    if (!apiKey) {
      console.log('Trying with ownerId...');
      const keyResult2 = await makeGraphQLRequest(page, createKeyQuery, { name: 'wingo-deploy-key', ownerId: WORKSPACE_ID });
      console.log('Result2:', keyResult2.status, keyResult2.text?.substring(0, 1000));
      
      if (keyResult2.text) {
        try {
          const parsed = JSON.parse(keyResult2.text);
          if (parsed.data?.createApiKey?.key) {
            apiKey = parsed.data.createApiKey.key;
            console.log('API KEY CREATED (v2):', apiKey.substring(0, 15) + '...');
            fs.writeFileSync('/tmp/render_api_key_real.txt', apiKey);
          }
        } catch(e) {}
      }
    }

    // === STEP 3: If we have an API key, create the service ===
    if (apiKey) {
      console.log('\n=== STEP 3: Creating web service ===');
      
      // Try to create the service via REST API
      const serviceData = JSON.stringify({
        type: 'web_service',
        name: 'wingo-racer',
        repo: 'https://github.com/clipuni34-coder/Syntheniq',
        autoDeploy: true,
        branch: 'main',
        envVars: {
          FB999_PHONE: '2349121493739',
          FB999_PASSWORD: 'Drewziwugod6',
          NODE_ENV: 'production',
          PORT: '3000'
        },
        serviceDetails: {
          plan: 'free',
          region: 'oregon',
          runtime: 'docker',
          healthCheckPath: '/health',
          numInstances: 1
        }
      });
      
      // Use curl to create the service via REST API
      // The Render API uses REST API v1, and the ownerId is the workspace
      const deployResult = await new Promise((resolve, reject) => {
        const req = require('https').request({
          hostname: 'api.render.com',
          path: `/v1/services?ownerId=${WORKSPACE_ID}`,
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          }
        }, res => {
          let data = '';
          res.on('data', c => data += c);
          res.on('end', () => resolve({ status: res.statusCode, body: data }));
        });
        req.on('error', reject);
        req.write(serviceData);
        req.end();
      });
      
      console.log('Deploy result:', deployResult.status, deployResult.body.substring(0, 1000));
      
      if (deployResult.status === 201) {
        console.log('Service created!');
        const result = JSON.parse(deployResult.body);
        console.log('Service URL:', result.service?.url || result.url);
        console.log('Service ID:', result.service?.id || result.id);
      }
    }

    await browser.close();
    console.log('\n=== Script completed ===');
    
  } catch (error) {
    console.error('ERROR:', error.message);
    console.error(error.stack);
    try { await page.screenshot({ path: '/workspace/app/screenshots/final-deploy-error.png', fullPage: true }); } catch (e) {}
    await browser.close();
  }
}

main().catch(console.error);
