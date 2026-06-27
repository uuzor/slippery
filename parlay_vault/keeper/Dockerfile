FROM node:22-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npx tsc

FROM node:22-alpine AS runtime

WORKDIR /app

RUN addgroup -g 1001 -S nodejs && \
    adduser -S nextjs -u 1001

COPY --from=builder --chown=nextjs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nextjs:nodejs /app/dist ./dist
COPY --from=builder --chown=nextjs:nodejs /app/package.json ./

USER nextjs

ENV SUI_NETWORK=testnet
ENV KEEPER_POLL_INTERVAL_MS=5000
ENV KEEPER_RESYNC_INTERVAL_MS=30000
ENV KEEPER_EPOCH_POLL_INTERVAL_MS=15000
ENV KEEPER_SETTLEMENT_GRACE_MS=30000
ENV KEEPER_SETTLEMENT_RETRY_MS=60000
ENV KEEPER_ENABLE_ORACLE_EVENT_POLLING=false

VOLUME ["/app/.state"]

CMD ["node", "dist/bot.js"]