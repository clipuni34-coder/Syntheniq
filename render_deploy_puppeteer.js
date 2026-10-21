const puppeteer = require('puppeteer');

const wait = (ms) => new Promise(r => setTimeout(r, ms));

async function main() {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-infobars',
      '--disable-web-security',
      '--disable-features=IsolateOrigins,site-per-process',
      '--window-size=1440,900',
      '--ignore-certificate-errors',
    ],
    ignoreHTTPSErrors: true,
  });

  const page = await browser.newPage();
  
  page.on('console', msg => console.log(`[PAGE]: ${msg.text()}`));
  page.on('pageerror', err => console.log(`[PAGEERROR]: ${err.message()}`));

  try {
    // Step 1: Navigate to Render login page
    console.log('=== Navigating to Render login ===');
    await page.goto('https://dashboard.render.com/login', {
      waitUntil: 'networkidle2',
      timeout: 30000
    });
    
    console.log('Page title:', await page.title());
    console.log('Current URL:', page.url());
    await page.screenshot({ path: '/workspace/app/screenshots/render-login-page.png', fullPage: true });
    
    // Look for GitHub login button/link
    console.log('Looking for GitHub login option...');
    
    const allElements = await page.evaluate(() => {
      const elements = Array.from(document.querySelectorAll('button, a, div'));
      return elements.map(el => ({
        tag: el.tagName,
        text: (el.textContent || '').trim().substring(0, 100),
        href: el.getAttribute('href'),
        onclick: el.getAttribute('onclick'),
        provider: el.getAttribute('data-provider'),
        class: el.className.substring(0, 100),
      })).filter(el => {
        const text = (el.text || '').toLowerCase();
        return text.includes('github') || text.includes('google') || text.includes('sign in') || 
               text.includes('log in') || text.includes('email') || text.includes('password') ||
               text.includes('create') || text.includes('sign up') || text.includes('continue');
      });
    });
    
    console.log('Interactive elements:', JSON.stringify(allElements, null, 2));
    
    // Try to find and click GitHub button
    const githubClicked = await page.evaluate(() => {
      // Strategy 1: Direct GitHub link/button
      const githubSelectors = [
        'a[href*="github.com"]',
        'a[href*="github"]',
        'button[data-provider="github"]',
        '[data-provider="github"]',
        '[data-testid*="github"]',
      ];
      
      for (const sel of githubSelectors) {
        const el = document.querySelector(sel);
        if (el && el.offsetParent !== null) {
          el.click();
          return true;
        }
      }
      
      // Strategy 2: Find by text
      const elements = Array.from(document.querySelectorAll('button, a'));
      for (const el of elements) {
        const text = (el.textContent || '').toLowerCase().trim();
        if ((text.includes('github') || text.includes('git hub'))) {
          const rect = el.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            el.click();
            return true;
          }
        }
      }
      
      // Strategy 3: Click "Sign In" then look for GitHub
      for (const el of elements) {
        const text = (el.textContent || '').toLowerCase().trim();
        if (text === 'sign in' || text === 'log in' || text === 'login') {
          const rect = el.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            el.click();
            return true;
          }
        }
      }
      
      return false;
    });
    
    console.log('GitHub clicked:', githubClicked);
    await wait(3000);
    await page.screenshot({ path: '/workspace/app/screenshots/render-after-github-click.png', fullPage: true });
    console.log('After click, URL:', page.url());
    console.log('Title:', await page.title());
    
    // Wait for navigation to GitHub
    try {
      await page.waitForNavigation({ timeout: 15000, waitUntil: 'networkidle2' });
      console.log('Navigated to:', page.url());
    } catch (e) {
      console.log('No additional navigation after 15s, checking GitHub OAuth...');
      console.log('URL:', page.url());
    }
    
    // Check if we're on GitHub's site
    const githubUrl = page.url();
    if (githubUrl.includes('github.com')) {
      console.log('On GitHub! URL:', githubUrl);
      await page.screenshot({ path: '/workspace/app/screenshots/render-on-github.png', fullPage: true });
      
      // Check if we're on an OAuth consent page
      // or a login page
      const isOAuthApp = await page.evaluate(() => {
        return document.title.includes('Authorize') || 
               document.title.includes('Sign in') ||
               document.querySelector('input[name="login"]') !== null ||
               document.querySelector('input[name="password"]') !== null ||
               document.querySelector('button[type="submit"]') !== null;
      });
      
      console.log('On GitHub OAuth/login page:', isOAuthApp);
      
      if (isOAuthApp) {
        // Check if already logged in to GitHub via token
        // Try to find a way to use the GH_TOKEN
        // GitHub OAuth flow won't work with just a token - need browser session
        
        // Look for login form
        await page.type('input[name="login"], input[name="email"], input[type="email"]', 'clipuni34@gmail.com', { delay: 50 }).catch(() => {});
        console.log('Entered email');
        await wait(1000);
        await page.screenshot({ path: '/workspace/app/screenshots/github-login.png', fullPage: true });
      }
    } else {
      // Check if we're back on Render dashboard (logged in)
      if (page.url().includes('dashboard.render.com')) {
        console.log('Back on Render dashboard!');
        
        // Check if user menu or services are visible
        const isLoggedIn = await page.evaluate(() => {
          const selectors = [
            '[data-testid="account-menu"]',
            'a[href*="/services"]',
            'span[data-testid="username"]',
            '[data-testid="new-service"]',
            'button[data-testid="new"]',
          ];
          for (const sel of selectors) {
            if (document.querySelector(sel)) return sel;
          }
          return false;
        });
        
        console.log('Logged in, found selector:', isLoggedIn);
      }
    }

    await browser.close();
    console.log('=== Script completed ===');
    
  } catch (error) {
    console.error('=== ERROR ===');
    console.error(error.message);
    console.error(error.stack);
    
    try {
      await page.screenshot({ path: '/workspace/app/screenshots/render-final-error.png', fullPage: true });
      console.log('Error screenshot saved');
    } catch (e) {
      console.log('Could not save screenshot:', e.message);
    }
    
    await browser.close();
    process.exit(1);
  }
}

main().catch(console.error);
