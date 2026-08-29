#!/usr/bin/env node
/**
 * CesiumJS の静的アセット（Workers / Assets / ThirdParty / Widgets）を
 * public/cesium へコピーする。
 *
 * Cesium は実行時にこれらを CESIUM_BASE_URL から読み込むため、
 * バンドラ任せにできない。dev / build の前に必ず実行する
 * （package.json の predev / prebuild フックで自動実行される）。
 */

import { cp, mkdir, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const target = path.join(repoRoot, 'public', 'cesium');

const CANDIDATES = [
  path.join(repoRoot, 'node_modules', 'cesium', 'Build', 'Cesium'),
  // npm の hoisting 次第で入れ子になる場合の保険
  path.join(repoRoot, 'node_modules', 'cesium', 'node_modules', 'cesium', 'Build', 'Cesium'),
];

const DIRECTORIES = ['Workers', 'Assets', 'ThirdParty', 'Widgets'];

async function main() {
  const source = CANDIDATES.find((c) => existsSync(c));
  if (!source) {
    console.error(
      '[copy-cesium-assets] cesium のビルド成果物が見つかりません。先に npm install を実行してください。',
    );
    process.exit(1);
  }

  await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });

  for (const dir of DIRECTORIES) {
    const from = path.join(source, dir);
    if (!existsSync(from)) {
      console.warn(`[copy-cesium-assets] ${dir} が見つかりません（スキップ）`);
      continue;
    }
    await cp(from, path.join(target, dir), { recursive: true });
  }

  const info = await stat(target);
  if (!info.isDirectory()) throw new Error('コピー先がディレクトリではありません');
  console.log(`[copy-cesium-assets] コピー完了: ${path.relative(repoRoot, target)}`);
}

main().catch((error) => {
  console.error('[copy-cesium-assets] 失敗しました:', error);
  process.exit(1);
});
