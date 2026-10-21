FROM node:18-alpine

# Install Chromium and required shared libraries for headless puppeteer
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    freetype-dev \
    harfbuzz \
    ca-certificates \
    ttf-liberation \
    fontconfig \
    libstdc++ \
    dbus \
    libdrm \
    libxkbcommon \
    libxkbcommon-x11 \
    libxcomposite \
    libxdamage \
    libxfixes \
    libxrandr \
    mesa-gbm \
    pango \
    cairo \
    alsa-lib

# Tell puppeteer to use the system Chromium
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install app dependencies
RUN PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true npm ci --omit=dev

# Copy app source
COPY . .

# Expose port
EXPOSE 3000

# Start the app
CMD ["node", "app.js"]
