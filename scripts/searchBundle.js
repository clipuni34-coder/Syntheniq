/**
 * Fixed: Search JS bundle for result endpoints
 * - Adds 'g' flag to all regexes (prevents infinite exec loops)
 * - Checks content type / detects HTML vs JS
 * - Limits matches to prevent memory issues
 */

const https = require('https');

function httpRequest(hostname, path) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path, method: 'GET' }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    req.end();
  });
}

const MAX_MATCHES = 5000;

function searchPattern(bundle, regex, label) {
  const samples = [];
  let count = 0;
  let m;
  while ((m = regex.exec(bundle)) !== null) {
    count++;
    if (samples.length < 5) {
      const context = bundle.substring(Math.max(0, m.index - 80), m.index + 150).replace(/\n/g, ' ').trim();
      samples.push(context);
    }
    if (count >= MAX_MATCHES) {
      break;
    }
  }
  if (count > 0) {
    console.log(`\nPattern: ${label} (${count} matches${count >= MAX_MATCHES ? '+' : ''})`);
    samples.forEach(ctx => console.log(`  "${ctx}"`));
  }
  return count;
}

async function main() {
  console.log('=== Searching JS bundle for result endpoints ===\n');

  const urlsToTry = [
    { hostname: 'fb999.com', path: '/assets/js/ar004-DhGka_VW.js', label: 'ar004-DhGka_VW.js' },
    { hostname: 'fb999.com', path: '/assets/js/index-BNKNCcsL.js', label: 'index-BNKNCcsL.js' },
  ];

  for (const url of urlsToTry) {
    console.log(`\n>>> Fetching: https://${url.hostname}${url.path} (${url.label})`);
    let bundleRes;
    try {
      bundleRes = await httpRequest(url.hostname, url.path);
    } catch (e) {
      console.log(`  Error fetching: ${e.message}`);
      continue;
    }

    const body = bundleRes.body;
    const contentType = bundleRes.headers['content-type'] || 'unknown';
    console.log(`  Status: ${bundleRes.status}, Content-Type: ${contentType}, Size: ${body.length} bytes`);

    // Check if this is actually JS
    const isHTML = body.trimStart().startsWith('<!DOCTYPE') || body.trimStart().startsWith('<html');
    const isJS = !isHTML && (contentType.includes('javascript') || body.includes('function') || body.includes('=>'));
    console.log(`  Detected as: ${isHTML ? 'HTML' : (isJS ? 'JavaScript' : 'unknown')}`);

    if (isHTML) {
      // Extract referenced JS files
      const jsFiles = [...new Set(body.matchAll(/src=["']([^"']+\.js)["']/g))].map(m => m[1]);
      console.log(`  JS files referenced: ${jsFiles.length}`);
      jsFiles.forEach(f => console.log(`    ${f}`));
      continue;
    }

    console.log(`\n  Bundle fetched: ${body.length} bytes`);

    // Search for patterns
    const patterns = [
      [/(getHistoryIssue|GetHistoryIssue)/gi, 'getHistoryIssue'],
      [/(getResult|GetResult|getIssue|GetIssue)/gi, 'result/issue getters'],
      [/(currentIssue|CurrentIssue)/gi, 'currentIssue'],
      [/(WinGoBet|WinGoBatchBet|WinGo|Wingoo|Wingo)/gi, 'WinGo'],
      [/(websocket|wss:\/\/|WebSocket|WebSocket)/gi, 'websocket'],
      [/(Token|token|ar_token|authorization|Authorization)/gi, 'token/auth'],
      [/(lottery|Lottery)/gi, 'lottery'],
      [/(draw\.ar-lottery|ar-lottery\d+)/gi, 'draw.ar-lottery'],
      [/(webapi|api\/webapi|webApi)/gi, 'webapi'],
      [/(getResult|pushResult|newResult|issueResult|finalResult|gameResult)/gi, 'result methods'],
      [/(wss?:)?\/\/[^"'\s]+/gi, 'all URLs'],
    ];

    for (const [regex, label] of patterns) {
      searchPattern(body, regex, label);
    }

    console.log('\n  --- API Endpoint Patterns ---');
    const endpointRegex = /api\/[a-zA-Z_/][a-zA-Z0-9_/]+/gi;
    const endpoints = new Set();
    let epMatch;
    while ((epMatch = endpointRegex.exec(body)) !== null) {
      endpoints.add(epMatch[0]);
      if (endpoints.size > 200) break;
    }
    console.log('  Endpoints found:');
    endpoints.forEach(e => console.log(`    /${e}`));

    console.log('\n  --- WebSocket URLs ---');
    const wsRegex = /wss?:\/\/[^\s"']+/gi;
    let wsMatch;
    while ((wsMatch = wsRegex.exec(body)) !== null) {
      console.log(`    ${wsMatch[0]}`);
    }

    console.log('\n  --- API Base URLs ---');
    const apiRegex = /https?:\/\/(?:fb999api|fb998|ar-lottery|h5|draw)\.([^"'\s{}]+)/gi;
    const urls = new Set();
    let apiMatch;
    while ((apiMatch = apiRegex.exec(body)) !== null) {
      urls.add(apiMatch[0]);
    }
    urls.forEach(u => console.log(`    ${u}`));

    console.log('\n  --- Full API paths ---');
    const fullApiRegex = /https?:\/\/[^"'\s{}/]+(?:\.com|\.io|\.net|\.org)[^"'\s{}]*/gi;
    const fullUrls = new Set();
    let fullMatch;
    while ((fullMatch = fullApiRegex.exec(body)) !== null) {
      fullUrls.add(fullMatch[0]);
      if (fullUrls.size > 200) break;
    }
    fullUrls.forEach(u => console.log(`    ${u}`));

    console.log('\n  --- String literals with "result" ---');
    const resultRegex = /["'`]([^"'`]*[Rr]esult[^"'`]*)["'`]/gi;
    let rMatch;
    const resultSet = new Set();
    while ((rMatch = resultRegex.exec(body)) !== null) {
      resultSet.add(rMatch[0]);
    }
    resultSet.forEach(s => console.log(`    ${s}`));

    break; // Only search the first URL that returns JS
  }

  console.log('\n=== Search complete ===');
}

main().catch(e => console.error('Error:', e.message));
