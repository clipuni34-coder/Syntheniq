const fs = require('fs');
const bundle = fs.readFileSync('/tmp/fb999_bundle_final.js', 'utf8');

console.log('=== Bundle Channel/WS Search ===');
console.log('Bundle size:', bundle.length);

// Search for notifyWs initialization - this is the key to finding channels
console.log('\n=== notifyWs (notification WebSocket) ===');
const notifyIdx = bundle.indexOf('notifyWs');
if (notifyIdx >= 0) {
  console.log('Found at', notifyIdx);
  console.log('Context:', bundle.substring(Math.max(0, notifyIdx-300), notifyIdx+800));
}

// Find the channel config object (tte = {wallet, withdraw, activity})
console.log('\n=== Channel config object ===');
const channelIdx = bundle.indexOf('wallet');
if (channelIdx >= 0) {
  const context = bundle.substring(Math.max(0, channelIdx-300), channelIdx+500);
  console.log('Context:', context);
}

// Look for WebSocket connection patterns
console.log('\n=== WebSocket references ===');
let wsIdx = 0;
let wsCount = 0;
while ((wsIdx = bundle.indexOf('WebSocket', wsIdx)) !== -1 && wsCount < 10) {
  console.log('At', wsIdx, ':', bundle.substring(Math.max(0, wsIdx-50), wsIdx+150).replace(/\n/g, ' '));
  wsIdx++;
  wsCount++;
}

// Look for FCM/Push configuration
console.log('\n=== FCM/Push config ===');
const fcmIdx = bundle.indexOf('firebaseConfig');
if (fcmIdx >= 0) {
  console.log('firebaseConfig at', fcmIdx);
  console.log('Context:', bundle.substring(fcmIdx-100, fcmIdx+300));
}

// Search for AppSync-related setup
console.log('\n=== AppSync configuration ===');
const appsyncIdx = bundle.indexOf('aws_appsync');
if (appsyncIdx >= 0) {
  console.log('aws_appsync at', appsyncIdx);
  console.log('Context:', bundle.substring(appsyncIdx-50, appsyncIdx+250));
}

// Search for how WinGo results are fetched
console.log('\n=== WinGo result fetching patterns ===');
const patterns = [
  'GetWinTheLotteryResult',
  'GetLastFiveIssueNumberResult',
  'GetHistoryIssue',
  'GetGameIssue',
  'GetNoaverageEmerdList',
  'GetMyEmerdList',
  'GetEmerdList',
  'GetTypeList',
  'GameBetting',
];
for (const p of patterns) {
  const idx = bundle.indexOf(p);
  if (idx >= 0) {
    console.log(`\n${p} at ${idx}:`);
    console.log('  ', bundle.substring(Math.max(0, idx-50), idx+100).replace(/\n/g, ' '));
  }
}

// Search for polling/timing patterns
console.log('\n=== Polling/timing patterns ===');
const timingIdx = bundle.indexOf('setInterval');
let count = 0;
let sIdx = 0;
while ((sIdx = bundle.indexOf('setInterval', sIdx)) !== -1 && count < 5) {
  console.log('setInterval at', sIdx, ':', bundle.substring(Math.max(0, sIdx-50), sIdx+150).replace(/\n/g, ' '));
  sIdx++;
  count++;
}

// Search for how results trigger updates
console.log('\n=== Result update triggers ===');
const updatePatterns = ['updateResult', 'setResult', 'refreshResult', 'getResult', 'onResult', 'pushResult', 'emit.*result', 'dispatch.*result'];
for (const p of updatePatterns) {
  const idx = bundle.indexOf(p);
  if (idx >= 0) {
    console.log(`${p} at ${idx}:`, bundle.substring(Math.max(0, idx-100), idx+100).replace(/\n/g, ' '));
  }
}

console.log('\n=== Analysis Complete ===');
