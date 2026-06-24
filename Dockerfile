FROM node:22-alpine AS builder

WORKDIR /app/keeper

COPY parlay_vault/keeper/package.json ./
COPY parlay_vault/keeper/tsconfig.json ./

RUN npm ci

COPY parlay_vault/keeper/*.ts ./
RUN npm run build

FROM node:22-alpine AS runtime

WORKDIR /app/keeper

RUN addgroup -g 1001 -S nodejs && \
    adduser -S nextjs -u 1001

COPY --from=builder --chown=nextjs:nodejs /app/keeper/node_modules ./node_modules
COPY --from=builder --chown=nextjs:nodejs /app/keeper/dist ./dist
COPY --from=builder --chown=nextjs:nodejs /app/keeper/package.json ./

USER nextjs

ENV SUI_NETWORK=testnet
ENV KEEPER_POLL_INTERVAL_MS=5000
ENV KEEPER_RESYNC_INTERVAL_MS=30000
ENV KEEPER_EPOCH_POLL_INTERVAL_MS=15000
ENV KEEPER_SETTLEMENT_GRACE_MS=30000
ENV KEEPER_SETTLEMENT_RETRY_MS=60000
ENV KEEPER_ENABLE_ORACLE_EVENT_POLLING=false

VOLUME ["/app/keeper/.state"]

CMD ["node", "dist/bot.js"]