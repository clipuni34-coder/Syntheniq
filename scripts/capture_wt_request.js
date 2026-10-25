const puppeteer = require('puppeteer');
const fs = require('fs');

const CHROME_PATH = process.env.PUPPETEER_CHROME || 
  '/tmp/kilo-worktrees/7d9ea8c271d620db7d7041a95206014c8bef6000117fc15d4d157608f2c3e186/.cache/puppeteer/chrome/linux-156.0.8078.47/chrome-linux64/chrome';
const login = JSON.parse(fs.readFileSync('/tmp/fb999_login_response.json', 'utf8'));
const JWT = login.data?.token;

(async () => {
  console.log('=== Capturing GetWinTheLotteryResult request via real app ===\n');
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

  // Capture all API requests
  const apiRequests = [];
  page.on('request', req => {
    const url = req.url();
    if (url.includes('fb999api.com/api/webapi/')) {
      apiRequests.push({
        method: req.method(),
        url,
        body: req.postData() || '',
        headers: { ...req.headers() },
      });
      if (url.includes('GetWinTheLotteryResult')) {
        console.log('\n>>> CAPTURED GetWinTheLotteryResult REQUEST <<<');
        console.log('URL:', url);
        console.log('Body:', req.postData() || '(empty)');
        console.log('Auth:', req.headers().authorization || 'NOT SET');
        console.log('Content-Type:', req.headers()['content-type'] || 'NOT SET');
      }
    }
  });
  page.on('response', async res => {
    const url = res.url();
    if (url.includes('fb999api.com/api/webapi/') && res.status() === 200) {
      try {
        let body = await res.text();
        if (url.includes('GetWinTheLotteryResult') || url.includes('GetGameIssue') || url.includes('GetLastFive')) {
          console.log(`\n<<< RESPONSE ${url} >>>`);
          console.log('Status:', res.status());
          console.log('Body:', body.substring(0, 600));
        }
      } catch(e) {}
    }
  });
  page.on('console', msg => {
    const txt = msg.text();
    if (txt.includes('Win') || txt.includes('lottery') || txt.includes('error') || txt.includes('Error')) {
      console.log(`[page console] ${txt}`);
    }
  });
  page.on('pageerror', err => console.log('[pageerror]', err.message.substring(0, 200)));

  // Set the JWT token in localStorage before navigating
  await page.evaluateOnNewDocument((token, tr) => {
    try {
      localStorage.setItem('token', token);
      localStorage.setItem('tokenHeader', 'Bearer ');
      localStorage.setItem('refreshToken', tr);
    } catch(e) {}
  }, JWT, login.data.refreshToken || '');

  console.log('1. Navigating to app...');
  await page.goto('https://fb999.com/', { waitUntil: 'networkidle2', timeout: 30000 });
  await new Promise(r => setTimeout(r, 4000));

  // Take a screenshot
  await page.screenshot({ path: '/tmp/app_homepage.png', fullPage: false });

  console.log('2. All api/webapi requests captured so far:', apiRequests.length);
  for (const r of apiRequests) {
    console.log(`   ${r.method} ${r.url.replace('https://fb999api.com/api/webapi/', '')}`);
  }

  // Try clicking into the WinGo game / Lottery section
  console.log('\n3. Looking for WinGo/Lottery navigation...');
  const navResult = await page.evaluate(() => {
    const results = [];
    const clicks = [
      ...document.querySelectorAll('tabbar a, .tabbar-item, button, .nav-item'),
      ...document.querySelectorAll('img[alt*="WinGo" i], img[alt*="lottery" i], img[alt*="Lottery" i]')
    ];
    clicks.forEach((el, i) => {
      const text = (el.textContent || '').trim().substring(0, 40);
      const rect = el.getBoundingClientRect();
      results.push({ idx: i, tag: el.tagName, text, visible: rect.width > 0 && rect.height > 0, className: el.className.substring(0, 60) });
    });
    return results.slice(0, 40);
  });
  console.log('   Elements found:', navResult.filter(e => e.visible).length, 'visible');
  navResult.filter(e => e.visible).slice(0, 15).forEach(e => console.log(`   [${e.idx}] <${e.tag}> "${e.text}" class=${e.className}`));

  // Try to find and click navigation to WinGo
  const clicked = await page.evaluate(() => {
    const selectors = [
      '[data-code="WinGo"]', '.WinGo', 'a[href*="wingo"]', 'a[href*="WinGo"]',
      'button:contains("WinGo")', '[class*="win-go"]', '[class*="wingo"]',
    ];
    // Try text-based search
    const allEls = Array.from(document.querySelectorAll('button, a, div'));
    for (const el of allEls) {
      const text = (el.textContent || '').toLowerCase();
      if ((text.includes('wingo') || text.includes('win go') || text.includes('lottery')) && el.offsetParent !== null) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          const info = { text: el.textContent.trim().substring(0, 40), tag: el.tagName, class: el.className.substring(0,60) };
          el.click();
          return info;
        }
      }
    }
    return null;
  });
  console.log('\n4. Clicked nav element:', clicked ? JSON.stringify(clicked) : 'none found');
  await new Promise(r => setTimeout(r, 5000));

  console.log('\n5. Final captured requests:');
  const wtReqs = apiRequests.filter(r => r.url.includes('GetWinTheLotteryResult'));
  console.log('   GetWinTheLotteryResult requests:', wtReqs.length);
  for (const r of wtReqs) {
    console.log('   Body:', r.body);
  }

  await browser.close();
  console.log('\nDone.');
})().catch(async (e) => {
  console.error('Fatal:', e.message);
  try { await browser.close(); } catch(_){}
  process.exit(1);
});
