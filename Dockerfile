# syntax=docker/dockerfile:1

# --- stage 1: build the web UI into web/dist ---
FROM node:20-slim AS web
WORKDIR /app/web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# --- stage 2: server + built UI ---
FROM node:20-slim AS server
ENV NODE_ENV=production
WORKDIR /app

# better-sqlite3 ships prebuilt binaries for node:20-slim, so no build toolchain needed
COPY package*.json ./
RUN npm ci --omit=dev

COPY server/ ./server/
COPY configs/ ./configs/
COPY samples/ ./samples/
COPY --from=web /app/web/dist ./web/dist

# candidate database lives here; mount a volume to persist it
RUN mkdir -p /app/data
ENV DB_PATH=/app/data/app.db
ENV PORT=4000
EXPOSE 4000

# basic liveness check
HEALTHCHECK --interval=30s --timeout=4s --start-period=5s \
  CMD node -e "fetch('http://localhost:'+ (process.env.PORT||4000) +'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
