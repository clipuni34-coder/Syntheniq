'use strict';

/**
 * intercept-requests.js
 *
 * Intercept and log the actual request bodies that the app sends to the API
 */

const fs = require('fs');
const puppeteer = require('puppeteer');

const CHROME_PATH = '/tmp/kilo-worktrees/7d9ea8c271d620db7d7041a95206014c8bef6000117fc15d4d157608f2c3e186/.cache/puppeteer/chrome/linux-155.0.8059.79/chrome-linux64/chrome';
const TOKENS_FILE = '/tmp/viralclips_tokens.json';
const LOG_FILE = '/tmp/viralclips_request_interception.log';

let logBuf = '';
function log(msg) {
    console.log(msg);
    logBuf += msg + '\n';
}

async function main() {
    const tokens = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8'));
    const payload = JSON.parse(fs.readFileSync('/tmp/viralclips_jwt_payload.json', 'utf8'));

    log('=== Request Interception ===');
    log('User: ' + payload.email);
    log('');

    const browser = await puppeteer.launch({
        executablePath: CHROME_PATH,
        headless: 'new',
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--disable-web-security',
            '--ignore-certificate-errors',
            '--window-size=1920,1080',
        ],
    });

    const page = await browser.newPage();
    await page.setJavaScriptEnabled(true);

    // Intercept requests to log POST bodies
    await page.setRequestInterception(true);

    page.on('request', (request) => {
        const url = request.url();
        const method = request.method();

        if (url.includes('api.opus.pro') || url.includes('session-profile') || url.includes('auth')) {
            log('REQUEST: ' + method + ' ' + url);
            const postData = request.postData();
            if (postData) {
                log('  POST Body: ' + postData.substring(0, 1000));
            }
            const hdrs = request.headers();
            const authHeaders = Object.entries(hdrs).filter(([k]) =>
                k.includes('cookie') || k.includes('auth') || k.includes('authorization') || k.includes('x-opus')
            );
            for (const [k, v] of authHeaders) {
                log('  Header: ' + k + ': ' + String(v).substring(0, 100));
            }
            log('');
        }

        request.continue();
    });

    page.on('response', (response) => {
        const url = response.url();
        if (url.includes('api.opus.pro') || url.includes('session-profile') || url.includes('auth')) {
            log('RESPONSE: ' + response.status() + ' ' + url);
        }
    });

    page.on('console', (msg) => {
        if (msg.type() === 'error') {
            log('[console.error] ' + msg.text().substring(0, 200));
        }
    });

    page.on('pageerror', (err) => {
        log('[pageerror] ' + err.message.substring(0, 300));
    });

    // Set cookies
    log('Setting cookies...');
    const cookieDomain = 'clip.opus.pro';
    const cookies = [
        { name: 'id_token', value: tokens.id_token, domain: cookieDomain, path: '/', secure: false },
        { name: 'access_token', value: tokens.access_token, domain: cookieDomain, path: '/', secure: false },
        { name: 'refresh_token', value: tokens.refresh_token, domain: cookieDomain, path: '/', secure: false },
        { name: 'idToken', value: tokens.id_token, domain: cookieDomain, path: '/', secure: false },
        { name: 'accessToken', value: tokens.access_token, domain: cookieDomain, path: '/', secure: false },
        { name: 'refreshToken', value: tokens.refresh_token, domain: cookieDomain, path: '/', secure: false },
    ];
    for (const c of cookies) {
        try { await page.setCookie(c); } catch (e) { log('WARN: ' + e.message); }
    }

    // Try without localStorage injection first to see the natural OAuth flow
    log('\nNavigating to /dashboard...');
    try {
        await page.goto('https://clip.opus.pro/dashboard', {
            waitUntil: ['domcontentloaded'],
            timeout: 30000,
        });
        log('DOM loaded');
    } catch (e) {
        log('Navigation: ' + e.message);
    }

    log('Waiting 15s for client-side processing...');
    await new Promise(r => setTimeout(r, 15000));

    log('\nFinal URL: ' + page.url());

    // Get all cookies
    const finalCookies = await page.cookies();
    log('\nCookies after navigation (' + finalCookies.length + '):');
    for (const c of finalCookies) {
        log('  ' + c.name + ' = ' + c.value.substring(0, 80) + '... (domain: ' + c.domain + ', path: ' + c.path + ')');
    }

    // Check for OAuth-related elements in the DOM
    const oauthInfo = await page.evaluate(() => {
        const links = Array.from(document.querySelectorAll('a[href]'));
        const oauthLinks = links.filter(a => {
            const href = a.href.toLowerCase();
            return href.includes('oauth') || href.includes('google') || href.includes('auth') || href.includes('login') || href.includes('cognito');
        });

        const buttons = Array.from(document.querySelectorAll('button'));
        const authButtons = buttons.filter(b => {
            const text = b.textContent?.toLowerCase() || '';
            const id = b.id?.toLowerCase() || '';
            return text.includes('sign in') || text.includes('log in') || text.includes('google') || text.includes('sso') || id.includes('oauth') || id.includes('auth');
        });

        const scripts = Array.from(document.querySelectorAll('script[src]')).map(s => s.src);
        const divs = Array.from(document.querySelectorAll('div'))
            .filter(d => d.textContent?.trim().length > 5)
            .slice(0, 30)
            .map(d => ({ text: d.textContent.trim().substring(0, 100), class: d.className.split(' ').slice(0, 3).join(' ') }));

        return {
            oauthLinks: oauthLinks.map(a => ({ href: a.href, text: a.textContent?.trim() })),
            authButtons: authButtons.map(b => ({ text: b.textContent?.trim(), id: b.id, class: b.className })),
            scripts,
            bodyText: document.body ? document.body.innerText?.substring(0, 500) : '',
            divCount: document.querySelectorAll('div').length,
        };
    });

    log('\nPage elements:');
    log('  OAuth links: ' + JSON.stringify(oauthInfo.oauthLinks, null, 2));
    log('  Auth buttons: ' + JSON.stringify(oauthInfo.authButtons, null, 2));
    log('  Scripts: ' + oauthInfo.scripts.length);
    log('  Div count: ' + oauthInfo.divCount);
    log('  Body text: ' + oauthInfo.bodyText?.substring(0, 300));

    await browser.close();
    fs.writeFileSync(LOG_FILE, logBuf);
    log('\nLog saved to ' + LOG_FILE);
}

main().catch(e => {
    console.error('Fatal:', e);
    fs.writeFileSync(LOG_FILE, logBuf);
    process.exit(1);
});
