#!/usr/bin/env node
/**
 * fly_auth_complete.js — Automates Fly.io CLI authentication via Puppeteer.
 * Reads the flyctl auth URL from stdin, navigates it, fills email/password,
 * and approves the authorization. flyctl (running in another process)
 * detects the completion and stores the token.
 */
const puppeteer = require('puppeteer');
const fs = require('fs');

const EMAIL = 'clipuni34@gmail.com';
const PASSWORD = 'Drewziwugod@6';

// Read the auth URL from command-line argument
const authUrl = process.argv[2];
if (!authUrl) {
  console.error('Usage: node fly_auth_complete.js <flyctl_auth_url>');
  process.exit(1);
}

console.log('[fly-auth] Starting auth flow for:', authUrl);

(async () => {
  const exePath = process.env.PUPPETEER_EXECUTABLE_PATH || await puppeteer.executablePath();
  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath: exePath,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--window-size=1400,900',
      '--ignore-certificate-errors',
      '--disable-blink-features=AutomationDetected',
      '--disable-web-security',
      '--disable-features=LocalNetworkAccessControl'
    ]
  });

  let completed = false;
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

  // Listen for navigation
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) {
      console.log('[fly-auth] Navigated to:', frame.url());
    }
  });

  page.on('console', (msg) => {
    if (msg.type() === 'error') console.log('[page error]:', msg.text());
  });

  try {
    console.log('[fly-auth] Navigating to auth URL...');
    await page.goto(authUrl, { waitUntil: 'networkidle2', timeout: 30000 });

    // Step 1: Check if we're on a login page (email/password form)
    console.log('[fly-auth] Page title:', await page.title());
    const currentUrl = page.url();
    console.log('[fly-auth] Current URL:', currentUrl);

    // Try to find and fill email field
    const emailSelectors = [
      'input[name="email"]',
      'input[name="username"]',
      'input[type="email"]',
      'input[id*="email"]',
      'input[id*="Email"]',
      'input[name="emailOrPhone"]',
      'input[name="emailOrUsername"]'
    ];

    let emailField = null;
    for (const sel of emailSelectors) {
      try {
        await page.waitForSelector(sel, { visible: true, timeout: 3000 });
        emailField = await page.$(sel);
        console.log('[fly-auth] Found email field with selector:', sel);
        break;
      } catch (e) { /* try next selector */ }
    }

    if (emailField) {
      console.log('[fly-auth] Filling email...');
      await emailField.type(EMAIL, { delay: 50 });

      // Find password field
      try {
        await page.waitForSelector('input[name="password"], input[type="password"]', { visible: true, timeout: 10000 });
        const pwdField = await page.$('input[name="password"], input[type="password"]');
        console.log('[fly-auth] Filling password...');
        await pwdField.type(PASSWORD, { delay: 50 });

        // Find and click login/submit button
        const clicked = await page.evaluate(() => {
          const btns = Array.from(document.querySelectorAll('button, input[type="submit"]'));
          for (const b of btns) {
            const text = (b.textContent || b.value || '').toLowerCase();
            if (text.includes('log') || text.includes('sign') || text.includes('continue') || text.includes('next') || text.includes('login')) {
              b.click();
              return { found: true, text: text.substring(0, 30) };
            }
          }
          return { found: false };
        });
        console.log('[fly-auth] Submit clicked:', JSON.stringify(clicked));

        // Wait for navigation after login
        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
        console.log('[fly-auth] After login, URL:', page.url());
      } catch (e) {
        console.log('[fly-auth] Password field error:', e.message);
      }
    } else {
      console.log('[fly-auth] No email/password form found. May be already logged in or using OAuth.');
    }

    // Step 2: Check if we're on an authorization/consent page
    // Fly.io shows a page with "Authorize" button after login
    await new Promise(resolve => setTimeout(resolve, 3000));

    try {
      const authClicked = await page.evaluate(() => {
        // Look for authorize/allow buttons
        const btns = Array.from(document.querySelectorAll('button'));
        for (const b of btns) {
          const text = (b.textContent || '').trim().toLowerCase();
          if (text.includes('authorize') || text.includes('allow') || text.includes('approve') || text.includes('confirm') || text.includes('continue') || text.includes('connect')) {
            b.click();
            return { found: true, text: text.substring(0, 30) };
          }
        }
        // Also try input[type="submit"]
        const submits = Array.from(document.querySelectorAll('input[type="submit"]'));
        for (const s of submits) {
          const text = (s.value || '').toLowerCase();
          if (text.includes('authorize') || text.includes('allow') || text.includes('approve') || text.includes('continue') || text.includes('connect')) {
            s.click();
            return { found: true, text: text.substring(0, 30) };
          }
        }
        return { found: false };
      });
      console.log('[fly-auth] Auth button clicked:', JSON.stringify(authClicked));
    } catch (e) {
      console.log('[fly-auth] Auth button error:', e.message);
    }

    // Step 3: Wait for success indication
    // The page should show "Your account has been authorized" or similar
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Check if we're on a success page
    const pageContent = await page.content();
    const successIndicators = ['authorized', 'successfully', 'connected', 'success', 'verified'];
    const success = successIndicators.some(indicator =>
      pageContent.toLowerCase().includes(indicator)
    );

    console.log('[fly-auth] Success indicators found:', success);
    console.log('[fly-auth] Final URL:', page.url());

    // Take a screenshot for debugging
    await page.screenshot({ path: '/tmp/fly_auth_result.png' });

    completed = true;
    console.log('[fly-auth] Auth flow completed');

  } catch (e) {
    console.error('[fly-auth] Error:', e.message);
    // Take screenshot on error
    try {
      await page.screenshot({ path: '/tmp/fly_auth_error.png' });
    } catch (e2) {}
  } finally {
    if (!completed) {
      console.log('[fly-auth] Taking emergency screenshot...');
      try {
        await page.screenshot({ path: '/tmp/fly_auth_emergency.png' });
      } catch (e) {}
    }
    await browser.close();
  }

  process.exit(0);
})();
