FROM node:20-bookworm-slim

# ping / arp / nslookup / ss-türevi ağ araçları + sağlık kontrolü için curl
# tini: PID 1 olarak çalışıp biten artçı process'leri toplar (zombie birikmesini önler)
RUN apt-get update \
  && apt-get install -y --no-install-recommends iputils-ping net-tools dnsutils iproute2 curl ca-certificates tini \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev 2>/dev/null || npm install --omit=dev

COPY . .

EXPOSE 4000
ENV PORT=4000
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
HEALTHCHECK --interval=60s --timeout=10s --start-period=20s \
  CMD curl -sf "http://127.0.0.1:${PORT:-4000}/api/status" || exit 1
CMD ["node", "server.js"]
