const puppeteer = require('puppeteer');

(async () => {
  console.log('=== Diagnostic: Exploring fb999.com page structure ===\n');

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

  // Dump all buttons with text
  const allButtons = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('button')).map(b => ({
      text: (b.textContent || '').trim().substring(0, 60),
      className: b.className,
      id: b.id,
      type: b.type,
      visible: b.offsetParent !== null,
      innerHTML: b.innerHTML.trim().substring(0, 100)
    }));
  });
  console.log('=== ALL BUTTONS ===');
  console.log(JSON.stringify(allButtons, null, 2));

  // Dump all links
  const allLinks = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('a')).map(a => ({
      text: (a.textContent || '').trim().substring(0, 60),
      href: a.href,
      className: a.className,
      id: a.id
    }));
  });
  console.log('\n=== ALL LINKS ===');
  console.log(JSON.stringify(allLinks, null, 2));

  // Dump all divs with class containing login/user/account/menu
  const navElements = await page.evaluate(() => {
    const elements = Array.from(document.querySelectorAll('div, span, i, img'));
    return elements
      .filter(el => {
        const cls = el.className || '';
        const txt = (el.textContent || '').trim().toLowerCase();
        return cls.toLowerCase().includes('login') || cls.toLowerCase().includes('user') ||
               cls.toLowerCase().includes('account') || cls.toLowerCase().includes('menu') ||
               cls.toLowerCase().includes('nav') || txt.includes('login') || txt.includes('user') ||
               txt.includes('login') || txt.includes('đăng') || txt.includes('enter');
      })
      .map(el => ({
        tag: el.tagName,
        text: (el.textContent || '').trim().substring(0, 60),
        className: el.className,
        id: el.id
      }))
      .slice(0, 30);
  });
  console.log('\n=== NAV/USER ELEMENTS ===');
  console.log(JSON.stringify(navElements, null, 2));

  // Check page title
  console.log('\n=== Page title:', await page.title());

  // Check for any element containing "login" text anywhere
  const loginTexts = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('*'))
      .filter(el => (el.textContent || '').toLowerCase().includes('login') || (el.textContent || '').toLowerCase().includes('đăng nhập') || (el.textContent || '').toLowerCase().includes('sign in'))
      .map(el => ({
        tag: el.tagName,
        text: (el.textContent || '').trim().substring(0, 60),
        className: el.className,
        id: el.id
      }))
      .slice(0, 20);
  });
  console.log('\n=== ELEMENTS WITH LOGIN TEXT ===');
  console.log(JSON.stringify(loginTexts, null, 2));

  // Dump page HTML (first 5000 chars) for inspection
  const html = await page.evaluate(() => document.documentElement.outerHTML.substring(0, 5000));
  console.log('\n=== HTML (first 5000 chars) ===');
  console.log(html);

  // Check for vue/router links
  const routerLinks = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('[href*="login"], [href*="Login"], [href*="sign"], [href*="Sign"]'))
      .map(el => ({
        tag: el.tagName,
        href: el.href,
        text: (el.textContent || '').trim().substring(0, 60),
        className: el.className
      }));
  });
  console.log('\n=== ROUTER LINKS (login/sign) ===');
  console.log(JSON.stringify(routerLinks, null, 2));

  // Try navigating directly to login page
  console.log('\n=== Trying direct navigation to /#/login ===');
  try {
    await page.goto('https://fb999.com/#/login', { waitUntil: 'networkidle2', timeout: 30000 });
    console.log('Navigation successful, URL:', page.url());
    
    const loginInputs = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('input')).map(i => ({
        type: i.type, name: i.name, id: i.id, className: i.className,
        placeholder: i.placeholder, visible: i.offsetParent !== null
      }));
    });
    console.log('Input fields on /#/login:', JSON.stringify(loginInputs, null, 2));
    
    const loginButtons = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('button')).map(b => ({
        text: (b.textContent || '').trim().substring(0, 60),
        className: b.className, id: b.id, type: b.type
      }));
    });
    console.log('Buttons on /#/login:', JSON.stringify(loginButtons, null, 2));
  } catch(e) {
    console.log('Error navigating to login:', e.message);
  }

  // Try /#/login/login
  console.log('\n=== Trying direct navigation to /#/login/login ===');
  try {
    await page.goto('https://fb999.com/#/login/login', { waitUntil: 'networkidle2', timeout: 30000 });
    console.log('Navigation successful, URL:', page.url());
    const loginInputs = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('input')).map(i => ({
        type: i.type, name: i.name, id: i.id, className: i.className,
        placeholder: i.placeholder, visible: i.offsetParent !== null
      }));
    });
    console.log('Input fields on /#/login/login:', JSON.stringify(loginInputs, null, 2));
  } catch(e) {
    console.log('Error:', e.message);
  }

  await page.screenshot({ path: '/tmp/fb999_diag.png', fullPage: true });
  console.log('\nScreenshot: /tmp/fb999_diag.png');

  await browser.close();
  console.log('\nDone');
})().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
