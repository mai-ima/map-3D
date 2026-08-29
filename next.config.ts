import type { NextConfig } from 'next';

/**
 * Next.js アプリはリポジトリ直下に置いている。
 *
 * 理由: Vercel は「Root Directory の package.json に next があるか」でフレームワークを判定するため、
 * アプリをサブディレクトリ（apps/web など）に置くと Root Directory の設定が必須になり、
 * 設定漏れで "No Next.js version detected" になる。直下に置けば既定設定のままデプロイできる。
 *
 * 共有ロジックは packages/* に置き、npm workspaces + transpilePackages で
 * ビルド無しに TypeScript ソースのまま取り込む。
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
