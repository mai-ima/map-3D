import type { NextConfig } from 'next';

/**
 * ワークスペースの TS ソースをそのまま取り込む構成にしている。
 * 各 package をビルドせずに済むので、Vercel のビルドが `next build` 一発で完結する。
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: [
    '@ijm/shared',
    '@ijm/gis',
    '@ijm/routing',
    '@ijm/navigation',
    '@ijm/map-engine',
    '@ijm/ai',
    '@ijm/ui',
  ],
  // Cesium は非常に大きいため、サーバ側バンドルには含めない（クライアント専用）
  serverExternalPackages: ['cesium'],
  turbopack: {
    resolveAlias: {
      // Cesium が Gaussian Splat 用に静的 import する @spz-loader/core は、
      // WASM をインライン化しておりバンドルすると不正な JS になる。
      // 本アプリでは未使用なのでスタブへ差し替える（詳細は lib/stubs/spz-loader.ts）。
      '@spz-loader/core': './lib/stubs/spz-loader.ts',
    },
  },
};

export default nextConfig;
