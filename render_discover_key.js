const puppeteer = require('puppeteer');
const fs = require('fs');

const RENDER_EMAIL = 'clipuni34@gmail.com';
const RENDER_PASSWORD = 'Drewziwugod@6';
const WORKSPACE_ID = 'tea-davrdhtg1s2s73bjocvg';

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

  // Capture ALL GraphQL POST requests
  const graphqlCalls = [];
  page.on('request', request => {
    const url = request.url();
    if (url.includes('api.render.com/graphql') && request.method() === 'POST') {
      const body = request.postData?.();
      if (body) {
        try {
          const parsed = JSON.parse(body);
          graphqlCalls.push({
            operation: parsed.operationName || 'unknown',
            query: parsed.query,
            variables: parsed.variables,
          });
        } catch(e) {}
      }
    }
  });

  // Capture response bodies
  page.on('response', async response => {
    const url = response.url();
    if (url.includes('api.render.com/graphql') && response.request().method() === 'POST') {
      try {
        const body = await response.text();
        if (body.includes('key') || body.includes('token') || body.includes('ApiKey')) {
          console.log('[RESP with key/token]:', body.substring(0, 1500));
        }
      } catch(e) {}
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
    await wait(3000);
    console.log('Login URL:', page.url());

    // Navigate to settings
    await page.goto('https://dashboard.render.com/u/settings', {
      waitUntil: 'networkidle2',
      timeout: 30000
    });
    await page.screenshot({ path: '/workspace/app/screenshots/settings-before-create.png', fullPage: true });
    
    // Capture baseline GraphQL calls
    const baselineCalls = [...graphqlCalls];
    
    // Click "Create API key" button
    console.log('=== Clicking Create API key ===');
    const clicked = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      for (const btn of buttons) {
        const text = (btn.textContent || '').toLowerCase();
        if (text.includes('create') && text.includes('api')) {
          btn.click();
          return text;
        }
      }
      return false;
    });
    console.log('Clicked:', clicked);
    
    await wait(3000);
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
    await wait(1000);
    
    // Click "Create API Key" in the modal
    await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      for (const btn of buttons) {
        const text = (btn.textContent || '').toLowerCase();
        if (text.includes('create api key')) {
          btn.click();
          return text;
        }
      }
    });
    console.log('Clicked create in modal');
    
    await wait(5000);
    await page.screenshot({ path: '/workspace/app/screenshots/key-created.png', fullPage: true });
    
    // Print NEW GraphQL calls (made after we clicked create)
    console.log('\n=== NEW GraphQL calls after creating key ===');
    const newCalls = graphqlCalls.slice(baselineCalls.length);
    for (const call of newCalls) {
      console.log('Operation:', call.operation);
      console.log('Query (first 300):', call.query?.substring(0, 300));
      console.log('Variables:', JSON.stringify(call.variables).substring(0, 500));
      console.log('---');
    }
    
    // If we found a mutation with a key in the response, look for it
    // Check if clipboard was updated
    const clipboard = await page.evaluate(async () => {
      try { return await navigator.clipboard.readText(); } catch (e) { return null; }
    });
    console.log('\nClipboard:', clipboard ? 'HAS ' + clipboard.length + ' chars' : 'EMPTY');
    if (clipboard && clipboard.length > 30) {
      console.log('Clipboard content preview:', clipboard.substring(0, 20) + '...');
      fs.writeFileSync('/tmp/render_api_key_real.txt', clipboard.trim());
      console.log('API key saved from clipboard!');
    }
    
    // Look for the key in the page
    const pageKey = await page.evaluate(() => {
      // Look for any element containing a long key-like string
      const allEls = Array.from(document.querySelectorAll('code, pre, kbd, input[readonly], [class*="key"], [class*="token"]'));
      for (const el of allEls) {
        const text = (el.textContent || el.value || '').trim();
        if (text.length > 20 && text.length < 200) {
          return text;
        }
      }
      return null;
    });
    console.log('Key from page:', pageKey ? pageKey.substring(0, 20) + '...' : 'NOT FOUND');
    
    if (pageKey) {
      fs.writeFileSync('/tmp/render_api_key_real.txt', pageKey.trim());
    }

    await browser.close();
    console.log('=== Done ===');
    
  } catch (error) {
    console.error('ERROR:', error.message);
    console.error(error.stack);
    try { await page.screenshot({ path: '/workspace/app/screenshots/discover-error.png', fullPage: true }); } catch (e) {}
    await browser.close();
  }
}

main().catch(console.error);
