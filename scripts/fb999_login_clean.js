#!/usr/bin/env node
'use strict';
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');

const FB999_PHONE = '2349121493739';
const FB999_PASSWORD = 'Drewziwugod6';

function randomHex() { return crypto.randomBytes(16).toString('hex'); }
function md5Hex(str) { return crypto.createHash('md5').update(str).digest('hex').toUpperCase().slice(0, 32); }

function signParams(params) {
  const u = { ...params, language: 0 };
  u.random = randomHex();
  const c = JSON.parse(JSON.stringify(u));
  const o = Object.keys(c).filter(key =>
    !(typeof c[key] === 'object' && c[key] !== null && !Array.isArray(c[key])) && !Array.isArray(c[key]));
  o.sort();
  const i = {};
  o.forEach(key => { if (c[key] !== null && c[key] !== "" && c[key] !== undefined) i[key] = c[key] === 0 ? 0 : c[key]; });
  u.signature = md5Hex(JSON.stringify(i));
  u.timestamp = Math.floor(Date.now() / 1e3);
  return u;
}

function httpRequest(hostname, path, method = 'POST', body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const allHeaders = {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15',
      'Referer': 'https://fb999.com/',
      'Origin': 'https://fb999.com',
      'ar-origin': 'https://fb999.com',
      ...headers
    };
    if (body) {
      allHeaders['Content-Length'] = Buffer.byteLength(body);
    }
    const req = https.request({ hostname, path, method, headers: allHeaders }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.setTimeout(15000);
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function login() {
  const loginParams = {
    username: FB999_PHONE,
    pwd: FB999_PASSWORD,
    phonetype: 2,
    logintype: 'mobile',
    packId: '',
    deviceId: crypto.randomBytes(16).toString('hex'),
    pixelId: '',
    fbcId: '',
    fbc: '',
    fbp: '',
    adId: ''
  };

  const signed = signParams(loginParams);
  console.log('Login attempt with params:', JSON.stringify(signed).substring(0, 500));

  const body = JSON.stringify(signed);
  const res = await httpRequest('fb999api.com', '/api/webapi/Login', 'POST', body);
  console.log('Status:', res.status);
  console.log('Body:', JSON.stringify(res.body).substring(0, 800));

  try {
    const json = JSON.parse(res.body);
    if (json.code === 0 && json.data && json.data.token) {
      console.log('*** LOGIN SUCCESS! ***');
      console.log('Token:', json.data.token.substring(0, 60) + '...');
      console.log('RefreshToken:', json.data.refreshToken ? json.data.refreshToken.substring(0, 60) + '...' : '(none)');
      fs.writeFileSync('/tmp/fb999_login_response.json', JSON.stringify(json, null, 2));
      console.log('Saved to /tmp/fb999_login_response.json');
      return json.data;
    } else {
      console.log('Code:', json.code, 'Msg:', json.msg || '', 'MsgCode:', json.msgCode || '');
    }
  } catch(e) {
    console.log('Parse error:', e.message);
  }
  return null;
}

login();
