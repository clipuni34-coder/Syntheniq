FROM node:18-alpine

# Install only the essential Chromium dependencies
# Based on Alpine 3.18 package availability for node:18-alpine
RUN apk add --no-cache \
    chromium \
    nss \
    nspr \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont \
    ttf-dejavu \
    fontconfig \
    libstdc++ \
    cups \
    libdrm \
    libxcb \
    libxkbcommon \
    libxkbcommon-x11 \
    xorg-server-xvfb \
    xvfb \
    gtk+3.0 \
    alsa-lib \
    atk \
    libxcomposite \
    libxdamage \
    libxfixes \
    libxrandr \
    libgbm \
    mesa-gl

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
