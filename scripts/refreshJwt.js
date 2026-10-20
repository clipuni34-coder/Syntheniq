/**
 * refreshJwt.js
 * Refreshes an expired fb999.com JWT by driving the real browser login flow
 * with puppeteer (avoids raw-API lockout), then persists the full /Login
 * response to /tmp/fb999_login_response.json and extracts the localStorage
 * websocket config (ar_token, ar_ws_url, ar_ws_channels).
 *
 * Single, clean login attempt — no retries (protects against the 10-error
 * API lockout mentioned in the task context).
 *
 * Override credentials via env:  FB999_PHONE / FB999_PASSWORD
 */
const puppeteer = require('puppeteer');
const fs = require('fs');

const OUTPUT_FILE = '/tmp/fb999_login_response.json';
const SUMMARY_FILE = '/tmp/fb999_jwt_refresh_result.json';
const LOGIN_URL = 'https://fb999.com/#/login';
const API_HOST = 'fb999api.com';

// Credentials. Password does NOT contain '@' (user confirmed: Drewziwugod6).
const PHONE_FULL = process.env.FB999_PHONE || '2349121493739';
const PASSWORD = process.env.FB999_PASSWORD || 'Drewziwugod6';

// The login form has a +234 (Nigeria) country-code selector (readonly) plus a
// local-number field named `userNumber`. The SPA sends userNumber =
// countryCode + localNumber to the /Login API. So we type only the local part,
// producing userNumber="2349121493739" in the request.
function toLocalNumber(full) {
  const n = String(full || '').replace(/\s+/g, '').replace(/^\+/, '');
  return n.startsWith('234') ? n.slice(3) : n;
}

