const puppeteer = require('puppeteer');

const RENDER_EMAIL = 'clipuni34@gmail.com';
const RENDER_PASSWORD = 'Drewziwugod@6'; // Password with @ symbol as specified in task

const wait = (ms) => new Promise(r => setTimeout(r, ms));

async function main() {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--window-size=1440,900',
      '--ignore-certificate-errors',
      '--ignore-web-security',
    ],
    ignoreHTTPSErrors: true,
  });

  const page = await browser.newPage();
  
  // Set up request interception to catch API calls
  await page.setRequestInterception(true);
  page.on('request', request => request.continue());
  
  page.on('console', msg => console.log(`[PAGE]: ${msg.text()}`));
  page.on('pageerror', err => console.log(`[PAGEERR]: ${err.message()}`));

  try {
    // Step 1: Register on Render
    console.log('=== Registering on Render ===');
    await page.goto('https://dashboard.render.com/register', {
      waitUntil: 'networkidle2',
      timeout: 30000
    });
    
    console.log('Title:', await page.title());
    console.log('URL:', page.url());
    await page.screenshot({ path: '/workspace/app/screenshots/render-register.png', fullPage: true });
    
    // Look for email/password registration form
    const formFields = await page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('input'));
      return inputs.map(inp => ({
        name: inp.name,
        type: inp.type,
        id: inp.id,
        placeholder: inp.placeholder,
      }));
    });
    console.log('Form inputs:', JSON.stringify(formFields));
    
    // Fill in email
    await page.type('input[name="email"], input[name="emailAddress"], input[type="email"], input[id*="email"]', RENDER_EMAIL, { delay: 50 }).catch(e => console.log('Email field:', e.message));
    // Fill in password
    await page.type('input[name="password"], input[type="password"]', RENDER_PASSWORD, { delay: 50 }).catch(e => console.log('Password field:', e.message));
    
    // Look for terms checkbox
    await page.evaluate(() => {
      const labels = Array.from(document.querySelectorAll('label'));
      for (const label of labels) {
        if (label.textContent?.toLowerCase().includes('terms') || label.textContent?.toLowerCase().includes('agree')) {
          const checkbox = label.querySelector('input[type="checkbox"]');
          if (checkbox) checkbox.click();
        }
      }
    });
    
    // Click "Sign Up" button
    await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      for (const btn of buttons) {
        const text = (btn.textContent || '').toLowerCase();
        if (text.includes('sign up') || text.includes('create') || text.includes('register') || text.includes('continue')) {
          const rect = btn.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            btn.click();
            return true;
          }
        }
      }
      return false;
    });
    console.log('Clicked sign-up button');
    
    // Wait for registration to complete
    await wait(5000);
    console.log('URL after sign-up:', page.url());
    await page.screenshot({ path: '/workspace/app/screenshots/render-register-result.png', fullPage: true });
    
    // Check if registration succeeded - look for dashboard or email verification
    const isOnDashboard = page.url().includes('dashboard.render.com') && !page.url().includes('/register') && !page.url().includes('/login');
    console.log('On dashboard:', isOnDashboard);
    
    // Check if we need to verify email
    const needsVerification = await page.evaluate(() => {
      const text = document.body.textContent?.toLowerCase() || '';
      return text.includes('verify') || text.includes('confirm your email') || text.includes('check your email');
    });
    console.log('Needs email verification:', needsVerification);

  } catch (error) {
    console.error('=== ERROR ===');
    console.error(error.message);
    try {
      await page.screenshot({ path: '/workspace/app/screenshots/render-register-error.png', fullPage: true });
    } catch (e) {}
  }
  
  await browser.close();
}

main().catch(console.error);
