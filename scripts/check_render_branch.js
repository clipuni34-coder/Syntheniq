const { execSync } = require('child_process');

console.log('=== Checking Render Configuration ===\n');

// Check what branch Render might be deploying from
// render.yaml doesn't specify a branch, so Render uses its dashboard setting

// Check git branches
const branches = execSync('cd /workspace/app && git branch -a --format="%(refname:short)"', { encoding: 'utf8' });
console.log('All branches:');
console.log(branches);

// Check if render.yaml is in the right location
const renderExists = execSync('cd /workspace/app && ls -la render.yaml', { encoding: 'utf8' });
console.log('\nrender.yaml:', renderExists);

// The issue: render.yaml doesn't have "branch:" specified
// Render needs either:
// 1. A branch specified in render.yaml
// 2. Or dashboard configuration
// Without it, Render defaults to "main" branch

// Check main branch Dockerfile exists
const mainDockerfile = execSync('cd /workspace/app && git cat-file -e main:Dockerfile 2>&1 && echo "EXISTS" || echo "NOT FOUND"', { encoding: 'utf8' });
console.log('\nmain branch Dockerfile:', mainDockerfile);

// Check if main has any Dockerfile
console.log('\n=== Checking main branch ===');
try {
  const mainTree = execSync('cd /workspace/app && git ls-tree main --name-only', { encoding: 'utf8' });
  console.log('main files:', mainTree.split('\n').join(', '));
  if (!mainTree.includes('Dockerfile')) {
    console.log('\n!!! main branch does NOT have a Dockerfile !!!');
    console.log('Render is likely trying to build from main without a Dockerfile.');
    console.log('This might cause it to fall back to a cached/default build');
  }
} catch(e) {
  console.log('Error checking main:', e.message);
}
