# スタンドアロン API（セルフホスト構成用）
# 依存はリポジトリ直下の package.json に集約されている（packages/* は tsconfig paths で解決）。
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci

COPY packages ./packages
COPY apps/api ./apps/api
COPY tsconfig.base.json ./tsconfig.base.json
COPY tsconfig.json ./tsconfig.json

EXPOSE 8787
CMD ["npm", "run", "api:start"]
