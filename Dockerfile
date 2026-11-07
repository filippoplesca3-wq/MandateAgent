# Agent Mandate runs one Node process that serves both the API and the built
# React console. The server executes TypeScript through tsx, so dev
# dependencies are required at runtime; this mirrors `npm ci && npm run build`.
FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --include=dev && npm cache clean --force

COPY tsconfig.json vite.config.ts index.html ./
COPY public ./public
COPY src ./src
COPY replays ./replays
RUN npm run build

# SQLite mode writes here; mount a volume for persistence.
RUN mkdir -p /app/data && chown -R node:node /app/data

ENV NODE_ENV=production
ENV PORT=3001
EXPOSE 3001

USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "start"]
