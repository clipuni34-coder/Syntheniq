#!/usr/bin/env node
'use strict';
const fs = require('fs');

const bundle = fs.readFileSync('/tmp/fb999_main_bundle.js', 'utf8');

console.log('=== Extracting AppSync config and subscription details ===');

// Find the context around aws_appsync
let idx = 0;
let found = 0;
while ((idx = bundle.indexOf('aws_appsync', idx)) !== -1 && found < 20) {
  console.log(`\n--- Found at position ${idx} ---`);
  console.log(bundle.substring(Math.max(0, idx - 100), idx + 300));
  idx += 200;
  found++;
}

// Search for the WebSocket connection setup
console.log('\n\n=== Searching for WebSocket connection protocol ===');
const wsPatterns = [
  /connection_init/gi,
  /GQL_CONNECTION_INIT/g,
  /GQL_START/g,
  /start.*operationId/gi,
  /operationId.*id/gi,
  /subscribe.*query/gi,
  /subscription\s*\{/gi,
];

for (const p of wsPatterns) {
  const matches = [...bundle.matchAll(p)];
  if (matches.length > 0) {
    console.log(`Pattern /${p.source}/: ${matches.length} matches`);
  }
}

// Look for subscription queries in the bundle
console.log('\n=== Searching for subscription queries ===');
const subRegex = /subscription\s+\w*\s*\{[^}]*\}/gi;
let subMatch;
while ((subMatch = subRegex.exec(bundle)) !== null) {
  console.log('Subscription:', subMatch[0].substring(0, 300));
}

// Look for query patterns
console.log('\n=== Searching for query patterns ===');
const queryRegex = /(query|mutation)\s+\w*\s*\{[^}]{1,500}\}/gi;
let queryMatch;
let queryCount = 0;
while ((queryMatch = queryRegex.exec(bundle)) !== null && queryCount < 20) {
  const text = queryMatch[0];
  // Filter for interesting ones
  if (text.includes('WinGo') || text.includes('Result') || text.includes('Issue') || text.includes('Lottery')) {
    console.log('Found:', text.substring(0, 400));
    queryCount++;
  }
}

// Search for AppSync endpoint
console.log('\n=== Searching for AppSync endpoint URLs ===');
const endpointRegex = /[a-z0-9-]{26}\.appsync-api\.[a-z0-9-]+\.[a-z]{2,3}\/graphql/gi;
const endpoints = [...bundle.matchAll(endpointRegex)];
console.log('AppSync endpoints found:', endpoints.length);
endpoints.slice(0, 5).forEach(e => console.log('  ', e[0]));

// Search for amplify config
console.log('\n=== Amplify config ===');
const amplifyRegex = /aws_amplify|aws-exports|aws\.exports|API.*graphqlUrl|graphqlUrl/gi;
const amplifyMatches = [...bundle.matchAll(amplifyRegex)];
console.log('Amplify config mentions:', amplifyMatches.length);

// Search for region info
console.log('\n=== Searching for AWS region ===');
const regionRegex = /[a-z]{2}-[a-z]+-\d{1}/gi;
const regions = [...bundle.matchAll(regionRegex)];
console.log('Regions mentioned:', new Set(Array.from(regions).map(r => r[0])).size, 'unique values');

// Look for the WebSocket start message format
console.log('\n=== WebSocket message format ===');
const wsStart = bundle.indexOf('connection_init');
if (wsStart >= 0) {
  console.log('connection_init context:', bundle.substring(wsStart - 100, wsStart + 200));
}

// Search for the subscribe payload format
const subPayloadIdx = bundle.indexOf('"subscribe"');
if (subPayloadIdx >= 0) {
  console.log('\n"subscribe" context:', bundle.substring(subPayloadIdx - 50, subPayloadIdx + 200));
}
