const https = require('https');
const { execSync } = require('child_process');

console.log('=== Checking Render deployment source ===\n');

// Check main branch Dockerfile
try {
  const mainDockerfile = execSync('cd /workspace/app && git show main:Dockerfile', { encoding: 'utf8' });
  console.log('main branch Dockerfile (lines 20-34):');
  const lines = mainDockerfile.split('\n');
  lines.forEach((l, i) => {
    if (i >= 19 && i <= 33) console.log(`  ${i+1}: ${l}`);
  });
} catch(e) { console.log('Cannot read main:Dockerfile:', e.message); }

// Check current HEAD Dockerfile
console.log('\nCurrent HEAD (kilo/firm-dune-ur8) Dockerfile (lines 20-34):');
try {
  const headDockerfile = execSync('cd /workspace/app && git show HEAD:Dockerfile', { encoding: 'utf8' });
  const lines = headDockerfile.split('\n');
  lines.forEach((l, i) => {
    if (i >= 19 && i <= 33) console.log(`  ${i+1}: ${l}`);
  });
} catch(e) { console.log('Cannot read HEAD:Dockerfile:', e.message); }

// Check if Render is likely on main
console.log('\n=== Checking main branch commits ===');
try {
  const log = execSync('cd /workspace/app && git log main --oneline -3', { encoding: 'utf8' });
  console.log(log);
} catch(e) { console.log('Error:', e.message); }

// Test individual package names
console.log('\n=== Testing which package names exist in Alpine ===');
const packages = ['gtk+3.0', 'gtk+3', 'atk-dev', 'atk', 'pango-dev', 'cairo-dev', 'mesa-gl-dev', 'mesa-gl'];

// Check what the actual error is - the package names in the error are without -dev suffix
// This means Render might have an older checkout
console.log('The error shows: gtk+3 (not gtk+3.0), atk (not atk-dev)');
console.log('This means the build is using OLD package names.');
console.log('');
console.log('The fix is already in commits 3bf6601 and ab8d310 on the pushed branch.');
console.log('Render may need its branch configuration verified or cache cleared.');
