const puppeteer = require('puppeteer');
const fs = require('fs');

const RENDER_EMAIL = 'clipuni34@gmail.com';
const RENDER_PASSWORD = 'Drewziwugod@6';
const WORKSPACE_ID = 'tea-davrdhtg1s2s73bjocvg';

const wait = (ms) => new Promise(r => setTimeout(r, ms));

async function makeGraphQLRequest(page, query, variables = {}) {
  // Get cookies from the page
  const cookies = await page.cookies();
  const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
  
  // Make the GraphQL request using page.evaluate with fetch
  const result = await page.evaluate(async (query, variables, cookieHeader) => {
    try {
      const response = await fetch('https://api.render.com/graphql', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Cookie': cookieHeader,
          'Accept': 'application/json',
        },
        body: JSON.stringify({ query, variables })
      });
      const data = await response.json();
      return { status: response.status, data };
    } catch (e) {
      return { error: e.message };
    }
  }, query, variables, cookieHeader);
  
  return result;
}

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

  try {
    // === STEP 1: Login to Render ===
    console.log('=== STEP 1: Logging in to Render ===');
    await page.goto('https://dashboard.render.com/login', {
      waitUntil: 'networkidle2',
      timeout: 30000
    });
    
    await page.type('input[name="email"], input[type="email"]', RENDER_EMAIL, { delay: 30 });
    await page.type('input[name="password"], input[type="password"]', RENDER_PASSWORD, { delay: 30 });
    
    await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button[type="submit"], button:not([type])'));
      for (const btn of buttons) {
        const text = (btn.textContent || '').toLowerCase();
        if (text.includes('sign in') || text.includes('log in')) {
          btn.click();
          return;
        }
      }
    });
    await wait(5000);
    console.log('Login URL:', page.url());

    // === STEP 2: Create API Key ===
    console.log('\n=== STEP 2: Creating API Key via GraphQL ===');
    
    const createKeyQuery = `
      mutation CreateApiKey($name: String!, $ownerId: String!) {
        createApiToken(input: { name: $name, ownerId: $ownerId }) {
          id
          key
          name
          __typename
        }
      }
    `;
    
    const keyResult = await makeGraphQLRequest(page, createKeyQuery, {
      name: 'wingo-deploy-key',
      ownerId: WORKSPACE_ID
    });
    
    console.log('API Key result:', JSON.stringify(keyResult, null, 2));
    
    let apiKey = null;
    if (keyResult.data?.data?.createApiToken?.key) {
      apiKey = keyResult.data.data.createApiToken.key;
    }
    
    if (apiKey) {
      console.log('API key created!');
      fs.writeFileSync('/tmp/render_api_key_real.txt', apiKey);
      console.log('Key saved (first 10 chars):', apiKey.substring(0, 10) + '...');
    } else {
      console.log('Failed to create API key via GraphQL');
      console.log('Trying to extract from page after clicking create...');
      
      // Try the UI approach - navigate to settings and click create
      await page.goto('https://dashboard.render.com/u/settings', {
        waitUntil: 'networkidle2',
        timeout: 30000
      });
      
      // Click "Create API key" button
      await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        for (const btn of buttons) {
          const text = (btn.textContent || '').toLowerCase();
          if (text.includes('create') && text.includes('api')) {
            btn.click();
            return;
          }
        }
      });
      await wait(2000);
      await page.screenshot({ path: '/workspace/app/screenshots/api-key-modal2.png', fullPage: true });
      
      // Now enter a name and click "Create API Key" in the modal
      await page.evaluate(() => {
        // Type name
        const input = document.querySelector('input[placeholder*="key"], input[placeholder*="name"], input[aria-label*="name"], input[aria-label*="key"]');
        if (input) {
          input.value = 'wingo-deploy-key';
          input.dispatchEvent(new Event('input', { bubbles: true }));
        }
        
        // Click the create button in the modal
        const buttons = Array.from(document.querySelectorAll('button'));
        for (const btn of buttons) {
          const text = (btn.textContent || '').toLowerCase();
          if (text.includes('create api key') || (text.includes('create') && text.includes('key'))) {
            btn.click();
            return;
          }
        }
      });
      
      await wait(3000);
      await page.screenshot({ path: '/workspace/app/screenshots/api-key-result.png', fullPage: true });
      
      // Now try to extract the key from the page
      const key = await page.evaluate(() => {
        const allElements = Array.from(document.querySelectorAll('*'));
        for (const el of allElements) {
          const text = (el.textContent || '').trim();
          // API keys are typically long alphanumeric strings
          if (text.length > 30 && text.length < 200 && /^[a-zA-Z0-9_-]+$/.test(text)) {
            const lowerText = text.toLowerCase();
            if (!lowerText.includes('button') && !lowerText.includes('create') && 
                !lowerText.includes('render') && !lowerText.includes('http')) {
              return text;
            }
          }
        }
        return null;
      });
      
      // Also try to check clipboard
      const clipboard = await page.evaluate(async () => {
        try {
          return await navigator.clipboard.readText();
        } catch (e) {
          return null;
        }
      });
      
      console.log('Key from page:', key ? 'FOUND' : 'NOT FOUND');
      console.log('Key from clipboard:', clipboard ? 'FOUND' : 'NOT FOUND');
      
      if (key) {
        apiKey = key;
        fs.writeFileSync('/tmp/render_api_key_real.txt', apiKey);
      } else if (clipboard && clipboard.length > 30) {
        apiKey = clipboard;
        fs.writeFileSync('/tmp/render_api_key_real.txt', apiKey);
      }
    }
    
    // === STEP 3: Create the service ===
    if (apiKey) {
      console.log('\n=== STEP 3: Creating web service on Render ===');
      
      // Use the API key to call the GraphQL endpoint
      const createServiceQuery = `
        mutation CreateService($input: ServicePOST!) {
          createService(input: $input) {
            id
            name
            url
            serviceType
            state
            __typename
          }
        }
      `;
      
      // We need to construct the proper GraphQL mutation
      // Let's first check the correct GraphQL schema
      
      const serviceInput = {
        autoDeploy: "commit",
        autoDeployTrigger: "commit",
        branch: "main",
        envVars: {
          FB999_PASSWORD: "Drewziwugod6",
          FB999_PHONE: "2349121493739",
          NODE_ENV: "production",
          PORT: "3000"
        },
        name: "wingo-racer",
        ownerId: WORKSPACE_ID,
        repo: "https://github.com/clipuni34-coder/Syntheniq",
        rootDir: "",
        serviceDetails: {
          disk: null,
          plan: "free",
          region: "oregon",
          runtime: "docker",
          healthCheckPath: "/health",
          numInstances: 1
        },
        type: "web_service"
      };
      
      const result = await makeGraphQLRequest(page, createServiceQuery, { input: serviceInput });
      console.log('Service creation result:', JSON.stringify(result, null, 2));
    }

    await browser.close();
    console.log('\n=== Deploy script completed ===');
    
  } catch (error) {
    console.error('=== ERROR ===');
    console.error(error.message);
    console.error(error.stack);
    try {
      await page.screenshot({ path: '/workspace/app/screenshots/deploy-error.png', fullPage: true });
    } catch (e) {}
    await browser.close();
  }
}

main().catch(console.error);
