const { execSync } = require('child_process');
const fs = require('fs');

console.log('=== Checking Dockerfile in each commit ===\n');

const commits = ['06a9777', 'c30ca1c', 'ab8d310'];

for (const commit of commits) {
  try {
    const df = execSync(`cd /workspace/app && git show ${commit}:Dockerfile 2>&1`, { encoding: 'utf8' });
    console.log(`Commit ${commit} Dockerfile:`);
    // Show just the RUN apk line to check package names
    const lines = df.split('\n');
    lines.forEach(l => {
      if (l.includes('apk') || l.includes('gtk') || l.includes('atk') || l.includes('pango') || l.includes('cairo') || l.includes('mesa') || l.includes('chromium')) {
        console.log('  ' + l.trim());
      }
    });
    console.log();
  } catch(e) {
    console.log(`Commit ${commit}: ${e.message}`);
  }
}

// Also check if the Dockerfile was committed in the latest
console.log('\n=== Git status ===');
const status = execSync('cd /workspace/app && git status --short', { encoding: 'utf8' });
console.log(status || '(clean)');

console.log('\n=== Files in last commit ===');
const files = execSync(`cd /workspace/app && git show --stat --oneline HEAD`, { encoding: 'utf8' });
console.log(files);
