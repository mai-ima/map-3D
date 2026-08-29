import type { NextConfig } from 'next';

/**
 * Next.js アプリはリポジトリ直下に置き、package.json も「next と react を持つだけの
 * ごく普通の単一 Next.js プロジェクト」の形にしている。
 *
 * 理由: Vercel は「Root Directory の package.json に next があるか」でフレームワークを判定する。
 * アプリをサブディレクトリに置くと Root Directory の設定が必須になり、しかも公式仕様上
 * 「Root Directory の外のファイルは参照できず `..` も使えない」ため、モノレポの共有パッケージを
 * 参照できなくなる。直下に置けば既定設定のままデプロイでき、この問題が起きない。
 *
 * 共有ロジック（packages/*）は npm の依存ではなく、tsconfig の paths と
 * 下記の resolveAlias で「同じプロジェクト内のソース」として解決している。
 * npm workspaces も file: 依存も使わないので、依存解決がデプロイ環境に左右されない。
 */
const PACKAGES = ['shared', 'gis', 'routing', 'navigation', 'map-engine', 'ai', 'ui'] as const;

const packageAliases = Object.fromEntries(
  PACKAGES.map((name) => [`@ijm/${name}`, `./packages/${name}/src/index.ts`]),
);

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Cesium は非常に大きいため、サーバ側バンドルには含めない（クライアント専用）
  serverExternalPackages: ['cesium'],
  turbopack: {
    resolveAlias: {
      ...packageAliases,
      // Cesium が Gaussian Splat 用に静的 import する @spz-loader/core は、
      // WASM をインライン化しておりバンドルすると不正な JS になる。
      // 本アプリでは未使用なのでスタブへ差し替える（詳細は lib/stubs/spz-loader.ts）。
      '@spz-loader/core': './lib/stubs/spz-loader.ts',
    },
  },
};

export default nextConfig;
