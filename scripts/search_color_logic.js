const fs = require('fs');
const bundle = fs.readFileSync('/tmp/fb999_bundle_final.js', 'utf8');

// Search for color mapping logic
console.log('=== Searching for color/number mapping patterns ===\n');

// Find all occurrences of color logic
const patterns = [
  'violet',
  'red',
  'green', 
  'Big',
  'Small',
  'betBig',
  'betSmall',
  'Color_Red',
  'Color_Green',
  'Color_Violet',
  'numberToColor',
  'colorFrom',
];

for (const p of patterns) {
  const idx = bundle.indexOf(p);
  if (idx >= 0) {
    console.log(`\n"${p}" at ${idx}:`);
    // Find a broader context
    let start = idx - 300;
    let end = idx + 300;
    console.log(bundle.substring(Math.max(0, start), Math.min(bundle.length, end)));
    console.log('---');
  }
}

// Search for the actual WinGo result parsing - look for where the number/color comes from API response
console.log('\n=== Searching for result number parsing ===');
const resultPatterns = ['GetWinTheLotteryResult', 'WinGoGetWinTheLotteryResult', 'getWinResult', 'winResult', 'WinGoBet'];
for (const p of resultPatterns) {
  let idx = bundle.indexOf(p);
  let count = 0;
  while (idx >= 0 && count < 3) {
    console.log(`\n"${p}" at ${idx}:`);
    console.log(bundle.substring(Math.max(0, idx - 100), idx + 200));
    console.log('---');
    idx = bundle.indexOf(p, idx + 1);
    count++;
  }
}

// Search for betting type/scope mappings
console.log('\n=== Searching for betting type mappings ===');
const betPatterns = ['SelectType', 'BigSmall', 'Color_Red', 'Color_Green', 'Color_Violet', 'Num_'];
for (const p of betPatterns) {
  const idx = bundle.indexOf(p);
  if (idx >= 0) {
    console.log(`\n"${p}" at ${idx}:`);
    console.log(bundle.substring(Math.max(0, idx - 200), idx + 200));
    console.log('---');
  }
}
