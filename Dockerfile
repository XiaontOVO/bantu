FROM node:22-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    BANTU_SEED_DEMO=false \
    STATE_STORE=sqlite \
    STATE_FILE=/app/data/bantu-state.sqlite

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && mkdir -p /app/data
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public

VOLUME ["/app/data"]
EXPOSE 8787
CMD ["node", "dist/src/server/main.js"]
