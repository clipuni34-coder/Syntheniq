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

  // Intercept ALL requests
  page.on('request', request => {
    const url = request.url();
    if (url.includes('graphql')) {
      console.log('[REQ]:', request.method(), url, request.postData?.()?.substring(0, 500));
    }
  });

  page.on('response', async response => {
    const url = response.url();
    if (url.includes('graphql')) {
      const body = await response.text();
      console.log('[RESP]:', response.status(), body.substring(0, 1000));
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
    
    // Try to create API key via direct fetch
    console.log('\n=== Creating API key via fetch ===');
    
    const result = await page.evaluate(async () => {
      const query = `mutation CreateApiKey($name: String!) { createApiToken(input: { name: $name }) { id key name createdAt __typename } }`;
      try {
        const response = await fetch('https://api.render.com/graphql', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: JSON.stringify({ query, variables: { name: 'wingo-deploy-key' } })
        });
        const data = await response.json();
        return JSON.stringify(data);
      } catch (e) {
        return JSON.stringify({ error: e.message });
      }
    });
    
    console.log('Result:', result);
    
    // Parse result
    try {
      const parsed = JSON.parse(result);
      if (parsed.data && parsed.data.createApiToken && parsed.data.createApiToken.key) {
        const key = parsed.data.createApiToken.key;
        console.log('API KEY FOUND:', key.substring(0, 15) + '...');
        fs.writeFileSync('/tmp/render_api_key_real.txt', key);
      }
      if (parsed.errors) {
        console.log('GraphQL errors:', JSON.stringify(parsed.errors));
      }
    } catch (e) {
      console.log('Could not parse result:', e.message);
    }

    // Also try via the UI by clicking create and checking the modal
    console.log('\n=== Also trying UI approach ===');
    
    // Click create API key button
    await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      for (const btn of buttons) {
        const text = (btn.textContent || '').toLowerCase();
        if (text.includes('create') && text.includes('api')) {
          btn.click();
          console.log('Clicked:', text);
          return;
        }
      }
    });
    await wait(3000);
    await page.screenshot({ path: '/workspace/app/screenshots/ui-key-modal.png', fullPage: true });
    
    // Fill in name and submit
    await page.evaluate(() => {
      const input = document.querySelector('input');
      if (input) {
        input.value = 'wingo-deploy-key';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
    
    await wait(1000);
    
    await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      for (const btn of buttons) {
        const text = (btn.textContent || '').toLowerCase();
        if (text.includes('create api key')) {
          btn.click();
          console.log('Clicked create in modal:', text);
          return;
        }
      }
    });
    
    await wait(3000);
    await page.screenshot({ path: '/workspace/app/screenshots/ui-key-result.png', fullPage: true });
    
    // Look for the key in the page
    const pageKey = await page.evaluate(() => {
      const allEls = Array.from(document.querySelectorAll('*'));
      for (const el of allEls) {
        const text = (el.textContent || '').trim();
        if (text.length > 30 && text.length < 200 && text.includes('rndr')) {
          return text;
        }
        if (el.tagName === 'INPUT' && el.value && el.value.length > 30) {
          return el.value;
        }
      }
      return null;
    });
    console.log('Key from UI:', pageKey ? 'FOUND: ' + pageKey.substring(0, 15) + '...' : 'NOT FOUND');
    
    // Check clipboard
    const clipboard = await page.evaluate(async () => {
      try { return await navigator.clipboard.readText(); } catch (e) { return null; }
    });
    console.log('Clipboard:', clipboard ? 'HAS TEXT: ' + clipboard.substring(0, 15) + '...' : 'EMPTY');

    await browser.close();
    console.log('=== Done ===');
    
  } catch (error) {
    console.error('ERROR:', error.message);
    console.error(error.stack);
    try { await page.screenshot({ path: '/workspace/app/screenshots/key-v4-error.png', fullPage: true }); } catch (e) {}
    await browser.close();
  }
}

main().catch(console.error);
