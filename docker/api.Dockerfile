# スタンドアロン API（セルフホスト構成用）
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY packages/shared/package.json packages/shared/
COPY packages/gis/package.json packages/gis/
COPY packages/routing/package.json packages/routing/
COPY packages/navigation/package.json packages/navigation/
COPY packages/ai/package.json packages/ai/
COPY packages/ui/package.json packages/ui/
COPY packages/map-engine/package.json packages/map-engine/
RUN npm ci --omit=optional

COPY packages ./packages
COPY apps/api ./apps/api

EXPOSE 8787
CMD ["npm", "run", "start", "--workspace", "@ijm/api"]
