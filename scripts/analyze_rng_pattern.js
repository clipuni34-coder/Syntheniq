const https = require('https');

console.log('=== Comprehensive Result Mathematics Analysis ===\n');

function fetch(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    }).on('error', reject);
  });
}

async function analyzeHistory() {
  // Fetch 100 results to find RNG pattern
  const res = await fetch('https://draw.ar-lottery06.com/WinGo/WinGo_30S/GetHistoryIssuePage.json?pageNo=1&pageSize=100');
  const data = JSON.parse(res.body);
  const list = data.data.list;

  console.log('=== Full History Analysis (100 entries) ===\n');
  console.log('IssueNumber | Number | Color        | Premium | Sum');
  console.log('-----------|--------|-------------|---------|----');

  list.forEach(item => {
    console.log(`${item.issueNumber} | ${item.number}      | ${item.color.padEnd(12)} | ${item.premium}       | ${item.sum}`);
  });

  // Analyze patterns
  console.log('\n=== Number Distribution ===');
  const counts = {};
  for (let i = 0; i <= 9; i++) counts[i] = 0;
  list.forEach(item => counts[parseInt(item.number)]++);
  for (let i = 0; i <= 9; i++) {
    console.log(`  ${i}: ${counts[i]} (${(counts[i]/list.length*100).toFixed(1)}%)`);
  }

  // Check if numbers follow a pattern based on issue number
  console.log('\n=== Issue Number Analysis ===');
  console.log('Issue number format: YYYYMMDD + sequence');
  const firstIssue = list[0].issueNumber;
  const lastIssue = list[list.length-1].issueNumber;
  const firstSeq = parseInt(firstIssue.substring(firstIssue.length-7));
  const lastSeq = parseInt(lastIssue.substring(lastIssue.length-7));
  console.log(`First: ${firstIssue} (seq=${firstSeq})`);
  console.log(`Last: ${lastIssue} (seq=${lastSeq})`);
  console.log(`Sequence span: ${lastSeq - firstSeq}`);

  // Try to find pattern: hash(issueNumber) mod 10 = number?
  const crypto = require('crypto');
  console.log('\n=== Checking if number = f(issueNumber) ===');

  const hashAlgos = ['md5', 'sha256', 'sha1'];
  hashAlgos.forEach(algo => {
    let matchCount = 0;
    list.forEach(item => {
      const hash = crypto.createHash(algo).update(item.issueNumber).digest('hex');
      const lastChar = hash[hash.length - 1];
      const lastNum = parseInt(lastChar, 16) % 10;
      if (lastNum === parseInt(item.number)) matchCount++;
    });
    console.log(`  ${algo}(issueNumber) last char mod 10: ${matchCount}/${list.length} match (${(matchCount/list.length*100).toFixed(1)}%)`);
  });

  // Try timestamp-based
  console.log('\n=== Checking timestamp-based patterns ===');
  list.forEach(item => {
    // Try extracting date/time from issue number
    const issue = item.issueNumber;
    const year = issue.substring(0,4);
    const month = issue.substring(4,6);
    const day = issue.substring(6,8);
    const seq = issue.substring(8);
    console.log(`  ${item.number} | issue=${issue} date=${year}-${month}-${day} seq=${seq}`);
  });

  // Check if number correlates with sum
  console.log('\n=== Premium and Sum Analysis ===');
  const premiumValues = [...new Set(list.map(l => l.premium))];
  const sumValues = [...new Set(list.map(l => l.sum))];
  console.log('Unique premiums:', premiumValues);
  console.log('Unique sums:', sumValues);

  // Check if premium > number or other relationships
  console.log('\n=== Number vs Premium relationship ===');
  let premiumMatches = 0;
  list.forEach(item => {
    if (item.premium === item.number) premiumMatches++;
  });
  console.log(`Premium == Number: ${premiumMatches}/${list.length}`);

  // Check the full config for any seed
  const cfgRes = await fetch('https://draw.ar-lottery06.com/WinGo/WinGo_30S.json');
  const cfg = JSON.parse(cfgRes.body);
  console.log('\n=== Full Config Structure ===');
  console.log(JSON.stringify(cfg, null, 2));
}

analyzeHistory().catch(e => console.error(e));
