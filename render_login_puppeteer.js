const puppeteer = require('puppeteer');

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
  page.on('pageerror', err => console.log(`[PAGEERR]: ${err.message()}`));

  try {
    // Step 1: Go to Render login page
    console.log('=== Navigating to Render login ===');
    await page.goto('https://dashboard.render.com/login', {
      waitUntil: 'networkidle2',
      timeout: 30000
    });
    
    console.log('Title:', await page.title());
    console.log('URL:', page.url());
    await page.screenshot({ path: '/workspace/app/screenshots/render-login-check.png', fullPage: true });
    
    // Fill in email and password
    const emailInput = await page.$('input[name="email"], input[type="email"]');
    const passInput = await page.$('input[name="password"], input[type="password"]');
    
    if (emailInput) {
      await emailInput.type(RENDER_EMAIL, { delay: 50 });
      console.log('Email entered:', RENDER_EMAIL);
    }
    if (passInput) {
      await passInput.type(RENDER_PASSWORD, { delay: 50 });
      console.log('Password entered');
    }
    
    // Click sign in button
    await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button[type="submit"], button:not([type])'));
      for (const btn of buttons) {
        const text = (btn.textContent || '').toLowerCase();
        if (text.includes('sign in') || text.includes('log in') || text.includes('login')) {
          btn.click();
          return true;
        }
      }
      return false;
    });
    console.log('Clicked sign-in button');
    
    await wait(5000);
    console.log('URL after login:', page.url());
    await page.screenshot({ path: '/workspace/app/screenshots/render-login-result2.png', fullPage: true });
    
    // Check if login succeeded
    const isLoggedIn = page.url().includes('dashboard.render.com') && !page.url().includes('/login');
    console.log('Logged in:', isLoggedIn);
    
    // Check for error messages
    const errorText = await page.evaluate(() => {
      const errors = Array.from(document.querySelectorAll('[class*="error"], [class*="alert"], [role="alert"]'));
      return errors.map(e => e.textContent?.trim()).filter(t => t);
    });
    console.log('Error messages:', errorText);
    
    // Check if we're back on the dashboard
    const pageContent = await page.content();
    const hasServices = pageContent.includes('service') || pageContent.includes('Services') || pageContent.includes('new');
    console.log('Has services elements:', hasServices);

  } catch (error) {
    console.error('=== ERROR ===');
    console.error(error.message);
    try {
      await page.screenshot({ path: '/workspace/app/screenshots/render-login-error.png', fullPage: true });
    } catch (e) {}
  }
  
  await browser.close();
}

main().catch(console.error);
