const puppeteer = require('puppeteer');
const fs = require('fs');

const RENDER_EMAIL = 'clipuni34@gmail.com';
const RENDER_PASSWORD = 'Drewziwugod@6';

const wait = (ms) => new Promise(r => setTimeout(r, ms));

async function main() {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--window-size=1440,900',
      '--ignore-certificate-errors',
    ],
    ignoreHTTPSErrors: true,
  });

  const page = await browser.newPage();

  // Capture GraphQL POST requests
  page.on('request', request => {
    const url = request.url();
    if (url.includes('graphql') && request.method() === 'POST') {
      const body = request.postData?.();
      if (body && body.includes('ApiToken') || body && body.includes('createApi') || body && body.includes('ApiKey')) {
        console.log('[KEY REQUEST]:', body.substring(0, 500));
      }
    }
  });

  page.on('response', async response => {
    const url = response.url();
    if (url.includes('graphql') && response.request().method() === 'POST') {
      try {
        const body = await response.text();
        if (body.includes('key') || body.includes('token')) {
          console.log('[KEY RESPONSE]:', response.status(), body.substring(0, 1000));
        }
      } catch (e) {
        // Ignore - might be OPTIONS preflight
      }
    }
  });

  try {
    // Login
    console.log('=== Logging in ===');
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
          const text = (btn.textContent || '').toLowerCase();
          if (text.includes('sign in') || text.includes('log in')) {
            btn.click();
            return;
          }
        }
      })
    ]);
    await wait(5000);
    console.log('Login URL:', page.url());

    // Navigate to settings
    await page.goto('https://dashboard.render.com/u/settings', {
      waitUntil: 'networkidle2',
      timeout: 30000
    });
    await page.screenshot({ path: '/workspace/app/screenshots/settings-ready.png', fullPage: true });
    
    // Try to create API key via direct fetch - capture the response
    const result = await page.evaluate(async () => {
      const query = `mutation CreateApiKey($name: String!) { createApiToken(input: { name: $name }) { id key name createdAt __typename } }`;
      try {
        const response = await fetch('https://api.render.com/graphql', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: JSON.stringify({ query, variables: { name: 'wingo-deploy-key' } })
        });
        const text = await response.text();
        return response.status + ': ' + text;
      } catch (e) {
        return 'ERROR: ' + e.message;
      }
    });
    
    console.log('Direct fetch result:', result);
    
    // Try a different mutation name based on what the UI uses
    // Let's also try to discover the schema
    const introspectionResult = await page.evaluate(async () => {
      const query = `query { __schema { mutationType { fields { name } } } }`;
      try {
        const response = await fetch('https://api.render.com/graphql', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: JSON.stringify({ query })
        });
        const text = await response.text();
        return 'STATUS: ' + response.status + ' BODY: ' + text;
      } catch (e) {
        return 'ERROR: ' + e.message;
      }
    });
    
    console.log('Schema introspection:', introspectionResult);

    await browser.close();
    console.log('=== Done ===');
    
  } catch (error) {
    console.error('ERROR:', error.message);
    console.error(error.stack);
    try { await page.screenshot({ path: '/workspace/app/screenshots/key-v5-error.png', fullPage: true }); } catch (e) {}
    await browser.close();
  }
}

main().catch(console.error);
