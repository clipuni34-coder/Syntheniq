const puppeteer = require('puppeteer');
const fs = require('fs');

(async () => {
  console.log('=== Diagnostic: Inspect login page & capture Login API ===\n');

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=414,896',
           '--ignore-certificate-errors'],
    ignoreHTTPSErrors: true,
  });

  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1');

  const allRequests = [];

  page.on('request', req => {
    const url = req.url();
    if (url.includes('fb999api.com')) {
      const data = {
        method: req.method(),
        url: url,
        body: req.postData() || '',
        headers: req.headers(),
      };
      allRequests.push(data);
    }
  });

  page.on('response', async res => {
    try {
      const url = res.url();
      if (url.includes('fb999api.com') && (url.includes('/Login') || url.includes('Login'))) {
        const body = await res.text();
        console.log(`\n[RESPONSE] ${res.status()} ${url}`);
        console.log(`Response body: ${body.substring(0, 1000)}`);
        fs.writeFileSync('/tmp/fb999_login_response.json', body);
      }
    } catch(e) {}
  });

  page.on('console', msg => console.log(`[console ${msg.type()}] ${msg.text()}`));

  console.log('1. Navigating to /#/login...');
  await page.goto('https://fb999.com/#/login', { waitUntil: 'networkidle2', timeout: 30000 });

  // Wait for SPA to fully render
  console.log('2. Waiting for SPA render...');
  await page.waitForFunction(() => {
    const inputs = document.querySelectorAll('input[name="userNumber"], input[name="userEmail"]');
    return inputs.length > 0;
  }, { timeout: 15000 });
  await new Promise(r => setTimeout(r, 2000));

  // Comprehensive button inspection
  console.log('3. Inspecting all buttons on page:');
  const allButtons = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    return btns.map((btn, i) => {
      const rect = btn.getBoundingClientRect();
      return {
        index: i,
        text: btn.textContent.trim(),
        class: btn.className,
        id: btn.id,
        type: btn.type,
        disabled: btn.disabled,
        innerHTML: btn.innerHTML.substring(0, 200),
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        visible: rect.width > 0 && rect.height > 0,
      };
    });
  });
  console.log(JSON.stringify(allButtons, null, 2));

  // Save screenshot of rendered page
  await page.screenshot({ path: '/tmp/fb999_login_rendered.png', fullPage: true });
  console.log('\nScreenshot saved: /tmp/fb999_login_rendered.png');

  // Check form structure
  const formInfo = await page.evaluate(() => {
    const forms = document.querySelectorAll('form');
    return Array.from(forms).map((f, i) => ({
      index: i,
      id: f.id,
      class: f.className,
      action: f.action,
      method: f.method,
      childCount: f.children.length,
      html: f.innerHTML.substring(0, 500),
    }));
  });
  console.log('\nForms on page:', JSON.stringify(formInfo, null, 2));

  // Check for any Vue components or event handlers
  const vueData = await page.evaluate(() => {
    const appEl = document.getElementById('app');
    if (appEl && appEl._vnode) {
      return { hasVue: true };
    }
    return { hasVue: false, appHTML: appEl ? appEl.innerHTML.substring(0, 300) : null };
  });
  console.log('\nVue app info:', JSON.stringify(vueData, null, 2));

  console.log('\n4. Filling in credentials...');
  try {
    await page.waitForSelector('input[name="userNumber"]', { timeout: 5000 });
    await page.type('input[name="userNumber"]', '9121493739', { delay: 50 });
    console.log('  Typed phone number');

    const passwordFields = await page.$$('input[type="password"]');
    if (passwordFields[0]) {
      await passwordFields[0].type('Drewziwugod6', { delay: 50 });
      console.log('  Typed password into first password field');
    }
  } catch(e) {
    console.log('  Form fill error:', e.message);
  }

  // Try to find the actual submit button more carefully
  // Look for buttons that are inside the login form or have login-related classes
  console.log('\n5. Attempting login via various methods...');

  // Method 1: Click the button closest to the password field
  const loginAttempt1 = await page.evaluate(() => {
    const pwdField = document.querySelector('input[type="password"]');
    if (pwdField) {
      let el = pwdField.closest('form, .login-form, .form-container, div');
      let btn = null;
      let btnText = '';
      while (el) {
        btn = el.querySelector('button');
        if (btn && btn.textContent.trim().toLowerCase().includes('log')) {
          btnText = btn.textContent.trim();
          btn.click();
          return { found: true, text: btnText, method: 'closest-parent' };
        }
        el = el.parentElement;
      }
    }
    return { found: false };
  });
  console.log('  Attempt 1 (closest parent button):', JSON.stringify(loginAttempt1));

  await new Promise(r => setTimeout(r, 3000));

  // Check if we got a request
  const loginReq = allRequests.find(r => r.url.includes('/Login'));
  if (!loginReq) {
    console.log('  No Login request yet. Checking requests so far...');
    console.log('  Requests captured:', allRequests.map(r => `${r.method} ${r.url}`));
  }

  // Method 2: Try clicking each visible button with login text
  const loginAttempt2 = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    for (const btn of btns) {
      const text = btn.textContent.trim().toLowerCase();
      if (text.includes('log in') || text === 'login') {
        const rect = btn.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          const btnText = btn.textContent.trim();
          btn.click();
          return { found: true, text: btnText };
        }
      }
    }
    return { found: false };
  });
  console.log('  Attempt 2 (visible login button):', JSON.stringify(loginAttempt2));

  // Wait longer for any network activity
  console.log('\n6. Waiting 15 seconds for responses...');
  await new Promise(r => setTimeout(r, 15000));

  console.log('\n=== ALL API Requests Captured ===');
  for (const req of allRequests) {
    console.log(`\n[${req.method}] ${req.url}`);
    console.log(`  Body: ${req.body}`);
    console.log(`  Headers:`);
    for (const [key, val] of Object.entries(req.headers)) {
      console.log(`    ${key}: ${val}`);
    }
  }

  console.log('\n=== Login-specific API Requests ===');
  const loginRequests = allRequests.filter(r => r.url.includes('/Login'));
  if (loginRequests.length === 0) {
    console.log('  NONE CAPTURED');
  }
  for (const req of loginRequests) {
    console.log(`\n[${req.method}] ${req.url}`);
    console.log(`  Body: ${req.body}`);
    console.log(`  Auth: ${req.headers.authorization || 'NOT SET'}`);
  }

  // localStorage
  const storage = await page.evaluate(() => {
    const result = {};
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key) result[key] = localStorage.getItem(key);
    }
    return result;
  });
  console.log('\nlocalStorage:', JSON.stringify(storage, null, 2));

  await browser.close();
  console.log('\nDone');
})().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
