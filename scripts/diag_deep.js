const puppeteer = require('puppeteer');

(async () => {
  console.log('=== Deep Diagnostic: Exploring fully rendered fb999.com ===\n');

  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath: '/usr/bin/chromium',
    ignoreHTTPSErrors: true,
    defaultArgs: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--window-size=414,896', '--ignore-certificate-errors'],
    args: ['--disable-blink-features=AutomationDetected', '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--ignore-certificate-errors']
  });

  const page = await browser.newPage();
  const iPhone = puppeteer.KnownDevices['iPhone 12'];
  await page.emulate(iPhone);
  await page.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1');

  // Track all requests
  page.on('request', request => {
    if (request.url().includes('/api/webapi/')) {
      console.log(`[API] ${request.method()} ${request.url()}`);
    }
  });

  await page.goto('https://fb999.com', { waitUntil: 'networkidle2', timeout: 30000 });

  // Wait for Vue app to render - wait for common patterns
  console.log('Waiting for app to render...');
  await new Promise(r => setTimeout(r, 5000));

  console.log('Current URL:', page.url());
  console.log('Page title:', await page.title());

  // Count total elements on page
  const counts = await page.evaluate(() => {
    return {
      totalElements: document.querySelectorAll('*').length,
      buttons: document.querySelectorAll('button').length,
      inputs: document.querySelectorAll('input').length,
      links: document.querySelectorAll('a').length,
      divs: document.querySelectorAll('div').length,
      bodyHTMLLength: document.body.innerHTML.length
    };
  });
  console.log('\n=== Element counts ===');
  console.log(JSON.stringify(counts, null, 2));

  // Dump ALL clickable elements (buttons, links, anything with onclick)
  const allClickable = await page.evaluate(() => {
    const results = [];
    
    // All buttons
    Array.from(document.querySelectorAll('button')).forEach(b => {
      results.push({
        tag: 'button',
        text: (b.textContent || '').trim().substring(0, 80),
        className: b.className,
        id: b.id,
        visible: b.offsetParent !== null,
        rect: b.getBoundingClientRect()
      });
    });
    
    // All links
    Array.from(document.querySelectorAll('a')).forEach(a => {
      results.push({
        tag: 'a',
        text: (a.textContent || '').trim().substring(0, 80),
        href: a.href,
        className: a.className,
        id: a.id,
        visible: a.offsetParent !== null
      });
    });
    
    // All elements with click handlers
    const clickHandlers = ['onclick', 'onClick'];
    clickHandlers.forEach(attr => {
      Array.from(document.querySelectorAll(`[${attr}]`)).forEach(el => {
        results.push({
          tag: el.tagName,
          attr: attr,
          text: (el.textContent || '').trim().substring(0, 80),
          className: el.className,
          id: el.id,
          visible: el.offsetParent !== null
        });
      });
    });
    
    return results;
  });
  console.log('\n=== ALL CLICKABLE ELEMENTS ===');
  console.log(JSON.stringify(allClickable, null, 2));

  // Dump all elements whose text or class contains user-related terms (including hidden)
  const userRelated = await page.evaluate(() => {
    const keywords = ['user', 'login', 'sign', 'account', 'profile', 'avatar', 'enter', 'đăng', 'regis', 'logout', 'exit', 'menu', 'nav'];
    const results = [];
    Array.from(document.querySelectorAll('*')).forEach(el => {
      const cls = el.className || '';
      const txt = (el.textContent || '').trim().substring(0, 50).toLowerCase();
      const id = el.id || '';
      if (keywords.some(k => cls.toLowerCase().includes(k) || txt.includes(k) || id.toLowerCase().includes(k))) {
        results.push({
          tag: el.tagName,
          text: (el.textContent || '').trim().substring(0, 80),
          className: el.className,
          id: el.id,
          visible: el.offsetParent !== null,
          innerHTML: el.innerHTML.trim().substring(0, 100)
        });
      }
    });
    return results.slice(0, 40);
  });
  console.log('\n=== USER-RELATED ELEMENTS ===');
  console.log(JSON.stringify(userRelated, null, 2));

  // Check visible elements at common screen positions (top of page, navbar area)
  const visibleTopElements = await page.evaluate(() => {
    const elements = Array.from(document.querySelectorAll('div, span, img, i'))
      .filter(el => el.offsetParent !== null)
      .map(el => {
        const rect = el.getBoundingClientRect();
        return {
          tag: el.tagName,
          text: (el.textContent || '').trim().substring(0, 40),
          className: el.className,
          id: el.id,
          top: Math.round(rect.top),
          left: Math.round(rect.left),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          hasClick: el.onclick !== null || el.getAttribute('onclick') !== null
        };
      })
      .filter(el => el.top >= 0 && el.top < 500) // Visible in top portion of screen
      .slice(0, 30);
    return elements;
  });
  console.log('\n=== VISIBLE TOP-PORTION ELEMENTS ===');
  console.log(JSON.stringify(visibleTopElements, null, 2));

  // Dump the full body HTML to a file
  const fullHTML = await page.evaluate(() => document.body.innerHTML);
  require('fs').writeFileSync('/tmp/fb999_body.html', fullHTML);
  console.log('\nFull body HTML saved to /tmp/fb999_body.html (length:', fullHTML.length, 'chars)');

  await page.screenshot({ path: '/tmp/fb999_deep_diag.png', fullPage: true });
  console.log('Screenshot: /tmp/fb999_deep_diag.png');

  await browser.close();
  console.log('\nDone');
})().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
