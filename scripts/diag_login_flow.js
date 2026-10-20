const puppeteer = require('puppeteer');
const fs = require('fs');

(async () => {
  console.log('=== Login Flow Diagnostic ===\n');

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

  // Click Account tab
  console.log('1. Clicking Account tab...');
  await page.evaluate(() => {
    const items = Array.from(document.querySelectorAll('.tabbar__container-item'));
    for (const item of items) {
      const text = (item.textContent || '').toLowerCase();
      if (text.includes('account')) {
        item.click();
        return true;
      }
    }
    return false;
  });
  await new Promise(r => setTimeout(r, 3000));

  // Look for the "Log in now to participate" button
  console.log('2. Looking for login button...');
  const loginBtn = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button'));
    for (const btn of buttons) {
      const text = (btn.textContent || '').toLowerCase();
      if (text.includes('log in now') || text.includes('login') && text.includes('participate')) {
        return {
          text: btn.textContent.trim(),
          className: btn.className,
          id: btn.id,
          visible: btn.offsetParent !== null,
          outerHTML: btn.outerHTML.substring(0, 500),
        };
      }
    }
    // Broader search
    for (const btn of buttons) {
      const text = (btn.textContent || '').toLowerCase();
      if (text.includes('log in') || text.includes('login')) {
        return {
          text: btn.textContent.trim(),
          className: btn.className,
          id: btn.id,
          visible: btn.offsetParent !== null,
        };
      }
    }
    return null;
  });
  console.log('Login button found:', JSON.stringify(loginBtn));

  // Click the login button
  console.log('3. Clicking login button...');
  const clicked = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button'));
    for (const btn of buttons) {
      const text = (btn.textContent || '').toLowerCase();
      if (text.includes('log in now') || (text.includes('log in') || text.includes('login'))) {
        btn.click();
        return true;
      }
    }
    return false;
  });
  console.log('Login button clicked:', clicked);
  await new Promise(r => setTimeout(r, 5000));

  // Check for input fields
  console.log('4. Checking for input fields...');
  const inputs = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('input')).map(i => ({
      type: i.type, name: i.name, id: i.id, placeholder: i.placeholder,
      className: i.className, value: i.value, visible: i.offsetParent !== null
    }));
  });
  console.log('Input fields:', JSON.stringify(inputs, null, 2));

  // Check for all buttons
  console.log('5. All buttons:');
  const allButtons = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('button')).map(b => ({
      text: (b.textContent || '').trim().substring(0, 80),
      className: b.className,
      id: b.id,
      visible: b.offsetParent !== null
    }));
  });
  console.log(JSON.stringify(allButtons, null, 2));

  // Check URL
  console.log('6. Current URL:', page.url());

  // Look for login form
  const forms = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('form')).map(f => ({
      id: f.id, className: f.className, action: f.action, method: f.method
    }));
  });
  console.log('7. Forms:', JSON.stringify(forms, null, 2));

  // Look for any div with login-related class
  const loginDivs = await page.evaluate(() => {
    const results = [];
    const all = document.querySelectorAll('div');
    for (const div of all) {
      const cls = typeof div.className === 'string' ? div.className.toLowerCase() : '';
      if (cls.includes('login') || cls.includes('form') || cls.includes('auth')) {
        results.push({
          className: div.className,
          id: div.id,
          text: (div.textContent || '').trim().substring(0, 100),
          visible: div.offsetParent !== null,
        });
      }
    }
    return results.slice(0, 20);
  });
  console.log('8. Login/form divs:', JSON.stringify(loginDivs, null, 2));

  // Dump HTML around any login-related section
  const loginSectionHTML = await page.evaluate(() => {
    const all = document.querySelectorAll('div');
    for (const div of all) {
      const cls = typeof div.className === 'string' ? div.className.toLowerCase() : '';
      if (cls.includes('login')) {
        return div.outerHTML.substring(0, 3000);
      }
    }
    return 'No login div found';
  });
  console.log('9. Login section HTML:', loginSectionHTML);

  // Dump the main view HTML (everything inside #app after the loading view)
  const mainViewHTML = await page.evaluate(() => {
    const app = document.getElementById('app');
    if (!app) return 'No app element';
    // Get children of the content div
    const content = app.querySelector('.content');
    if (!content) return 'No content element';
    return content.innerHTML.substring(0, 5000);
  });
  console.log('10. Main content HTML (first 5000 chars):', mainViewHTML);

  await page.screenshot({ path: '/tmp/fb999_login_flow.png', fullPage: true });
  console.log('\nScreenshot saved to /tmp/fb999_login_flow.png');

  await browser.close();
  console.log('Done');
})().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
