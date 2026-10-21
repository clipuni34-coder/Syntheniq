const puppeteer = require('puppeteer');
const fs = require('fs');

const RENDER_EMAIL = 'clipuni34@gmail.com';
const RENDER_PASSWORD = 'Drewziwugod@6';

const wait = (ms) => new Promise(r => setTimeout(r, ms));

async function main() {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--window-size=1440,900',
      '--ignore-certificate-errors',
      '--ignore-web-security',
    ],
    ignoreHTTPSErrors: true,
  });

  const page = await browser.newPage();

  // Intercept ALL requests
  page.on('request', request => {
    const url = request.url();
    if (url.includes('render.com') && (url.includes('graphql') || url.includes('api'))) {
      console.log('[REQUEST]:', request.method(), url);
      console.log('[REQUEST BODY]:', request.postData?.()?.substring(0, 500));
    }
  });

  page.on('response', async response => {
    const url = response.url();
    if (url.includes('render.com') && (url.includes('graphql') || url.includes('api'))) {
      const body = await response.text();
      console.log('[RESPONSE]:', response.status(), url);
      console.log('[RESPONSE BODY]:', body.substring(0, 1000));
    }
  });

  try {
    // Login
    console.log('=== Logging in ===');
    await page.goto('https://dashboard.render.com/login', {
      waitUntil: 'networkidle2',
      timeout: 30000
    });
    
    await page.type('input[name="email"]', RENDER_EMAIL, { delay: 30 });
    await page.type('input[name="password"]', RENDER_PASSWORD, { delay: 30 });
    
    await Promise.all([
      page.waitForNavigation({ timeout: 15000 }).catch(() => {}),
      page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button[type="submit"], button:not([type])'));
        for (const btn of buttons) {
          const text = (btn.textContent || '').toLowerCase();
          if (text.includes('sign in') || text.includes('log in')) {
            btn.click();
            return;
          }
        }
      })
    ]);
    await wait(5000);
    console.log('Login URL:', page.url());

    // Navigate to settings
    await page.goto('https://dashboard.render.com/u/settings', {
      waitUntil: 'networkidle2',
      timeout: 30000
    });
    
    // Now make a direct GraphQL call to create an API key
    console.log('\n=== Creating API key via direct fetch ===');
    
    const apiKeyResult = await page.evaluate(async () => {
      try {
        const response = await fetch('https://api.render.com/graphql', {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
          },
          body: JSON.stringify({
            query: \`
              mutation CreateApiKey(\$name: String!) {
                createApiToken(input: { name: \$name }) {
                  id
                  key
                  name
                  createdAt
                  __typename
                }
              }
            \`,
            variables: { name: 'wingo-deploy-key' }
          })
        });
        const data = await response.json();
        return { status: response.status, data: JSON.stringify(data) };
      } catch (e) {
        return { error: e.message };
      }
    });
    
    console.log('API key creation result:', JSON.stringify(apiKeyResult, null, 2));
    
    // Try different mutation names
    const mutationNames = [
      'createApiKey',
      'createApiToken', 
      'createNewApiKey',
      'createPersonalApiKey',
      'createAPIToken',
    ];
    
    for (const name of mutationNames) {
      console.log(`\nTrying mutation: ${name}`);
      const result = await page.evaluate(async (name) => {
        try {
          const response = await fetch('https://api.render.com/graphql', {
            method: 'POST',
            credentials: 'include',
            headers: {
              'Content-Type': 'application/json',
              'Accept': 'application/json',
            },
            body: JSON.stringify({
              query: \`
                mutation CreateKey(\$name: String!) {
                  ${name}(input: { name: \$name }) {
                    id
                    key
                    name
                    __typename
                  }
                }
              \`,
              variables: { name: 'wingo-deploy-key' }
            })
          });
          const data = await response.json();
          return JSON.stringify(data);
        } catch (e) {
          return { error: e.message };
        }
      }, name);
      console.log(`Result:`, result);
      
      // Check if we got a key
      try {
        const parsed = JSON.parse(result);
        if (parsed.data && parsed.data[name] && parsed.data[name].key) {
          console.log('FOUND KEY via', name, ':', parsed.data[name].key.substring(0, 15) + '...');
          fs.writeFileSync('/tmp/render_api_key_real.txt', parsed.data[name].key);
          break;
        }
      } catch (e) {}
    }
    
    await browser.close();
    console.log('=== Done ===');
    
  } catch (error) {
    console.error('ERROR:', error.message);
    console.error(error.stack);
    try {
      await page.screenshot({ path: '/workspace/app/screenshots/key-error-v3.png', fullPage: true });
    } catch (e) {}
    await browser.close();
  }
}

main().catch(console.error);
