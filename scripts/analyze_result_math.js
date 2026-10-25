const https = require('https');

console.log('=== Fetching fresh draw server data to analyze result structure ===\n');

function fetch(url, opts = {}) {
  return new Promise((resolve, reject) => {
    https.get(url, opts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    }).on('error', reject);
  });
}

(async () => {
  // Fetch history - look at the full structure including premium, sum
  const histRes = await fetch('https://draw.ar-lottery06.com/WinGo/WinGo_30S/GetHistoryIssuePage.json?pageNo=1&pageSize=10');
  const hist = JSON.parse(histRes.body);

  console.log('=== History Response Structure ===');
  console.log('Top-level keys:', Object.keys(hist));
  console.log('data keys:', Object.keys(hist.data));
  console.log('List length:', hist.data.list.length);

  console.log('\n=== Full History Entries ===');
  hist.data.list.forEach((item, i) => {
    console.log(`Entry ${i}:`);
    console.log('  issueNumber:', item.issueNumber);
    console.log('  number:', item.number);
    console.log('  color:', item.color);
    console.log('  premium:', item.premium);
    console.log('  sum:', item.sum);
    console.log('  All keys:', Object.keys(item));

    // Derive the math
    const n = parseInt(item.number);
    const bigSmall = n >= 5 ? 'Big' : 'Small';
    const oddEven = n % 2 === 0 ? 'Even' : 'Odd';

    // The actual color rule from API:
    // 0 -> red,violet (wins Red AND Violet)
    // 5 -> green,violet (wins Green AND Violet)
    // 1,3,7,9 -> green (odd greens)
    // 2,4,6,8 -> red (even reds)
    let expectedColor;
    if (n === 0) expectedColor = 'red,violet';
    else if (n === 5) expectedColor = 'green,violet';
    else if (n % 2 === 0) expectedColor = 'red';
    else expectedColor = 'green';

    // premium
    const expectedPremium = n >= 5 ? String(n) : (n === 0 ? '0' : String(n));

    console.log(`  Math: Big/Small=${bigSmall}, Odd/Even=${oddEven}`);
    console.log(`  Expected color: ${expectedColor} | API color: ${item.color} | Match: ${expectedColor === item.color}`);
    console.log(`  Premium (API)={${typeof item.premium} : ${item.premium}}`);
    console.log();
  });

  // Also fetch config
  const cfgRes = await fetch('https://draw.ar-lottery06.com/WinGo/WinGo_30S.json');
  const cfg = JSON.parse(cfgRes.body);

  console.log('\n=== Current Config ===');
  console.log(JSON.stringify(cfg, null, 2));

  // Analyze the config structure
  console.log('\n=== Config Analysis ===');
  console.log('gameCode:', cfg.gameCode);
  console.log('intervalMinute:', cfg.intervalMinute);
  console.log('state:', cfg.state);
  console.log('current.startTime:', cfg.current?.startTime);
  console.log('current.endTime:', cfg.current?.endTime);
  console.log('current.issueNumber:', cfg.current?.issueNumber);
  console.log('current.endTime type:', typeof cfg.current?.endTime);
  const epoch = new Date(cfg.current.endTime).getTime();
  console.log('current.endTime epoch:', epoch);
  console.log('current.endTime - now:', epoch - Date.now(), 'ms');
})().catch(e => console.error('Error:', e));
