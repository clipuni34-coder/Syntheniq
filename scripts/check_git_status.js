const { execSync } = require('child_process');
const { exec } = require('child_process');

console.log('=== Current Branch ===', execSync('cd /workspace/app && git branch --show-current').toString().trim());
console.log('\n=== Recent Commits (current branch) ===');
console.log(execSync('cd /workspace/app && git log --oneline -10').toString());
console.log('=== All Branches ===');
console.log(execSync('cd /workspace/app && git branch -a').toString());
console.log('=== Status ===');
console.log(execSync('cd /workspace/app && git status --short').toString());

// Check for differences vs main
try {
  const diff = execSync('cd /workspace/app && git diff main --stat 2>/dev/null', { encoding: 'utf8' });
  console.log('\n=== Diff vs main ===');
  console.log(diff || '(no diff or main not found)');
} catch(e) {}
