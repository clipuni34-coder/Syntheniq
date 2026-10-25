// Alpine package name reference:
// Alpine 3.17 and earlier: gtk+3.0
// Alpine 3.18+: gtk+3
// 
// But node:18-alpine is based on Alpine 3.18 where gtk+3 is correct
//
// Also: xorg-server-x11 is the correct package, not xorg-server-xvfb
// xorg-server contains xorg-server-xvfb as a subpackage

console.log('=== Correct Alpine 3.18 Package Names ===');
const al318 = {
  'gtk+3': 'Alpine 3.18 (node:18-alpine)',
  'xorg-server': 'Contains xvfb support',
  'xvfb': 'X Virtual Frame Buffer',
  'libxkbcommon-x11': 'Valid',
  'mesa-gl': 'Valid for direct rendering',
};

console.log('\n=== Alternative: Just use chromium with minimal deps ===');
console.log('# The chromium package on Alpine pulls most deps automatically');
console.log('# Additional packages are only needed for specific features');

console.log('\n=== Recommended Dockerfile ===');
console.log(`
FROM node:18-alpine

RUN apk add --no-cache \
    chromium \
    nss \
    nspr \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont \
    fontconfig \
    libstdc++ \
    libgcc \
    gtk+3 \
    atk \
    cups \
    dbus \
    libdrm \
    libxcb \
    libxkbcommon \
    libxkbcommon-x11 \
    xorg-server \
    xvfb \
    alsa-lib

ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
WORKDIR /app
COPY package*.json ./
RUN PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true npm ci --omit=dev
COPY . .
EXPOSE 3000
CMD ["node", "app.js"]
`);
