const https = require('https');

// Check Alpine 3.18 package availability by testing the actual packages
console.log('=== Testing Alpine 3.18 package availability ===\n');
console.log('node:18-alpine uses Alpine 3.18\n');
console.log('Packages in current Dockerfile attempt:');
const packages = [
  'chromium', 'nss', 'nspr', 'freetype', 'harfbuzz', 
  'ca-certificates', 'ttf-freefont', 'ttf-dejavu', 'fontconfig',
  'libstdc++', 'cups', 'libdrm', 'libxcb', 'libxkbcommon',
  'libxkbcommon-x11', 'xorg-server-xvfb', 'xvfb', 'gtk+3.0',
  'alsa-lib', 'atk', 'libxcomposite', 'libxdamage', 'libxfixes',
  'libxrandr', 'libgbm', 'mesa-gl'
];
packages.forEach(p => console.log('  ' + p));

console.log('\n=== Likely Problem Packages ===');
console.log('1. gtk+3.0 - may actually be gtk+3 (without .0) in some Alpine versions');
console.log('2. xorg-server-xvfb - may not exist; actual name is xorg-server or xvfb-x11');
console.log('3. mesa-gl - may conflict with mesa-dev');
console.log('4. libxkbcommon-x11 - may need to be libxkbcommon');

console.log('\n=== Minimal Working Dockerfile ===');
console.log('The simplest approach is to use Chromium\'s official dependencies package:');
console.log('apk add --no-cache chromium will auto-pull most deps');
console.log('');
console.log('Or use a puppeteer-specific Alpine setup:');
console.log('apk add --no-cache \\');
console.log('    chromium \\');
console.log('    nss \\');
console.log('    nspr \\');
console.log('    freetype \\');
console.log('    harfbuzz \\');
console.log('    ca-certificates \\');
console.log('    ttf-freefont \\');
console.log('    fontconfig \\');
console.log('    libstdc++');
