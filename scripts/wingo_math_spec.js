const fs = require('fs');
const crypto = require('crypto');
const https = require('https');

console.log('=== WinGo Result Mathematics — Complete Specification ===\n');

const WINNING_NUMBER_RANGE = '0-9';
console.log('=== 1. WINNING NUMBER GENERATION ===');
console.log('The winning number (0-9) is generated server-side via a cryptographically secure RNG.');
console.log('No predictable sequence formula was found:');
console.log('  - Draw server config (/WinGo/WinGo_30S.json) contains NO seed value');
console.log('  - Hash(issueNumber) mod 10: max 40% match (SHA1) — within random noise');
console.log('  - No correlation between issueNumber/timestamp and result number');
console.log('\nConclusion: The number is NOT predictable. It is server-generated randomness.\n');

console.log('=== 2. COLOR DERIVATION (from result number) ===');
console.log('Color is derived from the winning number:\n');
console.log('Number | Rule      | Color       | Bets Won');
console.log('-------|-----------|-------------|----------');
const rules = [
  { n: 0,  rule: 'Special',   color: 'red,violet',   won: 'Red, Violet' },
  { n: 1,  rule: 'Odd',       color: 'green',        won: 'Green' },
  { n: 2,  rule: 'Even',      color: 'red',          won: 'Red' },
  { n: 3,  rule: 'Odd',       color: 'green',        won: 'Green' },
  { n: 4,  rule: 'Even',      color: 'red',          won: 'Red' },
  { n: 5,  rule: 'Special',   color: 'green,violet', won: 'Green, Violet' },
  { n: 6,  rule: 'Even',      color: 'red',          won: 'Red' },
  { n: 7,  rule: 'Odd',       color: 'green',        won: 'Green' },
  { n: 8,  rule: 'Even',      color: 'red',          won: 'Red' },
  { n: 9,  rule: 'Odd',       color: 'green',        won: 'Green' },
];
rules.forEach(r => {
  console.log(`${r.n}      | ${r.rule.padEnd(9)} | ${r.color.padEnd(12)} | ${r.won}`);
});

console.log('\nExact function:');
console.log('function deriveColor(n) {');
console.log('  n = parseInt(n);');
console.log('  if (n === 0) return "red,violet";');
console.log('  if (n === 5) return "green,violet";');
console.log('  if (n % 2 === 0) return "red";  // even (2,4,6,8)');
console.log('  if (n % 2 === 1) return "green"; // odd (1,3,7,9)');
console.log('  return "unknown";');
console.log('}');

console.log('\n=== 3. BIG/SMALL DERIVATION ===');
console.log('function deriveBigSmall(n) {');
console.log('  n = parseInt(n);');
console.log('  return n >= 5 ? "big" : "small";');
console.log('}');
console.log('  0,1,2,3,4 → Small');
console.log('  5,6,7,8,9 → Big');

console.log('\n=== 4. ISSUE NUMBER FORMAT ===');
console.log('Format: YYYYMMDD + 7-digit sequential counter');
console.log('Example: 20261023100050947');
console.log('  Date prefix: 20261023 (YYYYMMDD)');
console.log('  Counter: 100050947 (sequential, increments per 30s round)');
console.log('  2880 rounds per day (24h × 2 rounds/min × 60 min)');

console.log('\n=== 5. API ENDPOINTS ===');
console.log('Draw server (no auth required):');
console.log('  GET /WinGo/WinGo_30S.json');
console.log('    → {gameCode, intervalMinute, state, previous, current, next}');
console.log('    → Each: {issueNumber, startTime, endTime} (epoch ms)');
console.log('  GET /WinGo/WinGo_30S/GetHistoryIssuePage.json?pageNo=1&pageSize=10');
console.log('    → {data: {list: [{issueNumber, number, color, premium, sum}], pageNo, totalPage, totalCount}}');
console.log('');
console.log('API (auth required - Bearer JWT):');
console.log('  POST /api/webapi/GetGameIssue        → current round issue + close time');
console.log('  POST /api/webapi/GetLastFiveIssueNumberResult → last 5 results as "n,n,n,n,n"');
console.log('  POST /api/webapi/GetWinTheLotteryResult → per-bet W/L (needs IssueNumber)');

console.log('\n=== 6. BETTING WIN CONDITIONS ===');
console.log('SelectType → Wins if:');
console.log('  "Red"     → result color contains "red"   (0,2,4,6,8)');
console.log('  "Green"   → result color contains "green" (1,3,5,7,9)');
console.log('  "Violet"  → result color contains "violet"(0,5)');
console.log('  "Big"     → number >= 5                   (5,6,7,8,9)');
console.log('  "Small"   → number < 5                    (0,1,2,3,4)');
console.log('  "Num_0".."Num_9" → number === bet number');

console.log('\n=== 7. TIMING (where result data originates) ===');
console.log('Draw server publishes result ~2,200ms BEFORE round close (endTime)');
console.log('This is the EARLIEST source — no faster channel exists');
console.log('API LastFive results lag behind by ~30s (delayed refresh)');
console.log('API GetGameIssue detects round close (issueNumber → next) ~at close time');

console.log('\n=== VERIFICATION ===');

// Verify against actual history
function fetch(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

(async () => {
  const histRaw = await fetch('https://draw.ar-lottery06.com/WinGo/WinGo_30S/GetHistoryIssuePage.json?pageNo=1&pageSize=10');
  const hist = JSON.parse(histRaw);
  const list = hist.data.list;

  console.log('Verifying color derivation against live API data:');
  let allMatch = true;
  list.forEach(item => {
    const n = parseInt(item.number);
    let expected;
    if (n === 0) expected = 'red,violet';
    else if (n === 5) expected = 'green,violet';
    else expected = n % 2 === 0 ? 'red' : 'green';

    const match = expected === item.color;
    if (!match) allMatch = false;
    console.log(`  ${item.number} → expected: ${expected}, got: ${item.color} ${match ? '✓' : '✗'}`);
  });
  console.log(`\nAll colors match derivation: ${allMatch}`);

  // Verify premium
  const premiumMatches = list.every(item => item.premium === item.number);
  console.log(`Premium == Number for all: ${premiumMatches}`);

  // Verify sum = 0
  const sumZero = list.every(item => item.sum === 0);
  console.log(`Sum == 0 for all: ${sumZero}`);
})().catch(e => console.error(e));
