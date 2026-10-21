const puppeteer = require('puppeteer');
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
    // Login
    console.log('=== Logging in ===');
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

    // Go to the Render dashboard - try to create a service directly from UI
    console.log('\n=== Navigating to dashboard ===');
    await page.goto('https://dashboard.render.com', { waitUntil: 'networkidle2', timeout: 30000 });
    await page.screenshot({ path: '/workspace/app/screenshots/dashboard-home.png', fullPage: true });
    
    // Look for "New" or "New +" button
    const newBtn = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button, a'));
      for (const btn of buttons) {
        const text = (btn.textContent || '').toLowerCase().trim();
        if (text.includes('new') || text.includes('+')) {
          const rect = btn.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            console.log('Found new button:', text, btn.tagName);
            btn.click();
            return text;
          }
        }
      }
      return false;
    });
    console.log('New button:', newBtn);
    await wait(3000);
    await page.screenshot({ path: '/workspace/app/screens/new-dropdown.png', fullPage: true });
    
    // Look for web service option
    await page.evaluate(() => {
      const elements = Array.from(document.querySelectorAll('button, a, div'));
      for (const el of elements) {
        const text = (el.textContent || '').toLowerCase().trim();
        if (text.includes('web service') || text.includes('web_service') || text.includes('webservice')) {
          console.log('Found web service option:', text);
          el.click();
          return text;
        }
      }
      return false;
    });
    
    await wait(3000);
    console.log('URL after clicking web service:', page.url());
    await page.screenshot({ path: '/workspace/app/screenshots/web-service-wizard.png', fullPage: true });
    
    // Check if we're on the service creation wizard
    if (page.url().includes('new') || page.url().includes('create')) {
      console.log('On service creation wizard!');
      
      // Look for GitHub repo connection
      const pageText = await page.evaluate(() => document.body.innerText.substring(0, 2000));
      console.log('Page text:', pageText);
    }

    await browser.close();
    console.log('=== Done ===');
    
  } catch (error) {
    console.error('ERROR:', error.message);
    console.error(error.stack);
    try { await page.screenshot({ path: '/workspace/app/screenshots/ui-deploy-error.png', fullPage: true }); } catch (e) {}
    await browser.close();
  }
}

main().catch(console.error);
