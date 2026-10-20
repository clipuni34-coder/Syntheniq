const puppeteer = require('puppeteer');
const fs = require('fs');

(async () => {
  console.log('=== Account Tab Diagnostic ===\n');

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

  // Find and click the Account tabbar item
  console.log('=== Tabbar items ===');
  const tabItems = await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll('.tabbar__container-item'));
    return items.map((el, i) => ({
      index: i,
      text: (el.textContent || '').trim(),
      className: el.className,
      svgIcons: Array.from(el.querySelectorAll('svg')).map(svg => svg.className || ''),
    }));
  });
  console.log(JSON.stringify(tabItems, null, 2));

  // Click the Account tab (last item, or the one with "Account" text)
  console.log('\n=== Clicking Account tab ===');
  await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll('.tabbar__container-item'));
    for (const item of items) {
      const text = (item.textContent || '').toLowerCase();
      if (text.includes('account')) {
        item.click();
        return true;
      }
    }
    // Fallback: click the last item
    if (items.length > 0) {
      items[items.length - 1].click();
      return true;
    }
    return false;
  });
  console.log('Clicked Account tab');
  await new Promise(r => setTimeout(r, 3000));

  // Check what's now visible
  const inputsAfter = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('input')).map(i => ({
      type: i.type, name: i.name, id: i.id, placeholder: i.placeholder, className: i.className, visible: i.offsetParent !== null
    }));
  });
  console.log('\nInput fields after clicking Account:', JSON.stringify(inputsAfter, null, 2));

  const buttonsAfter = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('button')).map(b => ({
      text: (b.textContent || '').trim().substring(0, 80),
      className: b.className,
      id: b.id,
      visible: b.offsetParent !== null
    }));
  });
  console.log('\nButtons after clicking Account:', JSON.stringify(buttonsAfter, null, 2));

  // Look for buttons with login/register text in the Account view
  const accountButtons = await page.evaluate(() => {
    const results = [];
    const allButtons = Array.from(document.querySelectorAll('button'));
    const keyTexts = ['login', 'sign', 'register', 'enter', 'đăng nhập', 'đăng ký', 'user'];
    for (const btn of allButtons) {
      const text = (btn.textContent || '').toLowerCase();
      const cls = btn.className || '';
      if (keyTexts.some(k => text.includes(k) || cls.toLowerCase().includes(k))) {
        results.push({
          text: (btn.textContent || '').trim().substring(0, 80),
          className: btn.className,
          id: btn.id,
          visible: btn.offsetParent !== null,
        });
      }
    }
    return results;
  });
  console.log('\nAccount-related buttons:', JSON.stringify(accountButtons, null, 2));

  // Look for all visible elements in the Account view
  const visibleElements = await page.evaluate(() => {
    const results = [];
    try {
      const all = document.querySelectorAll('div, span, button, a');
      for (const el of all) {
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        const rect = el.getBoundingClientRect();
        if (rect.height === 0 || rect.width === 0) continue;
        const cls = typeof el.className === 'string' ? el.className : '';
        const txt = (el.textContent || '').trim().substring(0, 40);
        if (txt || cls) {
          results.push({
            tag: el.tagName,
            text: txt,
            className: cls,
            id: el.id,
          });
        }
      }
    } catch(e) {}
    return results.slice(0, 50);
  });
  console.log('\n=== Visible elements ===');
  console.log(JSON.stringify(visibleElements, null, 2));

  // Search for login/register text more broadly
  const loginText = await page.evaluate(() => {
    const results = [];
    try {
      const walker = document.createTreeWalker(
        document.body,
        NodeFilter.SHOW_TEXT,
        null,
        false
      );
      let node;
      while (node = walker.nextNode()) {
        const text = node.textContent.trim();
        if (text) {
          const lc = text.toLowerCase();
          if (lc.includes('login') || lc.includes('register') || lc.includes('sign') || lc.includes('enter') || lc.includes('đăng')) {
            results.push({
              text: text.substring(0, 50),
              parentTag: node.parentElement?.tagName,
              parentClass: node.parentElement?.className || '',
            });
          }
        }
      }
    } catch(e) {}
    return results.slice(0, 30);
  });
  console.log('\n=== Text nodes with login/register/enter ===');
  console.log(JSON.stringify(loginText, null, 2));

  // Get the Account section's full HTML
  const accountHTML = await page.evaluate(() => {
    const tabbar = document.querySelector('.tabbar__container');
    if (!tabbar) return 'No tabbar found';
    const activeItem = Array.from(document.querySelectorAll('.tabbar__container-item')).find(el => el.classList.contains('active'));
    let section = '';
    if (activeItem) {
      section = activeItem.closest('div')?.outerHTML.substring(0, 5000) || '';
    }
    // Also try to get the main view
    const views = Array.from(document.querySelectorAll('[class*="view"], [class*="page"], [class*="panel"], .content > div'));
    return {
      activeTab: activeItem ? activeItem.textContent.trim() : 'none',
      tabbarHTML: tabbar.outerHTML.substring(0, 3000),
      viewHTML: views.map(v => v.outerHTML.substring(0, 3000)).slice(0, 5),
    };
  });
  console.log('\n=== Account section HTML ===');
  console.log(JSON.stringify(accountHTML, null, 2));

  await page.screenshot({ path: '/tmp/fb999_account_tab.png', fullPage: true });
  console.log('\nScreenshot saved to /tmp/fb999_account_tab.png');

  await browser.close();
  console.log('Done');
})().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
