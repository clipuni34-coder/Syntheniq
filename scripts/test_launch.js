const puppeteer = require('puppeteer');
(async () => {
  try {
    const browser = await puppeteer.launch({
      headless: 'new',
      executablePath: '/usr/bin/chromium',
      defaultArgs: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      args: ['--disable-blink-features=AutomationDetected', '--no-sandbox', '--disable-setuid-sandbox']
    });
    console.log('Browser launched successfully');
    const page = await browser.newPage();
    await page.goto('https://example.com', { waitUntil: 'domcontentloaded', timeout: 15000 });
    console.log('Page title:', await page.title());
    await browser.close();
    console.log('Browser closed');
  } catch(e) {
    console.error('Error:', e.message);
  }
})();
