const { execSync } = require('child_process');

console.log('=== Committing changes for Render auto-deploy ===\n');

try {
  // Stage all changes
  console.log('1. Staging files...');
  const add = execSync('cd /workspace/app && git add -A', { encoding: 'utf8' });
  console.log('   Files staged');

  // Show what's being committed
  console.log('\n2. Files to be committed:');
  const staged = execSync('cd /workspace/app && git diff --cached --name-only', { encoding: 'utf8' });
  console.log(staged.split('\n').filter(f => f).join('\n'));

  // Commit
  console.log('\n3. Creating commit...');
  const commit = execSync('cd /workspace/app && git commit -m "Fix inverted color mapping in numberToColor: odd→Green, even→Red (verified against draw server API). Updated deps, render deploy trigger."', { encoding: 'utf8' });
  console.log(commit);

  // Show new commit
  console.log('\n4. Latest commit:');
  const log = execSync('cd /workspace/app && git log --oneline -3', { encoding: 'utf8' });
  console.log(log);

  // Try to push
  console.log('\n5. Attempting push to origin...');
  try {
    const push = execSync('cd /workspace/app && git push origin HEAD', { 
      encoding: 'utf8', 
      timeout: 30000 
    });
    console.log(push);
    console.log('\n✅ Push successful - Render will auto-deploy from the kilo/firm-dune-ur8 branch');
  } catch (pushErr) {
    console.log('Push result:', pushErr.message || pushErr.stdout || 'unknown');
    console.log('\n⚠️  Push may require GitHub authentication.');
    console.log('To complete the Render deploy:');
    console.log('  1. Copy this commit to your local clone');
    console.log('  2. Push to your GitHub repo: git push origin kilo/firm-dune-ur8');
    console.log('  3. Render will auto-deploy the new commit');
  }
} catch (e) {
  console.error('Error:', e.message || e.stdout || e.stderr);
}
