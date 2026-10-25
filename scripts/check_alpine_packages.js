const https = require('https');

console.log('=== Checking Alpine 3.18 package availability ===\n');

// node:18-alpine is based on Alpine 3.18
// Let's check the Alpine package repository for the exact names

const pkgs = ['chromium', 'nss', 'nspr', 'freetype', 'harfbuzz', 'ca-certificates',
              'ttf-freefont', 'ttf-dejavu', 'fontconfig', 'libstdc++', 'libgcc',
              'gtk+3', 'gtk+3.0', 'atk', 'atk-dev', 'cups', 'cups-libs',
              'libdrm', 'libxcb', 'libxkbcommon', 'libxkbcommon-x11',
              'xorg-server-xvfb', 'xvfb', 'alsa-lib', 'libxcomposite',
              'libxdamage', 'libxfixes', 'libxrandr', 'libgbm', 'pango',
              'cairo', 'mesa-gl', 'mesa-dev'];

async function checkPkg(pkg) {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'dl-cdn.alpinelinux.org',
      path: `/alpine/v3.18/community/x86_64/`,
      method: 'GET',
      headers: { 'User-Agent': 'alpine-package-check' }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        const found = data.includes(`${pkg}-`) || data.includes(`${pkg}.apk`);
        resolve({ pkg, found, status: res.statusCode });
      });
    });
    req.on('error', () => resolve({ pkg, found: false, status: 'error' }));
    req.end();
  });
}

async function checkRepo() {
  // Check community repo
  const res = await new Promise((resolve) => {
    https.get('https://dl-cdn.alpinelinux.org/alpine/v3.18/community/x86_64/', (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    }).on('error', () => resolve({ status: 'error', body: '' }));
  });
  
  if (res.status === 200) {
    console.log('Alpine 3.18 community packages available.\n');
    
    const found = [];
    const notFound = [];
    
    for (const pkg of pkgs) {
      const exists = res.body.includes(`${pkg}-`) || res.body.includes(`${pkg}.apk`);
      if (exists) {
        found.push(pkg);
      } else {
        notFound.push(pkg);
      }
    }
    
    console.log('✅ Found in Alpine 3.18:');
    found.forEach(p => console.log('  ' + p));
    
    console.log('\n❌ NOT found in Alpine 3.18:');
    notFound.forEach(p => console.log('  ' + p));
  } else {
    console.log('Cannot access Alpine repo:', res.status);
  }
}

// Also check main repo
async function checkMainRepo() {
  const res = await new Promise((resolve) => {
    https.get('https://dl-cdn.alpinelinux.org/alpine/v3.18/main/x86_64/', (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    }).on('error', () => resolve({ status: 'error', body: '' }));
  });
  
  if (res.status === 200) {
    // Check specific packages in main repo
    const checkInMain = ['nss', 'nspr', 'freetype', 'harfbuzz', 'ca-certificates',
                         'ttf-freefont', 'fontconfig', 'libstdc++', 'libgcc', 'gtk+3',
                         'atk', 'cups', 'dbus', 'libdrm', 'libxcb', 'libxkbcommon',
                         'alsa-lib', 'libxcomposite', 'libxdamage', 'libxfixes',
                         'libxrandr', 'libgbm', 'chromium'];
    
    console.log('\n=== Packages in Alpine 3.18 main repo ===');
    checkInMain.forEach(pkg => {
      const exists = res.body.includes(`${pkg}-`) || res.body.includes(`${pkg}.apk`);
      if (exists) console.log('  ✅ ' + pkg);
      else console.log('  ❌ ' + pkg);
    });
  }
}

checkRepo().then(() => checkMainRepo()).catch(e => console.error(e));
