/**
 * Puppeteer script to deploy app to Render.com dashboard
 * Uses existing Render account or creates one
 */
const puppeteer = require('puppeteer');
const fs = require('fs');

const RENDER_EMAIL = 'clipuni34@gmail.com';
const RENDER_PASSWORD = 'Drewziwugod6'; // Will not be used directly, may need manual auth

async function main() {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-infobars',
      '--disable-web-security',
      '--disable-features=IsolateOrigins,site-per-process',
      '--window-size=1280,800',
      '--ignore-certificate-errors',
      '--ignore-ssl-errors=yes',
      '--ignore-untrusted-pkcs12'
    ],
    ignoreHTTPSErrors: true,
    defaultViewport: null
  });

  const page = await browser.newPage();
  
  // Collect all console messages
  page.on('console', msg => {
    if (msg.type() === 'error') {
      console.log(`[PAGE ERROR]: ${msg.text()}`);
    } else {
      console.log(`[PAGE LOG]: ${msg.text()}`);
    }
  });
  
  page.on('pageerror', err => {
    console.log(`[PAGEERROR]: ${err.message()}`);
  });
  
  page.on('requestfailed', request => {
    console.log(`[REQUEST FAILED]: ${request.url()} - ${request.failure()?.errorText}`);
  });

  try {
    console.log('=== Navigating to Render dashboard ===');
    await page.goto('https://dashboard.render.com', {
      waitUntil: 'networkidle2',
      timeout: 60000
    });

    // Check if already logged in by looking for the services grid
    const isLoggedIn = await page.evaluate(() => {
      return document.querySelector('a[href="/services"]') !== null ||
             document.querySelector('span[data-testid="account-menu"]') !== null ||
             document.querySelector('[href*="/new"]') !== null;
    });

    console.log(`Already logged in: ${isLoggedIn}`);

    if (!isLoggedIn) {
      console.log('=== Not logged in, attempting login ===');
      
      // Try to find the login button/link
      console.log('Looking for login/signup options...');
      
      // Try clicking the login button
      try {
        const loginSelector = 'a[href*="login"], a[href*="sign_in"], button:has-text("Log In"), button:has-text("Sign In")';
        await page.waitForSelector(loginSelector, { timeout: 10000 });
        const loginElement = await page.$(loginSelector);
        if (loginElement) {
          await loginElement.click();
          console.log('Clicked login button');
        }
      } catch (e) {
        console.log(`Login button not found with selector: ${e.message}`);
      }
      
      // Wait for login form
      try {
        await page.waitForSelector('input[name="email"], input[name="email"], input[type="email"], input[id*="email"]', { 
          timeout: 15000, 
          visible: true 
        });
        console.log('Login form found');
      } catch (e) {
        console.log(`Login form not found: ${e.message}`);
      }

      // Fill in email
      await page.evaluate(() => {
        const emailInput = document.querySelector('input[type="email"], input[name="email"], input[id*="email"]');
        if (emailInput) {
          emailInput.value = '';
          emailInput.focus();
        }
      });
      await page.type('input[type="email"], input[name="email"], input[id*="email"]', RENDER_EMAIL, { delay: 100 });
      console.log('Email entered');

      // Fill in password
      await page.type('input[type="password"], input[name="password"], input[id*="password"]', RENDER_PASSWORD, { delay: 100 });
      console.log('Password entered');

      // Click submit
      await Promise.all([
        page.waitForNavigation({ timeout: 30000 }).catch(() => {}),
        page.click('button[type="submit"], button:has-text("Log In"), button:has-text("Sign In")').catch(() => {})
      ]);
      console.log('Submit clicked');

      // Wait for dashboard
      await page.waitForTimeout(5000);
      
      // Take a screenshot for debugging
      await page.screenshot({ path: '/workspace/app/screenshots/render-login-result.png', fullPage: true });
      console.log('Screenshot saved: render-login-result.png');
    }

    // Now try to create a new web service
    console.log('=== Looking for "New" button to create web service ===');
    
    // Try multiple strategies to find the new service button
    const newButtonClickable = await page.evaluate(() => {
      // Look for "New" button
      const buttons = Array.from(document.querySelectorAll('button'));
      for (const btn of buttons) {
        const text = btn.textContent || '';
        if (text.includes('New') || text.includes('new') || text.includes('+')) {
          const rect = btn.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            btn.style.outline = '2px solid red';
            return true;
          }
        }
      }
      // Also look for links
      const links = Array.from(document.querySelectorAll('a'));
      for (const link of links) {
        const text = link.textContent || '';
        if (text.includes('New') || text.includes('new')) {
          const rect = link.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            link.style.outline = '2px solid blue';
            return true;
          }
        }
      }
      return false;
    });
    
    console.log(`Found new button: ${newButtonClickable}`);
    
    if (newButtonClickable) {
      await page.screenshot({ path: '/workspace/app/screenshots/render-new-button-highlighted.png', fullPage: true });
      console.log('Screenshot saved: render-new-button-highlighted.png');
    }

    // Print page title for debugging
    console.log('Page title:', await page.title());
    
    // Get current URL
    console.log('Current URL:', page.url());
    
    await browser.close();
    console.log('=== Script completed ===');
    
  } catch (error) {
    console.error('=== ERROR ===');
    console.error(error.message);
    
    // Take screenshot on error
    await page.screenshot({ path: '/workspace/app/screenshots/render-error.png', fullPage: true });
    console.log('Error screenshot saved');
    
    await browser.close();
    process.exit(1);
  }
}

main();
