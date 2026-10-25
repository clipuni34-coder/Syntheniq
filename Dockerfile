FROM node:18-alpine

# Install Chromium and required dependencies for headless puppeteer
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    freetype-dev \
    harfbuzz \
    ca-certificates \
    ttf-freefont \
    fontconfig \
    libstdc++ \
    nspr \
    cups-libs \
    dbus-libs \
    libxkbcommon \
    libxkbcommon-x11 \
    xorg-server-xvfb \
    xvfb

# Tell puppeteer to use the system Chromium
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install app dependencies
# puppeteer's postinstall may try to download Chromium even with SKIP_CHROMIUM_DOWNLOAD=true,
# so we set it before npm ci
RUN PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true npm ci --omit=dev

# Copy app source
COPY . .

# Expose port
EXPOSE 3000

# Start the app
CMD ["node", "app.js"]
