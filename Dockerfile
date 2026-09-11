FROM node:24.14.0-bookworm-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates openssl ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app

FROM base AS build
COPY package*.json ./
COPY prisma ./prisma
RUN npm ci && npm run db:generate
COPY . .
RUN npm run build && npm prune --omit=dev

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build --chown=node:node /app/package*.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/prisma ./prisma
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/.server-dist ./.server-dist
RUN mkdir -p /app/storage/clips && chown -R node:node /app/storage
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s --start-period=40s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:8787/api/health').then(r=>process.exit(r.ok?0:1)).catch(error=>{console.error(error.message);process.exit(1)})"]
CMD ["node", ".server-dist/server/index.js"]
