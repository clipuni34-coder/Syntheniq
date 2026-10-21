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
  
  // Intercept API requests to capture the API key
  const apiResponses = [];
  
  page.on('response', async response => {
    const url = response.url();
    if (url.includes('api.render.com') || url.includes('dashboard.render.com/api')) {
      try {
        const body = await response.text();
        apiResponses.push({ url, status: response.status(), body: body.substring(0, 2000) });
      } catch (e) {}
    }
  });
  
  page.on('request', request => {
    const url = request.url();
    if (url.includes('api-key') || url.includes('api_keys') || url.includes('apikey')) {
      console.log('[REQUEST]:', request.method(), url);
    }
  });

  try {
    // Login
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
    
    // Go to settings
    await page.goto('https://dashboard.render.com/u/settings', {
      waitUntil: 'networkidle2',
      timeout: 30000
    });
    await page.screenshot({ path: '/workspace/app/screenshots/settings-before-key.png', fullPage: true });
    
    // Click "Create API Key" button
    await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      for (const btn of buttons) {
        if ((btn.textContent || '').toLowerCase().includes('create') && 
            (btn.textContent || '').toLowerCase().includes('api')) {
          btn.click();
          return;
        }
      }
    });
    console.log('Clicked create API key');
    await wait(3000);
    await page.screenshot({ path: '/workspace/app/screenshots/api-key-modal.png', fullPage: true });
    
    // Look for modal with API key
    // Render shows the key in a modal with a copy button
    const apiKeyData = await page.evaluate(() => {
      // Get all text content
      const bodyText = document.body.innerText;
      // Also check for code blocks, pre tags, inputs
      const codeElements = Array.from(document.querySelectorAll('code, pre, kbd'));
      const inputElements = Array.from(document.querySelectorAll('input[type="text"], input[type="password"], input[readonly]'));
      
      let result = {
        bodyTextSnippet: bodyText.substring(0, 2000),
        codeElements: codeElements.map(e => e.textContent?.trim()),
        inputValues: inputElements.map(e => e.value),
      };
      
      // Look for API key pattern - Render keys often look like a long string
      const allText = bodyText + ' ' + codeElements.map(e => e.textContent || '').join(' ') + ' ' + inputElements.map(e => e.value || '').join(' ');
      // Try to find a pattern like "rndr_" or "render_" or just a long alphanumeric string
      const keyMatch = allText.match(/[a-zA-Z0-9_-]{32,}/g);
      if (keyMatch) {
        result.potentialKeys = keyMatch.filter(k => !k.toLowerCase().includes('create') && !k.toLowerCase().includes('button'));
      }
      
      return result;
    });
    
    console.log('API key data:', JSON.stringify(apiKeyData, null, 2));
    
    // Also check the clipboard after clicking create
    const clipboardText = await page.evaluate(async () => {
      try {
        return await navigator.clipboard.readText();
      } catch (e) {
        return null;
      }
    });
    console.log('Clipboard:', clipboardText);
    
    // Wait a bit and check for the key to appear
    await wait(2000);
    await page.screenshot({ path: '/workspace/app/screenshots/api-key-after-wait.png', fullPage: true });
    
    // Try again to extract
    const keyRetry = await page.$eval('body', () => document.body.innerText);
    console.log('Body text length:', keyRetry.length);
    
    // Print the full body text to see what's there
    const fullBody = await page.evaluate(() => document.body.innerText.substring(0, 5000));
    console.log('Full body text:', fullBody);

    await browser.close();
    
    // Also print captured API responses
    console.log('\n=== Captured API responses ===');
    for (const resp of apiResponses) {
      console.log(`URL: ${resp.url}`);
      console.log(`Status: ${resp.status}`);
      if (resp.body.includes('key') || resp.body.includes('token') || resp.body.length < 500) {
        console.log(`Body: ${resp.body}`);
      }
      console.log('---');
    }
    
  } catch (error) {
    console.error('ERROR:', error.message);
    console.error(error.stack);
    try {
      await page.screenshot({ path: '/workspace/app/screenshots/capture-key-error.png', fullPage: true });
    } catch (e) {}
    await browser.close();
  }
}

main().catch(console.error);
