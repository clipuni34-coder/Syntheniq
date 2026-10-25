#!/usr/bin/env node
/**
 * appsync_introspection.js
 *
 * The JS bundle reveals fb999 uses "AWS AppSync GraphQL real-time subscriptions".
 * This script attempts to:
 * 1. Discover the AppSync GraphQL endpoint from the JWT
 * 2. Run GraphQL introspection to find available subscriptions
 * 3. Look for result-pushing subscriptions like onCreateResult, onWinGoResult, etc.
 */

'use strict';
const https = require('https');
const fs = require('fs');

// Load JWT
let JWT;
try {
  const login = JSON.parse(fs.readFileSync('/tmp/fb999_login_response.json', 'utf8'));
  JWT = login.data?.token;
} catch (e) {
  console.error('No JWT:', e.message);
  process.exit(1);
}

// Parse JWT to find AppSync endpoint
const parts = JWT.split('.');
const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
console.log('JWT payload:');
console.log(JSON.stringify(payload, null, 2));

// The WS URL is in the login response
const login = JSON.parse(fs.readFileSync('/tmp/fb999_login_response.json', 'utf8'));
const wsUrl = login.data?.webSocketUrl;
console.log('\nWebSocket URL:', wsUrl?.substring(0, 100));

// Try to derive the GraphQL endpoint
const wsHost = new URL(wsUrl).hostname;
console.log('WS Host:', wsHost);

// AppSync GraphQL endpoint pattern: https://<host>/graphql
// Try to find the GraphQL endpoint
const graphqlEndpoints = [
  `https://${wsHost}/graphql`,
  'https://fb999api.com/graphql',
  'https://h5.ar-lottery06.com/graphql',
];

function httpRequest(hostname, path, method = 'GET', body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const h = {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15',
      ...headers
    };
    if (body) h['Content-Length'] = Buffer.byteLength(body);
    
    const req = https.request({
      hostname: hostname,
      path: path,
      method: method,
      headers: h,
      timeout: 5000
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    if (body) req.write(body);
    req.end();
  });
}

(async () => {
  console.log('\n=== Trying GraphQL introspection ===');
  
  // Try introspection query
  const introspectionQuery = JSON.stringify({
    query: `query IntrospectionQuery {
      __schema {
        queryType { name }
        mutationType { name }
        subscriptionType { name }
        types {
          name
          kind
          fields(includeDeprecated: true) {
            name
            type { name kind ofType { name kind } }
          }
        }
        directives {
          name
          locations
        }
      }
    }`
  });
  
  for (const endpoint of graphqlEndpoints) {
    try {
      const url = new URL(endpoint);
      console.log('\nTrying:', endpoint);
      const res = await httpRequest(url.hostname, url.pathname, 'POST', introspectionQuery, {
        Authorization: `Bearer ${JWT}`
      });
      console.log('Status:', res.status);
      if (res.status === 200) {
        const json = JSON.parse(res.body);
        if (json.__schema) {
          console.log('✅ Found GraphQL schema!');
          console.log('Subscription type:', json.__schema.subscriptionType?.name || 'NONE');
          
          // Find result-related types
          const types = json.__schema.types || [];
          console.log('\nAll types:');
          types.forEach(t => console.log(`  ${t.kind} ${t.name}`));
          
          // Find subscription fields
          const subType = types.find(t => t.name === json.__schema.subscriptionType?.name);
          if (subType) {
            console.log('\nSubscription fields:');
            subType.fields.forEach(f => {
              console.log(`  ${f.name} -> ${JSON.stringify(f.type)}`);
            });
          }
          
          // Save full schema
          fs.writeFileSync('/tmp/appsync_schema.json', JSON.stringify(json, null, 2));
          console.log('\nSaved: /tmp/appsync_schema.json');
        } else {
          console.log('Response:', res.body.substring(0, 200));
        }
      } else {
        console.log('Response:', res.body.substring(0, 100));
      }
    } catch (e) {
      console.log('Error:', e.message);
    }
  }
})();
