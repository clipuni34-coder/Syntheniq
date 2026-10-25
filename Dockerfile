FROM node:18-alpine

# Install only the 12 essential packages for Chromium on Alpine 3.18
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
    libgcc \
    gtk+3

ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

WORKDIR /app
COPY package*.json ./
RUN PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true npm ci --omit=dev
COPY . .
EXPOSE 3000
CMD ["node", "app.js"]
