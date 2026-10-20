const puppeteer = require('puppeteer');
const fs = require('fs');

(async () => {
  console.log('=== Simple Diagnostic ===\n');

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

  await page.goto('https://fb999.com', { waitUntil: 'networkidle2', timeout: 30000 });
  await new Promise(r => setTimeout(r, 5000));

  // Dump full body HTML
  const fullHTML = await page.evaluate(() => document.body.innerHTML);
  fs.writeFileSync('/tmp/fb999_body.html', fullHTML);
  console.log('Body HTML saved (length:', fullHTML.length, 'chars)');

  // Search for login/user/sign in the rendered content
  const loginElements = await page.evaluate(() => {
    const keywords = ['login', 'signin', 'sign-in', 'loginout', 'enter', 'register', 'đăng nhập', 'đăng ký'];
    const results = [];
    try {
      const all = document.querySelectorAll('*');
      for (const el of all) {
        const cls = typeof el.className === 'string' ? el.className : '';
        const id = el.id || '';
        const txt = (el.textContent || '').toLowerCase();
        const html = (el.innerHTML || '').toLowerCase();
        if (keywords.some(k => cls.toLowerCase().includes(k) || id.toLowerCase().includes(k) || txt.includes(k))) {
          results.push({
            tag: el.tagName,
            text: (el.textContent || '').trim().substring(0, 80),
            className: cls,
            id: id,
            visible: el.offsetParent !== null,
            onclick: (el.getAttribute && el.getAttribute('onclick')) || ''
          });
        }
      }
    } catch(e) {}
    return results.slice(0, 30);
  });
  console.log('\n=== Login-related elements ===');
  console.log(JSON.stringify(loginElements, null, 2));

  // Look for elements with onclick handlers
  const clickElements = await page.evaluate(() => {
    const results = [];
    try {
      const all = document.querySelectorAll('*');
      for (const el of all) {
        const onclick = el.getAttribute ? el.getAttribute('onclick') : null;
        if (onclick && onclick.length > 0) {
          results.push({
            tag: el.tagName,
            onclick: onclick.substring(0, 100),
            className: typeof el.className === 'string' ? el.className : '',
            text: (el.textContent || '').trim().substring(0, 40)
          });
        }
      }
    } catch(e) {}
    return results.slice(0, 30);
  });
  console.log('\n=== Elements with onclick ===');
  console.log(JSON.stringify(clickElements, null, 2));

  // Look for SVG use elements (icons) and their titles
  const icons = await page.evaluate(() => {
    const results = [];
    try {
      const svgs = document.querySelectorAll('svg');
      for (const svg of svgs) {
        const use = svg.querySelector('use');
        const title = svg.getAttribute('aria-label') || svg.getAttribute('title') || svg.title || '';
        results.push({
          svgClass: svg.className || '',
          svgId: svg.id || '',
          title: title,
          useHref: use ? use.getAttribute('xlink:href') || use.getAttribute('href') : '',
          visible: svg.offsetParent !== null
        });
      }
    } catch(e) {}
    return results.slice(0, 30);
  });
  console.log('\n=== SVG icons ===');
  console.log(JSON.stringify(icons, null, 2));

  // Look for data attributes that might be click handlers (Vue)
  const vueData = await page.evaluate(() => {
    const results = [];
    try {
      const all = document.querySelectorAll('*');
      for (const el of all) {
        const attrs = Array.from(el.attributes || []);
        const vueAttrs = attrs.filter(a => a.name.startsWith('data-') || a.name.startsWith('v-') || a.name === '@click' || a.name === ':href');
        if (vueAttrs.length > 0) {
          results.push({
            tag: el.tagName,
            className: typeof el.className === 'string' ? el.className : '',
            attrs: vueAttrs.map(a => `${a.name}="${a.value.substring(0, 50)}"`)
          });
        }
      }
    } catch(e) {}
    return results.slice(0, 50);
  });
  console.log('\n=== Vue/data attributes sample ===');
  console.log(JSON.stringify(vueData, null, 2));

  await page.screenshot({ path: '/tmp/fb999_simple_diag.png', fullPage: true });
  console.log('\nScreenshot saved');

  await browser.close();
  console.log('Done');
})().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
