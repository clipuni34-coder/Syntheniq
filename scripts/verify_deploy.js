const { execSync } = require('child_process');

try {
  // Check the exact node:18-alpine version
  const img = execSync('docker pull node:18-alpine 2>&1 && docker run --rm node:18-alpine cat /etc/os-release', {
    timeout: 60000,
    encoding: 'utf8'
  });
  console.log('Alpine version:', img);
} catch(e) {
  console.log('Docker not available or Alpine check failed:', e.message);
}

// Instead, let's check the git state and what's pushed
console.log('\n=== Git State ===');
const log = execSync('cd /workspace/app && git log --oneline -5', { encoding: 'utf8' });
console.log(log);

// Check if there are any uncommitted changes
const status = execSync('cd /workspace/app && git status --short', { encoding: 'utf8' });
console.log('Status:', status || '(clean)');

// Check the current Dockerfile
const dockerfile = execSync('cd /workspace/app && cat Dockerfile', { encoding: 'utf8' });
console.log('\n=== Current Dockerfile ===');
console.log(dockerfile);
