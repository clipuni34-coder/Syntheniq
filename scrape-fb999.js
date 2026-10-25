const puppeteer = require('puppeteer');

(async () => {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox', 
      '--disable-setuid-sandbox', 
      '--disable-blink-features=AutomationDetected',
      '--ignore-certificate-errors',
      '--disable-features=EncryptedClientHello'
    ],
    timeout: 60000
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1366, height: 768 });

    // Navigate to fb999 and try to access the WinGo game
    console.log('Navigating to fb999.com...');
    await page.goto('https://fb999.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    
    await new Promise(r => setTimeout(r, 5000));

    // Check if we can find the game iframe or embedded content
    const iframes = await page.evaluate(() => {
      const frames = Array.from(document.querySelectorAll('iframe'));
      return frames.map(f => ({ src: f.src, id: f.id, name: f.name }));
    });
    console.log('IFrames found:', JSON.stringify(iframes, null, 2));

    // Look for any links to WinGo or lottery games
    const links = await page.evaluate(() => {
      const allLinks = Array.from(document.querySelectorAll('a'));
      return allLinks
        .filter(a => a.href && (a.href.includes('wingo') || a.href.includes('WinGo') || a.textContent.includes('WinGo') || a.textContent.includes('Lottery')))
        .map(a => ({ href: a.href, text: a.textContent.trim() }));
    });
    console.log('WinGo/Lottery links:', JSON.stringify(links, null, 2));

    // Check for network requests to the API
    page.on('response', async (response) => {
      const url = response.url();
      if (url.includes('ar-lottery06') || url.includes('GetHistoryIssuePage') || url.includes('WinGo')) {
        try {
          const body = await response.text();
          console.log('API Response:', url, body.substring(0, 500));
        } catch (e) {}
      }
    });

    // Try to click on lottery menu items
    const clicked = await page.evaluate(() => {
      const lotteryItems = Array.from(document.querySelectorAll('*'));
      const candidates = lotteryItems.filter(el => {
        const text = el.innerText || '';
        return text.toLowerCase().includes('lottery') || text.toLowerCase().includes('wingo');
      });
      
      if (candidates.length > 0) {
        const first = candidates[0];
        first.click();
        return true;
      }
      return false;
    });
    console.log('Clicked lottery item:', clicked);

    await new Promise(r => setTimeout(r, 10000));

    // Re-check iframes
    const iframesAfter = await page.evaluate(() => {
      const frames = Array.from(document.querySelectorAll('iframe'));
      return frames.map(f => ({ src: f.src, id: f.id, name: f.name }));
    });
    console.log('IFrames after click:', JSON.stringify(iframesAfter, null, 2));

    // Get page text for any game content
    const text = await page.evaluate(() => document.body.innerText);
    console.log('Page text after interaction:', text.substring(0, 3000));

  } catch (e) {
    console.error('Error:', e.message);
  } finally {
    await browser.close();
  }
})();
