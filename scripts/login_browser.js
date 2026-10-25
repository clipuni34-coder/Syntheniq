const puppeteer = require('puppeteer');
const fs = require('fs');

const OUTPUT_FILE = '/tmp/fb999_login_response.json';
const LOGIN_URL = 'https://fb999.com/#/login';
const API_HOST = 'fb999api.com';
const CHROME_PATH = process.env.PUPPETEER_CHROME || 
  '/tmp/kilo-worktrees/7d9ea8c271d620db7d7041a95206014c8bef6000117fc15d4d157608f2c3e186/.cache/puppeteer/chrome/linux-156.0.8078.47/chrome-linux64/chrome';

const PHONE_FULL = '2349121493739';
const PASSWORD = 'Drewziwugod6';

function toLocalNumber(full) {
  const n = String(full || '').replace(/\s+/g, '').replace(/^\+/, '');
  return n.startsWith('234') ? n.slice(3) : n;
}

function waitForLoginResponse(page, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out after ${timeoutMs}ms waiting for POST /Login response`)),
      timeoutMs
    );
    page.on('response', async res => {
      try {
        if (res.request().method() !== 'POST') return;
        const url = res.url();
        if (!url.includes(API_HOST) || !url.endsWith('/Login')) return;
        let reqBody = '';
        try { reqBody = res.request().postData() || ''; } catch (e) { reqBody = ''; }
        if (!reqBody || !reqBody.includes('username')) return;  // skip empty-body dup
        clearTimeout(timer);
        let body = '';
        try { body = await res.text(); } catch (e) { body = ''; }
        let json = null, parseError = null;
        try { json = body ? JSON.parse(body) : null; } catch (e) { parseError = e.message; }
        resolve({ status: res.status(), method: 'POST', url, body, json, parseError, reqBody });
      } catch (e) { /* keep listening */ }
    });
  });
}

(async () => {
  const LOCAL_NUMBER = toLocalNumber(PHONE_FULL);
  console.log('=== fb999.com Browser Login ===\n');
  console.log('Phone (full) :', PHONE_FULL);
  console.log('Phone (local):', LOCAL_NUMBER, '(+234 Nigeria pre-selected)');
  console.log('Password     :', '*'.repeat(PASSWORD.length));
  console.log('Chrome       :', CHROME_PATH, '\n');

  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath: CHROME_PATH,
    ignoreHTTPSErrors: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--window-size=414,896', '--ignore-certificate-errors',
      '--disable-blink-features=AutomationDetected'],
  });

  const page = await browser.newPage();
  await page.setUserAgent(
    'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1'
  );
  await page.setViewport({ width: 414, height: 896, isMobile: true });

  let loginRequests = [];
  page.on('request', req => {
    try {
      const url = req.url();
      if (url.includes(API_HOST) && url.includes('/Login')) {
        loginRequests.push({ method: req.method(), url, postData: req.postData() || '', headers: req.headers() });
      }
    } catch (e) {}
  });
  page.on('console', msg => console.log(`[page ${msg.type()}] ${msg.text()}`));
  page.on('dialog', async d => {
    console.log(`[dialog ${d.type()}] ${d.message().substring(0, 200)}`);
    await d.dismiss().catch(() => {});
  });

  try {
    console.log('1. Navigating to', LOGIN_URL);
    await page.goto(LOGIN_URL, { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 3000));

    const activeTab = await page.evaluate(() => {
      const tabs = Array.from(document.querySelectorAll('.login_container-tab .tab, .tab'));
      return tabs.map(t => ({ text: (t.textContent || '').trim(), active: t.classList.contains('active'), visible: t.offsetParent !== null }));
    });
    console.log('2. Tabs:', JSON.stringify(activeTab));

    console.log('3. Filling credentials...');
    await page.waitForSelector('input[name="userNumber"], input[name="username"]', { visible: true, timeout: 10000 });
    const userField = await page.$('input[name="userNumber"]') || await page.$('input[name="username"]');
    if (userField) {
      await userField.click({ clickType: 'click' });
      await userField.type(LOCAL_NUMBER, { delay: 60 });
      console.log('   Typed local number:', LOCAL_NUMBER);
    } else {
      console.log('   !! No userNumber/username field found');
    }

    const pwdHandle = await page.waitForSelector('input[type="password"]', { visible: true, timeout: 10000 });
    await pwdHandle.click();
    await pwdHandle.type(PASSWORD, { delay: 60 });
    console.log('   Typed password');

    console.log('4. Waiting for "Log in" button...');
    await page.waitForFunction(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      return btns.some(b => {
        const r = b.getBoundingClientRect();
        const s = window.getComputedStyle(b);
        return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'
          && b.offsetParent !== null && /log\s*in/i.test(b.textContent || '');
      });
    }, { timeout: 20000 });

    const clicked = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      for (const b of btns) {
        const r = b.getBoundingClientRect();
        const s = window.getComputedStyle(b);
        const visible = r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && b.offsetParent !== null;
        if (!visible) continue;
        if (/log\s*in/i.test(b.textContent || '')) {
          b.click();
          return { found: true, text: b.textContent.trim() };
        }
      }
      return { found: false };
    });
    console.log('   Submit clicked:', JSON.stringify(clicked));
    if (!clicked.found) {
      console.log('   !! No visible "Log in" button — aborting.');
      await browser.close();
      process.exit(2);
    }

    console.log('5. Waiting for /Login API response (up to 60s) ...');
    let resp;
    try {
      resp = await waitForLoginResponse(page, 60000);
      console.log('   -> /Login response received: HTTP', resp.status);
    } catch (e) {
      console.log('   ->', e.message);
    }

    console.log('\n=== /Login REQUEST ===');
    for (const r of loginRequests) {
      console.log('POST', r.url);
      console.log('Body :', r.postData);
    }

    if (resp) {
      console.log('\n=== /Login RESPONSE ===');
      console.log('HTTP status:', resp.status);
      console.log('Body (first 1000):', (resp.body || '').substring(0, 1000));
      if (resp.json) {
        console.log('Parsed JSON:', JSON.stringify(resp.json).substring(0, 800));
        if (resp.json.data?.token) {
          console.log('\n=== ✓ LOGIN SUCCESS ===');
          fs.writeFileSync(OUTPUT_FILE, JSON.stringify(resp.json, null, 2));
          console.log('Saved full response to', OUTPUT_FILE);
        }
      }
    } else {
      console.log('\nNo /Login HTTP response captured. Saving current login response file if any.');
    }

    const storage = await page.evaluate(() => {
      const result = {};
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key) result[key] = localStorage.getItem(key);
      }
      return result;
    });
    console.log('\nlocalStorage keys:', Object.keys(storage).join(', '));

    await browser.close();

    // If response didn't have token but localStorage has ar_token, save that
    if (resp && resp.json && resp.json.data?.token) {
      process.exit(0);
    }

    // Fallback: if we have ar_token in localStorage, construct the response
    if (storage.ar_token) {
      console.log('\n=== Found ar_token in localStorage, constructing response ===');
      const constructed = {
        data: {
          tokenHeader: 'Bearer ',
          token: storage.ar_token,
          refreshToken: storage.refreshToken || loginRefresh || '',
          webSocketUrl: storage.ar_ws_url || '',
          webSocketChannels: storage.ar_ws_channels ? JSON.parse(storage.ar_ws_channels) : [],
        },
        code: 0,
        msg: 'Succeed (from localStorage)',
      };
      fs.writeFileSync(OUTPUT_FILE, JSON.stringify(constructed, null, 2));
      console.log('Saved constructed response to', OUTPUT_FILE);
      process.exit(0);
    }

    console.log('\nLogin did not yield a token.');
    process.exit(3);
  } catch (err) {
    console.error('\nFatal error:', err.message);
    try { await browser.close(); } catch (e) {}
    process.exit(1);
  }
})();
