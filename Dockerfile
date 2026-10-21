FROM node:18-alpine

# Install Chromium and required shared libraries for headless puppeteer
# Chromium comes from Alpine's package repo; puppeteer will use PUPPETEER_EXECUTABLE_PATH
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont \
    fontconfig \
    libstdc++

# Tell puppeteer to use the system Chromium (skip its own download)
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install app dependencies (puppeteer won't re-download Chromium due to env var)
RUN npm ci --omit=dev

# Copy app source
COPY . .

# Expose port
EXPOSE 3000

# Start the app
CMD ["node", "app.js"]
