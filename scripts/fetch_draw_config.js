const https = require('https');

console.log('=== Fetching live draw server data ===\n');

// Fetch current config
https.get('https://draw.ar-lottery06.com/WinGo/WinGo_30S.json', (res) => {
  let data = '';
  res.on('data', c => data += c);
  res.on('end', () => {
    console.log('=== /WinGo/WinGo_30S.json (current round config) ===');
    try {
      const parsed = JSON.parse(data);
      console.log(JSON.stringify(parsed, null, 2));
    } catch {
      console.log('Raw:', data.substring(0, 1000));
    }
  });
}).on('error', e => console.error('Config error:', e.message));

// Fetch history
setTimeout(() => {
  https.get('https://draw.ar-lottery06.com/WinGo/WinGo_30S/GetHistoryIssuePage.json?pageNo=1&pageSize=10', (res) => {
    let data = '';
    res.on('data', c => data += c);
    res.on('end', () => {
      console.log('\n=== /WinGo/WinGo_30S/GetHistoryIssuePage.json (history) ===');
      try {
        const parsed = JSON.parse(data);
        console.log(JSON.stringify(parsed, null, 2));

        // Analyze the result format
        if (parsed.data && parsed.data.list) {
          console.log('\n=== Result Analysis ===');
          console.log('Keys in history[0]:', Object.keys(parsed.data.list[0]));
          console.log('Keys in current:', Object.keys(parsed.data));
          console.log('\nHistory entries:');
          parsed.data.list.forEach((item, i) => {
            console.log(`  #${i}: ${JSON.stringify(item)}`);
          });
        }
      } catch {
        console.log('Raw:', data.substring(0, 2000));
      }
    });
  }).on('error', e => console.error('History error:', e.message));
}, 500);
