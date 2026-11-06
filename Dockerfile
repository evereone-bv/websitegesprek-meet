# Meetserver Websitegesprek. Basis: het officiële Playwright-image (Chromium, WebKit en alle systeembibliotheken).
# De versie hier moet gelijk zijn aan "playwright" in package.json.
FROM mcr.microsoft.com/playwright:v1.63.0-noble

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    MEET_DATA_DIR=/data

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY src ./src
COPY config ./config

# Browsers draaien als gewone gebruiker, zodat de sandbox van Chromium aan blijft (advies Playwright voor onbekende sites).
RUN mkdir -p /data && chown pwuser:pwuser /data
USER pwuser
VOLUME ["/data"]
EXPOSE 8080
CMD ["node", "src/server.mjs"]
