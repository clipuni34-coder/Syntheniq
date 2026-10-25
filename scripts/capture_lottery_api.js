const puppeteer = require('puppeteer');
const fs = require('fs');

const login = JSON.parse(fs.readFileSync('/tmp/fb999_login_response.json', 'utf8'));
const lotteryToken = new URL(login.data.lotteryLoginUrl).searchParams.get('Token');

const CHROME_PATH = '/tmp/kilo-worktrees/7d9ea8c271d620db7d7041a95206014c8bef6000117fc15d4d157608f2c3e186/.cache/puppeteer/chrome/linux-156.0.8078.47/chrome-linux64/chrome';

(async () => {
  console.log('=== Capturing Lottery API requests ===\n');

  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath: CHROME_PATH,
    ignoreHTTPSErrors: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--window-size=414,896', '--ignore-certificate-errors',
      '--disable-blink-features=AutomationDetected'],
  });

  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1');
  await page.setViewport({ width: 414, height: 896, isMobile: true });

  const allRequests = [];
  page.on('request', req => {
    const url = req.url();
    if (url.includes('ar-lottery') && (url.includes('/api/') || url.includes('/Lottery/') || url.includes('/WinGo'))) {
      allRequests.push({
        method: req.method(),
        url: url,
        body: req.postData() || '',
      });
      console.log(`[REQ] ${req.method()} ${url.replace(/https?:\/\/[^/]+/, '')}`);
    }
  });
  page.on('response', async res => {
    const url = res.url();
    if (url.includes('ar-lottery') && (url.includes('/api/') || url.includes('/Lottery/') || url.includes('/WinGo'))) {
      try {
        const body = await res.text();
        console.log(`[RESP ${res.status()}] ${url.replace(/https?:\/\/[^/]+/, '')} -> ${body.substring(0, 200)}`);
      } catch(e) {}
    }
  });
  page.on('console', msg => {
    const txt = msg.text();
    if (txt.includes('Win') || txt.includes('lottery') || txt.includes('error') || txt.toLowerCase().includes('token') || txt.toLowerCase().includes('sign')) {
      console.log(`[console] ${txt.substring(0, 200)}`);
    }
  });
  page.on('pageerror', err => console.log('[pageerror]', err.message.substring(0, 200)));

  // Visit the lottery login URL
  const url = login.data.lotteryLoginUrl;
  console.log('1. Visiting lottery app:', url.substring(0, 80) + '...');
  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
  } catch(e) {
    console.log('  Navigation error (continuing):', e.message);
  }
  await new Promise(r => setTimeout(r, 8000));

  // Check localStorage for ar_token
  const storage = await page.evaluate(() => {
    const result = {};
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key) result[key] = localStorage.getItem(key);
    }
    return result;
  });
  console.log('\n2. localStorage keys:', Object.keys(storage).join(', '));
  if (storage.ar_token) console.log('ar_token found:', storage.ar_token.substring(0, 60) + '...');
  if (storage.ar_api) console.log('ar_api:', storage.ar_api);
  if (storage.token) console.log('token:', storage.token.substring(0, 60) + '...');

  // Try to find WinGo game and click it
  console.log('\n3. Looking for WinGo navigation...');
  const navResult = await page.evaluate(() => {
    const results = [];
    const all = Array.from(document.querySelectorAll('button, a, div, [role="button"]'));
    for (const el of all) {
      const text = (el.textContent || '').trim().substring(0, 30);
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0 && /win|lottery|game|vgold|30s/i.test(text.toLowerCase())) {
        results.push({ text, tag: el.tagName, class: el.className.substring(0, 50) });
      }
    }
    return results.slice(0, 20);
  });
  console.log('   Nav elements found:', navResult.length);
  for (const n of navResult.slice(0, 10)) console.log('   ', JSON.stringify(n));

  // Wait for any additional requests
  console.log('\n4. Waiting 5s for async requests...');
  await new Promise(r => setTimeout(r, 5000));

  // Print all captured requests
  console.log('\n=== ALL CAPTURED REQUESTS ===');
  for (const r of allRequests) {
    console.log(`${r.method} ${r.url}`);
    if (r.body) console.log(`  body: ${r.body.substring(0, 200)}`);
  }

  // Save localStorage
  fs.writeFileSync('/tmp/lottery_storage.json', JSON.stringify(storage, null, 2));

  await browser.close();
  console.log('\nDone.');
})().catch(async (e) => {
  console.error('Fatal:', e.message);
  try { await browser.close(); } catch(_){}
  process.exit(1);
});
