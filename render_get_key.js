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
  
  page.on('console', msg => console.log(`[PAGE]: ${msg.text()}`));

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
          return true;
        }
      }
      return false;
    });
    console.log('Login clicked');
    
    // Wait for login to complete
    await page.waitForNavigation({ timeout: 15000 }).catch(() => {});
    await wait(3000);
    console.log('URL:', page.url());

    // Navigate to settings
    console.log('=== Going to settings ===');
    await page.goto('https://dashboard.render.com/u/settings', {
      waitUntil: 'networkidle2',
      timeout: 30000
    });
    
    await page.screenshot({ path: '/workspace/app/screenshots/settings-page.png', fullPage: true });
    console.log('Settings URL:', page.url());

    // Look for existing API keys or "Create new API key" button
    const actions = await page.evaluate(() => {
      const elements = Array.from(document.querySelectorAll('button, a'));
      const matches = [];
      for (const el of elements) {
        const text = (el.textContent || '').toLowerCase().trim();
        if (text.includes('api key') || text.includes('api') || text.includes('create') || text.includes('new')) {
          const rect = el.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            matches.push({ text, tag: el.tagName, href: el.getAttribute('href') });
          }
        }
      }
      return matches.slice(0, 20);
    });
    console.log('Actions found:', JSON.stringify(actions, null, 2));

    // Try to find and click the "Create new API key" button
    await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      for (const btn of buttons) {
        const text = (btn.textContent || '').toLowerCase();
        if (text.includes('create') && text.includes('api')) {
          btn.click();
          console.log('Clicked create API key button:', text);
          return true;
        }
      }
      // Try any button with "Create" or "New"
      for (const btn of buttons) {
        const text = (btn.textContent || '').toLowerCase().trim();
        if ((text.includes('create') || text.includes('new')) && btn.offsetParent) {
          const rect = btn.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            btn.click();
            console.log('Clicked button:', text);
            return true;
          }
        }
      }
      return false;
    });
    
    await wait(2000);
    await page.screenshot({ path: '/workspace/app/screenshots/create-api-key.png', fullPage: true });

    // Look for API key input/modal
    // Render API keys typically look like a long alphanumeric string
    const apiKey = await page.evaluate(() => {
      // Check all input fields
      const inputs = Array.from(document.querySelectorAll('input'));
      for (const inp of inputs) {
        const val = inp.value;
        if (val && typeof val === 'string' && val.length > 30 && 
            /^[a-zA-Z0-9_-]+$/.test(val) &&
            !val.toLowerCase().includes('password') &&
            !val.toLowerCase().includes('email')) {
          return val;
        }
      }
      
      // Check all visible text
      const allText = Array.from(document.querySelectorAll('*'));
      for (const el of allText) {
        const text = (el.textContent || '').trim();
        if (text.length > 30 && text.length < 200 && 
            /^[a-zA-Z0-9_-]+$/.test(text) &&
            !text.toLowerCase().includes('render') &&
            !text.toLowerCase().includes('http')) {
          // Check if it's in a code/pre/button element
          const tag = el.tagName.toLowerCase();
          if (['code', 'pre', 'kbd', 'button'].includes(tag)) {
            return text;
          }
        }
      }
      return null;
    });
    
    // Also try clipboard
    const clipboardText = await page.evaluate(async () => {
      try {
        const text = await navigator.clipboard.readText();
        return text;
      } catch (e) {
        return null;
      }
    }).catch(() => null);
    
    console.log('API key from page:', apiKey ? 'FOUND' : 'NOT FOUND');
    console.log('Clipboard text:', clipboardText ? 'FOUND' : 'NOT FOUND');
    
    if (apiKey) {
      fs.writeFileSync('/tmp/render_api_key_clean.txt', apiKey);
      console.log('API key saved. Length:', apiKey.length);
      console.log('API key starts with:', apiKey.substring(0, 10) + '...');
    } else if (clipboardText) {
      fs.writeFileSync('/tmp/render_api_key_clean.txt', clipboardText);
      console.log('API key (from clipboard) saved. Length:', clipboardText.length);
    }

    await browser.close();
    console.log('=== Done ===');
    
  } catch (error) {
    console.error('ERROR:', error.message);
    console.error(error.stack);
    try {
      await page.screenshot({ path: '/workspace/app/screenshots/error-final.png', fullPage: true });
    } catch (e) {}
    await browser.close();
  }
}

main().catch(console.error);
