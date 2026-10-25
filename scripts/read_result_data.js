const fs = require('fs');

// Load key data sources
const history = JSON.parse(fs.readFileSync('/workspace/app/findings/wingo_history.json', 'utf8'));
const lastFive = JSON.parse(fs.readFileSync('/workspace/app/findings/fb999_GetLastFiveIssueNumberResult_TypeId1_1792515129353.json', 'utf8'));
const lastFive30 = JSON.parse(fs.readFileSync('/workspace/app/findings/fb999_GetLastFiveIssueNumberResult_TypeId29_1792515128925.json', 'utf8'));

console.log('=== WinGo History (30 draws) ===');
console.log(JSON.stringify(history, null, 2));
console.log('\n=== Last Five Issue Result (TypeId1) ===');
console.log(JSON.stringify(lastFive, null, 2));
console.log('\n=== Last Five Issue Result (TypeId30) ===');
console.log(JSON.stringify(lastFive30, null, 2));
