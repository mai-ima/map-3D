# スタンドアロン API（セルフホスト構成用）
# 依存はリポジトリ直下の package.json に集約されている（packages/* は file: 依存）。
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production

# file: 依存の解決にはリンク先のディレクトリが必要なので、先に package.json 群を置く
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/gis/package.json packages/gis/
COPY packages/routing/package.json packages/routing/
COPY packages/navigation/package.json packages/navigation/
COPY packages/map-engine/package.json packages/map-engine/
COPY packages/ai/package.json packages/ai/
COPY packages/ui/package.json packages/ui/
RUN npm ci

COPY packages ./packages
COPY apps/api ./apps/api
COPY tsconfig.base.json ./tsconfig.base.json

EXPOSE 8787
CMD ["npm", "run", "api:start"]
