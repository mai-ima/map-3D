import path from 'node:path';
import type { NextConfig } from 'next';

/**
 * リポジトリのルート（このファイルの 2 つ上）。
 * 設定ファイルの位置から求めるので、どのディレクトリから実行しても正しく解決される。
 * `import.meta.dirname` が使えない形式で読み込まれた場合のみ cwd を使う。
 */
const REPO_ROOT = path.resolve(import.meta.dirname ?? process.cwd(), '..', '..');

/**
 * ワークスペースの TS ソースをそのまま取り込む構成にしている。
 * 各 package をビルドせずに済むので、Vercel のビルドが `next build` 一発で完結する。
 *
 * Vercel では Root Directory を `apps/web` に設定してデプロイする
 * （Next.js の検出は Root Directory の package.json を見るため）。
 * 詳細は docs/deploy-vercel.md を参照。
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,
  /**
   * サーバ関数のファイルトレースの基点。
   * モノレポではアプリ (apps/web) の外にある packages/* も辿る必要があるため、
   * リポジトリのルートを明示する。これが無いと Next.js がワークスペースの
   * ルートを推測し、Vercel 上で必要なファイルを取りこぼすことがある。
   */
  outputFileTracingRoot: REPO_ROOT,
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
