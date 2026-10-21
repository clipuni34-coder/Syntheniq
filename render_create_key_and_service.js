const puppeteer = require('puppeteer');
const fs = require('fs');
const https = require('https');

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

  // Intercept all GraphQL requests and responses
  const graphqlRequests = [];
  page.on('response', async response => {
    if (response.url().includes('graphql')) {
      try {
        const body = await response.text();
        const parsed = JSON.parse(body);
        if (parsed.query) {
          graphqlRequests.push({
            query: parsed.query.substring(0, 500),
            variables: JSON.stringify(parsed.variables || {}),
            response: body.substring(0, 1000)
          });
        }
      } catch (e) {}
    }
  });

  try {
    // Login
    console.log('=== Logging in ===');
    await page.goto('https://dashboard.render.com/login', {
      waitUntil: 'networkidle2',
      timeout: 30000
    });
    
    await page.type('input[name="email"], input[type="email"]', RENDER_EMAIL, { delay: 30 });
    await page.type('input[name="password"], input[type="password"]', RENDER_PASSWORD, { delay: 30 });
    
    await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button[type="submit"], button:not([type])'));
      for (const btn of buttons) {
        const text = (btn.textContent || '').toLowerCase();
        if (text.includes('sign in') || text.includes('log in')) {
          btn.click();
          return;
        }
      }
    });
    await wait(5000);
    
    // Navigate to settings
    await page.goto('https://dashboard.render.com/u/settings', {
      waitUntil: 'networkidle2',
      timeout: 30000
    });
    
    console.log('=== Creating API key ===');
    
    // Click "Create API key" button
    await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      for (const btn of buttons) {
        const text = (btn.textContent || '').toLowerCase();
        if (text.includes('create') && text.includes('api')) {
          btn.click();
          return;
        }
      }
    });
    await wait(2000);
    await page.screenshot({ path: '/workspace/app/screenshots/key-modal-open.png', fullPage: true });
    
    // Fill in key name
    await page.evaluate(() => {
      const input = document.querySelector('input');
      if (input) {
        input.value = 'wingo-deploy-key';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    
    // Click the "Create API Key" button in the modal
    await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      for (const btn of buttons) {
        const text = (btn.textContent || '').toLowerCase();
        if (text.includes('create api key') || (text.includes('create') && text.includes('key'))) {
          btn.click();
          return;
        }
      }
    });
    
    await wait(3000);
    await page.screenshot({ path: '/workspace/app/screenshots/key-result.png', fullPage: true });
    
    // Look for the API key in a code element or input
    const apiKey = await page.evaluate(() => {
      // Render shows the key in a special element - often in a code block or readonly input
      const inputs = Array.from(document.querySelectorAll('input[readonly], input[type="text"]'));
      for (const inp of inputs) {
        if (inp.value && inp.value.length > 20) {
          return inp.value;
        }
      }
      
      // Check for code/pre elements
      const codes = Array.from(document.querySelectorAll('code, pre, kbd, [class*="key"]'));
      for (const el of codes) {
        const text = (el.textContent || '').trim();
        if (text.length > 20 && text.length < 200) {
          // Render API keys start with "rndr_" or similar
          if (text.match(/^rndr_/)) return text;
          if (text.match(/^[a-zA-Z0-9_-]{30,}$/)) return text;
        }
      }
      
      // Check all text content for key-like patterns
      const allText = document.body.innerText;
      const lines = allText.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.match(/^rndr_[a-zA-Z0-9_-]+$/) || 
            (trimmed.length > 30 && trimmed.length < 200 && /^[a-zA-Z0-9_-]+$/.test(trimmed) &&
             !trimmed.toLowerCase().includes('button') && !trimmed.toLowerCase().includes('create'))) {
          return trimmed;
        }
      }
      
      return null;
    });
    
    console.log('API key found:', apiKey ? 'YES' : 'NO');
    if (apiKey) {
      console.log('Key preview:', apiKey.substring(0, 15) + '...');
      fs.writeFileSync('/tmp/render_api_key_real.txt', apiKey.trim());
    }
    
    // Print GraphQL requests related to API key creation
    console.log('\n=== GraphQL requests for API key creation ===');
    const keyRequests = graphqlRequests.filter(r => 
      r.query.includes('ApiToken') || r.query.includes('apiToken') || r.query.includes('api_key') ||
      r.query.includes('createApiKey') || r.query.includes('CreateApiKey')
    );
    console.log(JSON.stringify(keyRequests, null, 2));

    // Also print all GraphQL requests
    console.log('\n=== All GraphQL requests ===');
    for (const req of graphqlRequests) {
      console.log('Query:', req.query.substring(0, 200));
      console.log('Variables:', req.variables);
      console.log('Response:', req.response.substring(0, 500));
      console.log('---');
    }
    
    await browser.close();
    
  } catch (error) {
    console.error('ERROR:', error.message);
    console.error(error.stack);
    try {
      await page.screenshot({ path: '/workspace/app/screenshots/key-error.png', fullPage: true });
    } catch (e) {}
    await browser.close();
  }
}

main().catch(console.error);
