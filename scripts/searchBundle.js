/**
 * Final check: Search JS bundle for faster result endpoints
 * Fetches the fb998.com JS bundle and searches for:
 * - Result-fetching endpoints
 * - WebSocket URLs
 * - Any API path that might publish results earlier
 */

const https = require('https');
const fs = require('fs');

function httpRequest(hostname, path) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path, method: 'GET' }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function main() {
  console.log('=== Searching JS bundle for result endpoints ===\n');

  // Fetch the main JS bundle
  const bundleRes = await httpRequest('fb999.com', '/assets/js/ar004-DhGka_VW.js');
  const bundle = bundleRes.body;
  
  console.log(`Bundle fetched: ${bundle.length} bytes`);
  
  // Search for interesting patterns
  const patterns = [
    /getHistoryIssue|GetHistoryIssue/i,
    /getResult|GetResult|result/i,
    /getIssue|GetIssue|currentIssue/i,
    /WinGoBet|WinGoBatchBet|WinGo/i,
    /websocket|wss:\/\/|WebSocket/i,
    /Token|token|ar_token/i,
    /lottery|Lottery/i,
    /draw\.ar-lottery|ar-lottery06/i,
    /webapi|api\/webapi/i,
  ];
  
  const found = new Map();
  
  for (const pattern of patterns) {
    let match;
    const regex = new RegExp(pattern.source, pattern.flags || 'gi');
    found.set(pattern.source, []);
    while ((match = regex.exec(bundle)) !== null) {
      const context = bundle.substring(Math.max(0, match.index - 80), match.index + 150);
      found.get(pattern.source).push({
        index: match.index,
        text: context.replace(/\n/g, ' ').trim()
      });
    }
  }
  
  // Report findings
  for (const [pattern, matches] of found) {
    if (matches.length > 0) {
      console.log(`\nPattern: /${pattern}/ (${matches.length} matches)`);
      // Show unique context snippets
      const unique = [...new Set(matches.map(m => m.text))];
      unique.slice(0, 5).forEach(m => {
        console.log(`  "${m}"`);
      });
    }
  }
  
  // Search for API endpoint patterns
  console.log('\n--- API Endpoint Patterns ---');
  const endpointRegex = /api\/[a-zA-Z]+\/[A-Z][a-zA-Z]+/g;
  let epMatch;
  const endpoints = new Set();
  while ((epMatch = endpointRegex.exec(bundle)) !== null) {
    endpoints.add(epMatch[0]);
  }
  console.log('Endpoints found:');
  endpoints.forEach(e => console.log(`  /${e}`));
  
  // Search for draw server URLs
  console.log('\n--- Draw Server URLs ---');
  const drawRegex = /draw\.ar-lottery\d+\.[a-z]+\/[^\s"']*/g;
  let drawMatch;
  while ((drawMatch = drawRegex.exec(bundle)) !== null) {
    console.log(`  ${drawMatch[0]}`);
  }
  
  // Search for WebSocket URLs
  console.log('\n--- WebSocket URLs ---');
  const wsRegex = /wss?:\/\/[^\s"']+/g;
  let wsMatch;
  while ((wsMatch = wsRegex.exec(bundle)) !== null) {
    console.log(`  ${wsMatch[0]}`);
  }
  
  // Search for API base URLs
  console.log('\n--- API Base URLs ---');
  const apiRegex = /https?:\/\/(?:fb999api|fb998|ar-lottery|h5)\.[^\s"'{}]+/g;
  let apiMatch;
  const urls = new Set();
  while ((apiMatch = apiRegex.exec(bundle)) !== null) {
    urls.add(apiMatch[0]);
  }
  urls.forEach(u => console.log(`  ${u}`));
  
  console.log('\n=== Search complete ===');
}

main().catch(e => console.error('Error:', e.message));
