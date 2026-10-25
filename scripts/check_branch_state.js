const { execSync } = require('child_process');

try {
  // Show current branch
  const branch = execSync('cd /workspace/app && git branch --show-current', { encoding: 'utf8' }).trim();
  console.log('Current branch:', branch);

  // Show last 5 commits
  const log = execSync('cd /workspace/app && git log --oneline -5', { encoding: 'utf8' });
  console.log('\nLast 5 commits:');
  console.log(log);

  // Show uncommitted changes
  const status = execSync('cd /workspace/app && git status --short', { encoding: 'utf8' });
  console.log('Uncommitted changes:');
  console.log(status || '(none)');

  // Show diff summary
  const diffStat = execSync('cd /workspace/app && git diff --stat HEAD', { encoding: 'utf8' });
  console.log('Changes vs HEAD:');
  console.log(diffStat || '(no changes)');

  // Check if Fly.io deployed version matches
  console.log('\n=== Files that affect deployment ===');
  const deployFiles = execSync('cd /workspace/app && git diff --name-only HEAD -- app.js server.js Dockerfile fly.toml package.json', { encoding: 'utf8' });
  console.log(deployFiles || '(no changes to deploy files)');
} catch(e) {
  console.error('Error:', e.message);
}
