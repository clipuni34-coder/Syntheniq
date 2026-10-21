const puppeteer = require('puppeteer');
const { spawn } = require('child_process');
const fs = require('fs');

const RENDER_EMAIL = 'clipuni34@gmail.com';
const RENDER_PASSWORD = 'Drewziwugod@6';
const wait = (ms) => new Promise(r => setTimeout(r, ms));

async function main() {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1440,900', '--ignore-certificate-errors'],
    ignoreHTTPSErrors: true,
  });

  const page = await browser.newPage();

  try {
    // Login to Render dashboard first
    console.log('=== Logging in to Render ===');
    await page.goto('https://dashboard.render.com/login', { waitUntil: 'networkidle2', timeout: 30000 });
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

    // Now go to API key creation page
    await page.goto('https://dashboard.render.com/u/settings', { waitUntil: 'networkidle2', timeout: 30000 });
    await page.screenshot({ path: '/workspace/app/screenshots/settings-check.png', fullPage: true });
    
    // Get cookies to use with render CLI
    const cookies = await page.cookies();
    console.log('Cookies:', cookies.map(c => ({name: c.name, value: c.value.substring(0, 20) + '...'})));
    
    // Now let's try to directly create a service using the render CLI
    // Save cookies
    const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    
    // Let's try to access the render API directly using the session
    const apiTest = await page.evaluate(async () => {
      try {
        const response = await fetch('https://api.render.com/v1/services', {
          method: 'GET',
          credentials: 'include',
          headers: { 'Accept': 'application/json' }
        });
        const text = await response.text();
        return response.status + ': ' + text.substring(0, 500);
      } catch (e) {
        return 'ERROR: ' + e.message;
      }
    });
    console.log('API test:', apiTest);
    
    // Try to find the correct GraphQL mutation for creating API key
    // by looking at the page source for any scripts containing "ApiToken" or "apiKey"
    const pageContent = await page.content();
    const matches = pageContent.match(/create[A-Za-z]*ApiKey|create[A-Za-z]*ApiToken|create[A-Za-z]*Token/g);
    console.log('Mutation name guesses from page:', matches);
    
    // Let's try to search for the mutation name in the page's JavaScript bundles
    const scriptSrcs = await page.evaluate(() => {
      const scripts = Array.from(document.querySelectorAll('script[src]'));
      return scripts.map(s => s.src);
    });
    console.log('Script sources:', scriptSrcs);
    
    // Check one of the scripts for API key related mutations
    for (const src of scriptSrcs) {
      if (src.includes('dashboard.render.com')) {
        try {
          const res = await page.goto(src, { waitUntil: 'networkidle0', timeout: 10000 });
          const content = await res.text();
          const found = content.match(/create[A-Za-z]*Api[A-Za-z]*|create[A-Za-z]*Token[A-Za-z]*/g);
          if (found) {
            console.log('Found in script', src, ':', found);
          }
        } catch (e) {
          // Skip
        }
      }
    }

    await browser.close();
    console.log('=== Done ===');
    
  } catch (error) {
    console.error('ERROR:', error.message);
    console.error(error.stack);
    try { await page.screenshot({ path: '/workspace/app/screenshots/cli-login-error.png', fullPage: true }); } catch (e) {}
    await browser.close();
  }
}

main().catch(console.error);
