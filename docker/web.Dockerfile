# Next.js（3D 表示 + BFF）
# アプリはリポジトリ直下にあり、共有ロジックは packages/*（package.json の file: 依存）。
FROM node:22-bookworm-slim AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

FROM base AS deps
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY packages/shared/package.json packages/shared/
COPY packages/gis/package.json packages/gis/
COPY packages/routing/package.json packages/routing/
COPY packages/navigation/package.json packages/navigation/
COPY packages/map-engine/package.json packages/map-engine/
COPY packages/ai/package.json packages/ai/
COPY packages/ui/package.json packages/ui/
RUN npm ci

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# prebuild で Cesium の静的アセットが public/cesium にコピーされる
RUN npm run build

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/next.config.ts ./next.config.ts
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/app ./app
COPY --from=build /app/components ./components
COPY --from=build /app/lib ./lib
COPY --from=build /app/packages ./packages
EXPOSE 3000
CMD ["npm", "run", "start"]
