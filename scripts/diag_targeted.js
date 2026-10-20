const puppeteer = require('puppeteer');
const fs = require('fs');

(async () => {
  console.log('=== Targeted Diagnostic ===\n');

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

  // Check localStorage values
  const storage = await page.evaluate(() => {
    const result = {};
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key) result[key] = localStorage.getItem(key);
    }
    return result;
  });
  console.log('=== localStorage ===');
  console.log('token:', storage.token ? storage.token.substring(0, 100) + (storage.token.length > 100 ? '...' : '') : '(none)');
  console.log('ar_token:', storage.ar_token ? storage.ar_token.substring(0, 100) + (storage.ar_token.length > 100 ? '...' : '') : '(none)');
  console.log('userInfo:', storage.userInfo ? storage.userInfo.substring(0, 200) : '(none)');
  console.log('All keys:', Object.keys(storage).join(', '));

  // Check hidden elements (display:none or visibility:hidden) with login/user/class-related text
  const hiddenElements = await page.evaluate(() => {
    const keywords = ['login', 'signin', 'sign-in', 'register', 'regis', 'account', 'user', 'enter', 'avatar', 'profile'];
    const results = [];
    try {
      const all = document.querySelectorAll('*');
      for (const el of all) {
        const style = window.getComputedStyle(el);
        const isHidden = style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0';
        if (!isHidden) continue;
        const cls = typeof el.className === 'string' ? el.className.toLowerCase() : '';
        const id = (el.id || '').toLowerCase();
        const txt = (el.textContent || '').toLowerCase();
        if (keywords.some(k => cls.includes(k) || id.includes(k))) {
          results.push({
            tag: el.tagName,
            className: typeof el.className === 'string' ? el.className : '',
            id: el.id,
            text: (el.textContent || '').trim().substring(0, 80),
          });
        }
      }
    } catch(e) {}
    return results.slice(0, 30);
  });
  console.log('\n=== Hidden login-related elements ===');
  console.log(JSON.stringify(hiddenElements, null, 2));

  // Look for ALL elements by class name pattern in the full DOM
  const allClasses = await page.evaluate(() => {
    const results = new Set();
    try {
      const all = document.querySelectorAll('*');
      for (const el of all) {
        const cls = typeof el.className === 'string' ? el.className : '';
        cls.split(' ').forEach(c => {
          if (c) results.add(c);
        });
      }
    } catch(e) {}
    return Array.from(results).sort();
  });
  console.log('\n=== All CSS classes on page ===');
  console.log(allClasses.filter(c => {
    const lc = c.toLowerCase();
    return lc.includes('login') || lc.includes('user') || lc.includes('account') || lc.includes('auth') || lc.includes('enter') || lc.includes('regis') || lc.includes('signin') || lc.includes('profile') || lc.includes('dropdown') || lc.includes('menu');
  }).join(', '));

  // Try clicking the icon-down dropdown arrow
  console.log('\n=== Trying to click icon-down (dropdown) ===');
  try {
    const clickResult = await page.evaluate(() => {
      // Find the down icon - it's an svg with class containing "icon-down" and "down"
      const downIcons = Array.from(document.querySelectorAll('svg'));
      for (const svg of downIcons) {
        const cls = typeof svg.className === 'string' ? svg.className : '';
        if (cls.includes('icon-down') || cls.includes('down')) {
          return {
            className: cls,
            parentClass: (svg.parentElement && typeof svg.parentElement.className === 'string') ? svg.parentElement.className : '',
            grandParentClass: (svg.parentElement && svg.parentElement.parentElement && typeof svg.parentElement.parentElement.className === 'string') ? svg.parentElement.parentElement.className : '',
            text: (svg.textContent || '').trim(),
          };
        }
      }
      return null;
    });
    console.log('Down icon info:', JSON.stringify(clickResult));

    // Click the down icon
    await page.evaluate(() => {
      const downIcons = Array.from(document.querySelectorAll('svg'));
      for (const svg of downIcons) {
        const cls = typeof svg.className === 'string' ? svg.className : '';
        if (cls.includes('icon-down') || cls.includes('down')) {
          svg.click();
          return true;
        }
      }
      return false;
    });
    console.log('Clicked down icon');
    await new Promise(r => setTimeout(r, 3000));

    // Check for newly appeared elements
    const afterClick = await page.evaluate(() => {
      const results = [];
      try {
        const all = document.querySelectorAll('*');
        for (const el of all) {
          const cls = typeof el.className === 'string' ? el.className : '';
          const style = window.getComputedStyle(el);
          const isVisible = style.display !== 'none' && style.visibility !== 'hidden';
          if (isVisible && (cls.includes('dropdown') || cls.includes('menu') || cls.includes('user') || cls.includes('login') || cls.includes('account'))) {
            results.push({
              tag: el.tagName,
              className: cls,
              text: (el.textContent || '').trim().substring(0, 80),
            });
          }
        }
      } catch(e) {}
      return results.slice(0, 20);
    });
    console.log('Elements after dropdown click:', JSON.stringify(afterClick, null, 2));

    // Check if any inputs appeared
    const inputsAfter = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('input')).map(i => ({
        type: i.type, name: i.name, id: i.id, placeholder: i.placeholder, visible: i.offsetParent !== null
      }));
    });
    console.log('Input fields after dropdown click:', JSON.stringify(inputsAfter, null, 2));

    // Check for buttons after click
    const buttonsAfter = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('button')).map(b => ({
        text: (b.textContent || '').trim().substring(0, 80),
        className: b.className,
        id: b.id,
        visible: b.offsetParent !== null
      }));
    });
    console.log('Buttons after dropdown click:', JSON.stringify(buttonsAfter, null, 2));

    // Check for links after click
    const linksAfter = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('a')).map(a => ({
        text: (a.textContent || '').trim().substring(0, 80),
        href: a.href,
        visible: a.offsetParent !== null
      }));
    });
    console.log('Links after dropdown click:', JSON.stringify(linksAfter, null, 2));

  } catch(e) {
    console.log('Error clicking dropdown:', e.message);
  }

  // Also try clicking the navbar__content-left image
  console.log('\n=== Trying navbar__content-left image ===');
  try {
    const imgInfo = await page.evaluate(() => {
      const imgs = Array.from(document.querySelectorAll('img'));
      const navImgs = imgs.filter(img => {
        const parent = img.parentElement;
        const parentClass = parent && typeof parent.className === 'string' ? parent.className : '';
        return parentClass.includes('navbar__content-left');
      });
      return navImgs.map(img => ({
        src: img.src,
        alt: img.alt,
        parentClass: img.parentElement.className,
      }));
    });
    console.log('Navbar left image:', JSON.stringify(imgInfo));
  } catch(e) {
    console.log('Error:', e.message);
  }

  await page.screenshot({ path: '/tmp/fb999_targeted_diag.png', fullPage: true });
  console.log('\nScreenshot saved to /tmp/fb999_targeted_diag.png');

  await browser.close();
  console.log('Done');
})().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