// Resolves on the first POST /Login response (skips the OPTIONS CORS preflight,
// whose body cannot be read and threw "preflight request" in earlier runs).
function waitForLoginResponse(page, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out after ${timeoutMs}ms waiting for POST /Login response`)),
      timeoutMs
    );
     page.on('response', async res => {
       try {
         if (res.request().method() !== 'POST') return;           // ignore OPTIONS preflight
         const url = res.url();
         if (!url.includes(API_HOST) || !url.endsWith('/Login')) return;
         // The page emits a duplicate, empty-bodied POST to /Login (the password
         // field sits outside any <form>, so a native submit fires an empty
         // request that the server rejects as "Wrong account or password"). Skip
         // such responses so we match the real, credential-bearing attempt only.
         let reqBody = '';
         try { reqBody = res.request().postData() || ''; } catch (e) { reqBody = ''; }
         if (!reqBody || !reqBody.includes('username')) return;   // ignore empty-body dup
         clearTimeout(timer);
         let body = '';
         try { body = await res.text(); } catch (e) { body = ''; } // 204 / no-body safe
        let json = null, parseError = null;
        try { json = body ? JSON.parse(body) : null; } catch (e) { parseError = e.message; }
        resolve({ status: res.status(), method: 'POST', url, body, json, parseError });
      } catch (e) {
        /* keep listening */
      }
    });
  });
}

(async () => {
  const LOCAL_NUMBER = toLocalNumber(PHONE_FULL);

  console.log('=== fb999.com JWT Refresh (browser login) ===\n');
  console.log('Phone (full E.164) :', PHONE_FULL);
  console.log('Phone (local)      :', LOCAL_NUMBER, '(+234 Nigeria is pre-selected)');
  console.log('Password           :', '*'.repeat(PASSWORD.length), `(${PASSWORD.length} chars, contains "@")`);
  console.log('Login type         : mobile (phone-number tab)\n');

  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath: '/usr/bin/chromium',
    ignoreHTTPSErrors: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--window-size=414,896',
      '--ignore-certificate-errors',
      '--disable-blink-features=AutomationDetected,IsolateOrigins,IOSurfaceSharing',
    ],
  });

  const page = await browser.newPage();
  await page.setUserAgent(
    'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1'
  );
  await page.setViewport({ width: 414, height: 896, isMobile: true });

  // Capture the actual /Login request body the form sends (verifies creds).
  let loginRequests = [];
  page.on('request', req => {
    try {
      const url = req.url();
      if (url.includes(API_HOST) && url.endsWith('/Login')) {
        loginRequests.push({
          method: req.method(),
          url,
          postData: req.postData() || '',
          headers: req.headers(),
        });
      }
    } catch (e) {}
  });

  // Surface page console / dialogs for diagnostics.
  page.on('console', msg => console.log(`[page ${msg.type()}] ${msg.text()}`));
  page.on('dialog', async d => {
    console.log(`[dialog ${d.type()}] ${d.message().substring(0, 200)}`);
    await d.dismiss().catch(() => {});
  });

  try {
    // 1. Navigate to the login page (phone tab is active by default).
    console.log('1. Navigating to', LOGIN_URL);
    await page.goto(LOGIN_URL, { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 3000));

    const activeTab = await page.evaluate(() => {
      const tabs = Array.from(document.querySelectorAll('.login_container-tab .tab'));
      return tabs.map(t => ({
        text: (t.textContent || '').trim(),
        active: t.classList.contains('active'),
      }));
    });
    console.log('2. Login tabs:', JSON.stringify(activeTab));

    // 2. Fill local phone number into userNumber (unique selector).
    console.log('3. Filling credentials...');
    await page.waitForSelector('input[name="userNumber"]', { visible: true, timeout: 10000 });
    await page.click('input[name="userNumber"]');
    await page.type('input[name="userNumber"]', LOCAL_NUMBER, { delay: 40 });
    console.log('   Typed local number:', LOCAL_NUMBER);

    // 3. Fill password (first VISIBLE password input — the mobile-tab one).
    const pwdHandle = await page.waitForSelector('input[type="password"]', { visible: true, timeout: 10000 });
    await pwdHandle.click();
    await pwdHandle.type(PASSWORD, { delay: 40 });
    console.log('   Typed password (with @)');

    // 4. Click the visible "Log in" button.
    // The login form buttons render asynchronously and aren't guaranteed to
    // carry type="submit", so we wait for a visible button whose text matches
    // /log in/ and click it.
    console.log('4. Waiting for the "Log in" button...');
    await page.waitForFunction(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      return btns.some(b => {
        const r = b.getBoundingClientRect();
        const s = window.getComputedStyle(b);
        return r.width > 0 && r.height > 0
          && s.visibility !== 'hidden' && s.display !== 'none'
          && b.offsetParent !== null
          && /log\s*in/i.test(b.textContent || '');
      });
    }, { timeout: 20000 });

    const clicked = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      for (const b of btns) {
        const r = b.getBoundingClientRect();
        const s = window.getComputedStyle(b);
        const visible = r.width > 0 && r.height > 0
          && s.visibility !== 'hidden' && s.display !== 'none'
          && b.offsetParent !== null;
        if (!visible) continue;
        if (/log\s*in/i.test(b.textContent || '')) {
          b.click();
          return { found: true, text: b.textContent.trim(), className: b.className };
        }
      }
      return { found: false };
    });
    console.log('   Submit clicked:', JSON.stringify(clicked));
    if (!clicked.found) {
      console.log('   !! No visible "Log in" button found — aborting to avoid lockout.');
      await browser.close();
      process.exit(2);
    }

    // 5. Wait for the /Login API response (single attempt, 60s).
    console.log('5. Waiting for /Login API response (single attempt, up to 60s) ...');
    let resp;
    try {
      resp = await waitForLoginResponse(page, 60000);
      console.log('   -> /Login response received:', resp.status);
    } catch (e) {
      console.log('   ->', e.message);
    }

    // Show the actual request body the form sent (verifies userNumber/pwd/loginType).
    console.log('\n=== /Login REQUEST (as sent by the browser) ===');
    if (loginRequests.length === 0) {
      console.log('   (no /Login request captured)');
    }
    for (const r of loginRequests) {
      console.log('POST', r.url);
      console.log('Body :', r.postData);
    }

    // Allow the SPA to finish setting localStorage after the response.
    await new Promise(r => setTimeout(r, 4000));

    // 6. Read localStorage (authoritative browser-side storage).
    const storage = await page.evaluate(() => {
      const result = {};
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key) result[key] = localStorage.getItem(key);
      }
      return result;
    });
    console.log('\n=== localStorage (after login) ===');
    console.log('Keys:', Object.keys(storage).join(', '));

    // 7. Extract target fields (response first, then localStorage cross-check).
    let token = null, refreshToken = null, wsUrl = null, wsChannels = null, loginSuccess = false;
    let source = {};

    if (resp && resp.json && resp.json.data) {
      const d = resp.json.data;
      token = d.token || d.jwt || d.accessToken;
      refreshToken = d.refreshToken;
      wsUrl = d.webSocketUrl;
      wsChannels = d.webSocketChannels || d.channels;
      source.response = { token: !!token, refreshToken: !!refreshToken, webSocketUrl: !!wsUrl, webSocketChannels: !!wsChannels };
      loginSuccess = !!token;
      console.log('\n=== Login response (data) ===');
      console.log('token           :', token ? (token.substring(0, 40) + '...[' + token.length + 'chars]') : '(none)');
      console.log('refreshToken    :', refreshToken ? (refreshToken.substring(0, 40) + '...') : '(none)');
      console.log('webSocketUrl    :', wsUrl || '(none)');
      console.log('webSocketChannels:', JSON.stringify(wsChannels || null));
      console.log('code/msg        :', resp.json.code, resp.json.msg || '');
    } else if (resp) {
      console.log('\n=== Login response (raw) ===');
      console.log('HTTP status:', resp.status);
      console.log('Body (first 800):', (resp.body || '').substring(0, 800));
      if (resp.json) console.log('Parsed JSON:', JSON.stringify(resp.json).substring(0, 600));
    } else {
      console.log('\nNo HTTP /Login response was captured.');
    }

    // Cross-check with localStorage.
    const arToken = storage.ar_token;
    const arWsUrl = storage.ar_ws_url;
    let arWsChannels = storage.ar_ws_channels;
    if (arWsChannels) {
      try { arWsChannels = JSON.parse(arWsChannels); } catch { /* keep raw */ }
    }
    console.log('\n=== localStorage keys (relevant) ===');
    console.log('ar_token       :', arToken ? (arToken.substring(0, 40) + '...[' + arToken.length + 'chars]') : '(none)');
    console.log('ar_ws_url      :', arWsUrl || '(none)');
    console.log('ar_ws_channels :', JSON.stringify(arWsChannels || null));

    // Prefer localStorage values (they are exactly what downstream ws clients use),
    // fall back to the API response.
    if (arToken) { token = arToken; source.localStorage = true; }
    if (arWsUrl) wsUrl = arWsUrl;
    if (arWsChannels !== null && arWsChannels !== undefined) wsChannels = arWsChannels;
    loginSuccess = !!(token || (resp && resp.json && resp.json.data && resp.json.data.token));

    // 8. Persist the FULL login response JSON to the canonical file.
    let toSave = null;
    if (resp && resp.json) {
      toSave = resp.json;
    } else if (resp && resp.body) {
      try { toSave = JSON.parse(resp.body); } catch { toSave = { raw: resp.body }; }
    } else {
      toSave = { error: 'No /Login response captured', localStorage: storage };
    }
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(toSave, null, 2));
    console.log('\n9. Full login response saved to', OUTPUT_FILE);

    // Persistence summary for easy consumption by websocket tooling.
    const result = {
      loginSuccess,
      token: token || null,
      refreshToken: refreshToken || null,
      wsUrl: wsUrl || null,
      wsChannels: wsChannels || null,
      tokenSource: source,
      phoneFull: PHONE_FULL,
      loginType: 'mobile',
      capturedRequests: loginRequests.map(r => ({ url: r.url, body: r.postData })),
      localStorageKeys: Object.keys(storage),
      savedResponseFile: OUTPUT_FILE,
      savedAt: new Date().toISOString(),
    };
    fs.writeFileSync(SUMMARY_FILE, JSON.stringify(result, null, 2));
    console.log('   Refresh result summary saved to', SUMMARY_FILE);

    console.log('\n=== RESULT ===');
    console.log('Login success :', loginSuccess ? 'YES' : 'NO');
    if (token) console.log('ar_token (JWT) :', token.substring(0, 40) + '...[' + token.length + ' chars]');
    if (wsUrl) console.log('ar_ws_url      :', wsUrl);
    if (wsChannels) console.log('ar_ws_channels :', JSON.stringify(wsChannels));

    await browser.close();
    process.exit(loginSuccess ? 0 : 3);
  } catch (err) {
    console.error('\nFatal error:', err.message);
    try { await browser.close(); } catch (e) {}
    process.exit(1);
  }
})();
