const puppeteer = require('puppeteer');
const fs = require('fs');

const login = JSON.parse(fs.readFileSync('/tmp/fb999_login_response.json', 'utf8'));
const JWT = login.data.token;
const lotteryToken = new URL(login.data.lotteryLoginUrl).searchParams.get('Token');
const CHROME_PATH = '/tmp/kilo-worktrees/7d9ea8c271d620db7d7041a95206014c8bef6000117fc15d4d157608f2c3e186/.cache/puppeteer/chrome/linux-156.0.8078.47/chrome-linux64/chrome';

(async () => {
  console.log('=== Navigating fb999 app to WinGo game ===\n');
  const browser = await puppeteer.launch({
    headless: 'new', executablePath: CHROME_PATH, ignoreHTTPSErrors: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--window-size=414,896', '--ignore-certificate-errors',
      '--disable-blink-features=AutomationDetected'],
  });

  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1');
  await page.setViewport({ width: 414, height: 896, isMobile: true });

  // Set tokens in localStorage
  await page.evaluateOnNewDocument((jwt, ltoken) => {
    window.localStorage.setItem('token', jwt);
    window.localStorage.setItem('tokenHeader', 'Bearer ');
    window.localStorage.setItem('ar_token', ltoken);
  }, JWT, lotteryToken);

  const captured = [];
  page.on('request', req => {
    const url = req.url();
    if (url.includes('fb999api.com') || url.includes('ar-lottery06')) {
      const path = url.replace(/^https?:\/\/[^/]+/, '');
      if (path.includes('/api/') || path.includes('/WinGo/') || path.includes('/Lottery/')) {
        captured.push({ method: req.method(), path, body: req.postData() || '', url });
      }
    }
  });
  page.on('response', async res => {
    const url = res.url();
    if (url.includes('fb999api.com') && (url.includes('GetWinTheLottery') || url.includes('GetWinLoss') || url.includes('GetLastFive'))) {
      const body = await res.text();
      console.log(`[RESP] ${res.status()} ${url.replace(/^https?:\/\/[^/]+/, '')}`);
      console.log(`  ${body.substring(0, 500)}`);
    }
  });

  // Try navigating to WinGo game routes
  const routes = [
    '/#/main/WinGo_30S',
    '/#/game/WinGo_30S',
    '/#/lottery/WinGo_30S',
    '/#/WinGo_30S',
  ];

  for (const route of routes) {
    console.log(`Trying route: ${route}`);
    try {
      await page.goto(`https://fb999.com${route}`, { waitUntil: 'networkidle2', timeout: 15000 });
      await new Promise(r => setTimeout(r, 3000));
    } catch(e) { console.log('  error:', e.message); }
  }

  // Also try clicking game list items
  console.log('\nLooking for game list clicks...');
  await page.goto('https://fb999.com', { waitUntil: 'networkidle2', timeout: 20000 });
  await new Promise(r => setTimeout(r, 5000));

  const gameClicks = await page.evaluate(() => {
    const results = [];
    // Look for game categories/lists
    const items = Array.from(document.querySelectorAll('[data-game-code], .game-item, .game-card, .lottery-game, [class*="game"], [class*="lottery"]'));
    items.slice(0, 30).forEach((el, i) => {
      const text = (el.textContent || '').trim().substring(0, 50);
      const code = el.getAttribute('data-game-code') || el.getAttribute('data-code') || '';
      if ((text.toLowerCase().includes('wingo') || text.toLowerCase().includes('win go') || code.includes('WinGo')) && el.offsetParent !== null) {
        results.push({ idx: i, text, code, class: el.className.substring(0, 60) });
      }
    });
    return results;
  });
  console.log('Game items found:', gameClicks.length);
  for (const g of gameClicks.slice(0, 5)) console.log('  ', JSON.stringify(g));

  // Wait and capture
  await new Promise(r => setTimeout(r, 8000));

  console.log('\n=== All API requests captured ===');
  const wingoReqs = captured.filter(r => r.path.includes('WinTheLottery') || r.path.includes('WinLoss') || r.path.includes('GetLastFive'));
  console.log('WinGo-related requests:', wingoReqs.length);
  for (const r of wingoReqs) {
    console.log(`\n${r.method} ${r.path}`);
    if (r.body) console.log('  body:', r.body.substring(0, 300));
  }
  if (wingoReqs.length === 0) {
    console.log('\nNo WinGo result requests captured. Captured endpoints:');
    captured.filter(r => r.path.includes('Get')).slice(0, 20).forEach(r => console.log(`  ${r.method} ${r.path}`));
  }

  await browser.close();
  console.log('\nDone.');
})().catch(async (e) => {
  console.error('Fatal:', e.message);
  try { await browser.close(); } catch(_){}
  process.exit(1);
});
