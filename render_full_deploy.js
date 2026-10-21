const puppeteer = require('puppeteer');
const https = require('https');
const fs = require('fs');

const RENDER_EMAIL = 'clipuni34@gmail.com';
const RENDER_PASSWORD = 'Drewziwugod@6';
const RENDER_API_HOST = 'api.render.com';

const wait = (ms) => new Promise(r => setTimeout(r, ms));

async function main() {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--window-size=1440,900',
      '--ignore-certificate-errors',
    ],
    ignoreHTTPSErrors: true,
  });

  const page = await browser.newPage();
  
  page.on('console', msg => console.log(`[PAGE]: ${msg.text()}`));

  try {
    // === STEP 1: Login to Render ===
    console.log('=== STEP 1: Logging in to Render ===');
    await page.goto('https://dashboard.render.com/login', {
      waitUntil: 'networkidle2',
      timeout: 30000
    });
    
    await page.type('input[name="email"], input[type="email"]', RENDER_EMAIL, { delay: 50 });
    await page.type('input[name="password"], input[type="password"]', RENDER_PASSWORD, { delay: 50 });
    
    // Click sign in
    await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button[type="submit"], button:not([type])'));
      for (const btn of buttons) {
        const text = (btn.textContent || '').toLowerCase();
        if (text.includes('sign in') || text.includes('log in')) {
          btn.click();
          return true;
        }
      }
      return false;
    });
    
    await wait(5000);
    console.log('Login URL:', page.url());
    
    if (!page.url().includes('dashboard.render.com') || page.url().includes('/login')) {
      console.log('Login may have failed or been rate limited');
      await page.screenshot({ path: '/workspace/app/screenshots/login-failed.png', fullPage: true });
    } else {
      console.log('Login successful!');
    }
    
    await page.screenshot({ path: '/workspace/app/screenshots/after-login.png', fullPage: true });

    // === STEP 2: Get API key ===
    console.log('\n=== STEP 2: Getting API key ===');
    
    // Go to account settings
    await page.goto('https://dashboard.render.com/u/settings?add-api-key=true', {
      waitUntil: 'networkidle2',
      timeout: 30000
    });
    
    console.log('Settings URL:', page.url());
    await page.screenshot({ path: '/workspace/app/screenshots/settings.png', fullPage: true });
    
    // Look for "Create API Key" or similar button
    const apiKeyBtn = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      for (const btn of buttons) {
        const text = (btn.textContent || '').toLowerCase();
        if (text.includes('api key') || text.includes('create new') || text.includes('add api')) {
          const rect = btn.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            btn.click();
            return text;
          }
        }
      }
      return false;
    });
    console.log('Clicked button:', apiKeyBtn);
    
    await wait(3000);
    await page.screenshot({ path: '/workspace/app/screenshots/api-key-create.png', fullPage: true });
    
    // Look for the generated API key
    // The key is typically shown in a modal or notification
    let apiKey = null;
    
    // Method 1: Check for a code/input field with the key
    apiKey = await page.evaluate(() => {
      // Look for any visible text containing an API key pattern
      const elements = Array.from(document.querySelectorAll('code, pre, input, div'));
      for (const el of elements) {
        const text = (el.textContent || el.value || '').trim();
        // Render API keys look like "rnder_..." or similar patterns
        if (text.length > 20 && !text.toLowerCase().includes('button') && 
            !text.toLowerCase().includes('create') && text.includes('_')) {
          return text;
        }
        // Check for input fields with value attribute
        if (el.tagName === 'INPUT' && el.value && el.value.length > 20) {
          return el.value;
        }
      }
      return null;
    });
    
    // Method 2: Check clipboard (Render copies the key automatically)
    // This won't work in puppeteer directly, but the key might be in the page
    
    // Method 3: Wait for and check for the key modal
    if (!apiKey) {
      console.log('Key not found yet, waiting for modal...');
      await wait(3000);
      await page.screenshot({ path: '/workspace/app/screenshots/api-key-modal.png', fullPage: true });
      
      apiKey = await page.evaluate(() => {
        const elements = Array.from(document.querySelectorAll('*'));
        for (const el of elements) {
          const text = (el.textContent || '').trim();
          if (text.match(/^[a-zA-Z0-9_]{30,}$/) && !text.toLowerCase().includes('button') &&
              !text.toLowerCase().includes('click') && !text.toLowerCase().includes('save')) {
            return text;
          }
          if (el.tagName === 'INPUT' && el.value && el.value.match(/^[a-zA-Z0-9_]{30,}$/)) {
            return el.value;
          }
        }
        return null;
      });
    }
    
    // Method 4: Try to extract from page HTML
    if (!apiKey) {
      const pageContent = await page.content();
      // Look for API key patterns in the HTML
      const keyMatch = pageContent.match(/[a-zA-Z0-9_]{32,}/g);
      if (keyMatch) {
        for (const match of keyMatch) {
          if (!match.toLowerCase().includes('script') && !match.toLowerCase().includes('class') &&
              !match.toLowerCase().includes('render')) {
            apiKey = match;
            break;
          }
        }
      }
    }
    
    // Method 5: Use the clipboard
    try {
      const clipboardText = await page.evaluate(async () => {
        try {
          return await navigator.clipboard.readText();
        } catch (e) {
          return null;
        }
      });
      if (clipboardText && clipboardText.length > 20) {
        console.log('Got key from clipboard:', clipboardText.substring(0, 10) + '...');
        apiKey = clipboardText;
      }
    } catch (e) {
      console.log('Could not read clipboard:', e.message);
    }
    
    if (apiKey) {
      console.log('Found API key!');
      // Save to file
      fs.writeFileSync('/tmp/render_api_key.txt', apiKey);
      console.log('API key saved to /tmp/render_api_key.txt');
    } else {
      console.log('Could not find API key automatically');
      console.log('Will try to use the render CLI token instead');
      
      // Try to extract the render CLI auth token from cookies/localStorage
      const cookies = await page.cookies();
      console.log('Cookies:', JSON.stringify(cookies.map(c => ({name: c.name, value: c.value.substring(0, 20) + '...'}))));
      
      // Try localStorage
      const localStorage = await page.evaluate(() => {
        const items = {};
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          items[key] = localStorage.getItem(key)?.substring(0, 50);
        }
        return items;
      });
      console.log('LocalStorage:', JSON.stringify(localStorage));
    }

    await browser.close();
    
    // === STEP 3: If we have an API key, create the service ===
    if (apiKey) {
      console.log('\n=== STEP 3: Creating Render service via API ===');
      
      // First, get our workspace ID
      const workspaceRes = await new Promise((resolve, reject) => {
        const req = https.request({
          hostname: 'api.render.com',
          path: '/v1/workspaces',
          method: 'GET',
          headers: { 'Authorization': `Bearer ${apiKey}`, 'Accept': 'application/json' }
        }, res => {
          let data = '';
          res.on('data', c => data += c);
          res.on('end', () => resolve({ status: res.statusCode, body: data }));
        });
        req.on('error', reject);
        req.end();
      });
      
      console.log('Workspace response:', workspaceRes.status, workspaceRes.body.substring(0, 500));
      
      if (workspaceRes.status === 200) {
        const workspaces = JSON.parse(workspaceRes.body);
        const ws = workspaces[0];
        const ownerId = ws.id;
        console.log('Workspace ID:', ownerId);
        
        // Now create the service
        const serviceData = JSON.stringify({
          type: 'web_service',
          name: 'wingo-racer',
          ownerId: ownerId,
          repo: 'https://github.com/clipuni34-coder/Syntheniq',
          autoDeploy: true,
          branch: 'main',
          runtime: 'docker',
          envVars: {
            FB999_PHONE: '2349121493739',
            FB999_PASSWORD: 'Drewziwugod6',
            NODE_ENV: 'production',
            PORT: '3000'
          },
          serviceDetails: {
            runtime: 'docker',
            plan: 'free',
            region: 'oregon',
            healthCheckPath: '/health',
          }
        });
        
        const deployRes = await new Promise((resolve, reject) => {
          const req = https.request({
            hostname: 'api.render.com',
            path: '/v1/services',
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${apiKey}`,
              'Accept': 'application/json',
              'Content-Type': 'application/json'
            }
          }, res => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => resolve({ status: res.statusCode, body: data }));
          });
          req.on('error', reject);
          req.write(serviceData);
          req.end();
        });
        
        console.log('Deploy response:', deployRes.status, deployRes.body);
        
        if (deployRes.status === 201 || deployRes.status === 200) {
          const result = JSON.parse(deployRes.body);
          console.log('Service created!', JSON.stringify(result, null, 2));
        }
      }
    }
    
  } catch (error) {
    console.error('=== ERROR ===');
    console.error(error.message);
    console.error(error.stack);
  }
}

main().catch(console.error);
