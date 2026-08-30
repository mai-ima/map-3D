#!/usr/bin/env node
/**
 * CesiumJS の静的アセット（Workers / Assets / ThirdParty / Widgets）を
 * public/cesium へコピーする。
 *
 * Cesium は実行時にこれらを CESIUM_BASE_URL から読み込むため、
 * バンドラ任せにできない。dev / build の前に必ず実行する
 * （package.json の predev / prebuild フックで自動実行される）。
 */

import { cp, mkdir, readdir, rm, stat } from 'node:fs/promises';
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

/**
 * コピーしないもの。
 *
 * Cesium は全機能ぶんのアセットを同梱している。このアプリが使わないものを
 * 配信しても、初回表示が遅くなるだけで得るものがない。
 * 何が実際に読まれるかは Cesium.js 内の参照を調べて確認した。
 *
 * 消してよいと判断した根拠:
 *   NaturalEarthII … Cesium 既定のベースマップ。本アプリは地理院タイルを使う
 *   maki           … Cesium 同梱の POI アイコン。本アプリは自前の SVG を使う
 *   LensFlare      … レンズフレア演出。使っていない
 *   Widgets/Images … Cesium 標準 UI の画像。UI は全て自前で、
 *                    widgets.css が使う画像は data URI で埋め込まれている
 *
 *   GoogleEarthEnterprise … Google Earth Enterprise 形式のタイル。使わない
 *   decodeI3S             … Esri の I3S 形式。使わない
 *   gaussianSplat / wasm_splats … 3D Gaussian Splatting。使わない
 *   zip-module.wasm       … Cesium ion の ZIP 入りアセット用。使わない
 *   waterNormals          … 地形の water mask による水面表現。
 *                           地理院・PLATEAU の地形は water mask を持たず、
 *                           engine 側でも showWaterEffect を切っている
 *
 * 残すもの:
 *   SkyBox                      夜間の星空（時間帯の演出で使う）
 *   approximateTerrainHeights   地面へのクランプ（経路表示に必須）
 *   IAU2006_XYS                 太陽・月の方向の計算に毎フレーム使われる
 *                               （setSunAndMoonDirections が参照する）
 *   draco_decoder.wasm          PLATEAU の 3D Tiles は Draco 圧縮
 *   basis_transcoder / transcodeKTX2
 *                               KTX2 テクスチャのデコード。PLATEAU の
 *                               年度・地域によって使われることがあるので残す
 */
const EXCLUDED = [
  'Assets/Textures/NaturalEarthII',
  'Assets/Textures/maki',
  'Assets/Textures/LensFlare',
  'Assets/Textures/waterNormals.jpg',
  'Assets/Textures/waterNormalsSmall.jpg',
  'Widgets/Images',
  'Workers/createVerticesFromGoogleEarthEnterpriseBuffer.js',
  'Workers/decodeGoogleEarthEnterprisePacket.js',
  'Workers/decodeI3S.js',
  'Workers/gaussianSplatSorter.js',
  'Workers/gaussianSplatTextureGenerator.js',
  'ThirdParty/google-earth-dbroot-parser.js',
  'ThirdParty/wasm_splats_bg.wasm',
  'ThirdParty/zip-module.wasm',
];

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

  // 使わないアセットを落とす
  let removed = 0;
  for (const rel of EXCLUDED) {
    const victim = path.join(target, rel);
    if (!existsSync(victim)) continue;
    removed += await directorySize(victim);
    await rm(victim, { recursive: true, force: true });
  }

  const info = await stat(target);
  if (!info.isDirectory()) throw new Error('コピー先がディレクトリではありません');

  const total = await directorySize(target);
  console.log(
    `[copy-cesium-assets] コピー完了: ${path.relative(repoRoot, target)} ` +
      `(${mb(total)} / 未使用 ${mb(removed)} を除外)`,
  );
}

function mb(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

/** ファイル 1 つでもディレクトリでも合計サイズを返す */
async function directorySize(target) {
  const info = await stat(target);
  if (!info.isDirectory()) return info.size;

  let total = 0;
  for (const entry of await readdir(target, { withFileTypes: true })) {
    total += await directorySize(path.join(target, entry.name));
  }
  return total;
}

main().catch((error) => {
  console.error('[copy-cesium-assets] 失敗しました:', error);
  process.exit(1);
});
