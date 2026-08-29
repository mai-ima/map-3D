# Next.js（3D 表示 + BFF）
FROM node:22-bookworm-slim AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

FROM base AS deps
COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/
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
RUN npm run build --workspace @ijm/web

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/apps ./apps
COPY --from=build /app/packages ./packages
EXPOSE 3000
CMD ["npm", "run", "start", "--workspace", "@ijm/web"]
