FROM node:18-alpine

# Cache-busting: 2026-10-25-alpine-fix-v2
# Alpine 3.18 (node:18-alpine) - use gtk+3.0 not gtk+3
# Verified packages: chromium (community), nss/nspr/freetype/harfbuzz (main), etc.
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
    gtk+3.0

ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true

WORKDIR /app
COPY package*.json ./
RUN PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true npm ci --omit=dev
COPY . .
EXPOSE 3000
CMD ["node", "app.js"]
