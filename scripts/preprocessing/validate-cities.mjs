#!/usr/bin/env node
/**
 * 都市レジストリの検証スクリプト。
 *
 * 新しい都市を packages/shared/src/cities.ts に追加したら、これを実行して
 *  - PLATEAU の 3D Tiles が実際に配信されているか
 *  - 地形配信が生きているか
 * を確認する。「登録したのに表示されない」を防ぐための入口。
 *
 * 使い方:
 *   node scripts/preprocessing/validate-cities.mjs [都市ID...]
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

const CITIES_FILE = path.join(repoRoot, 'packages', 'shared', 'src', 'cities.ts');
const TILESET_BASE = 'https://api.plateauview.mlit.go.jp/datacatalog/3dtiles';
const TERRAIN_URL = 'https://tile.plateauview.mlit.go.jp/terrain/layer.json';

/**
 * cities.ts をパースせずに、必要な情報だけを正規表現で取り出す。
 * （ビルド不要でどこからでも実行できるようにするため）
 */
async function readCities() {
  const source = await readFile(CITIES_FILE, 'utf8');
  const cities = [];
  const cityBlocks = source.split(/\n  \{\n/).slice(1);

  for (const block of cityBlocks) {
    const id = /id: '([^']+)'/.exec(block)?.[1];
    const name = /name: '([^']+)'/.exec(block)?.[1];
    const near = /near: \{ area: '([^']+)', lod: '([^']+)'(, notexture: (true|false))?/.exec(block);
    const far = /far: \{ area: '([^']+)', lod: '([^']+)'(, notexture: (true|false))?/.exec(block);
    if (!id || !near) continue;
    cities.push({
      id,
      name,
      near: { area: near[1], lod: near[2], notexture: near[4] === 'true' },
      far: far ? { area: far[1], lod: far[2], notexture: far[4] === 'true' } : null,
    });
  }
  return cities;
}

function tilesetUrl(spec) {
  const parts = [spec.area, 'bldg', spec.lod, ...(spec.notexture ? ['notexture'] : []), 'latest'];
  return `${TILESET_BASE}/${parts.join('-')}/tileset.json`;
}

async function check(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
    const json = await res.json();
    const childCount = json?.root?.children?.length ?? 0;
    // HTTP 200 でも中身が空のタイルセットが存在する（その area/lod の配信が無い場合）。
    // 「表示されない」原因になるので失敗として扱う。
    if (childCount === 0 && !json?.root?.content) {
      return { ok: false, detail: '空のタイルセット（この area/lod の配信が存在しない）' };
    }
    return { ok: true, detail: `children=${childCount}` };
  } catch (error) {
    return { ok: false, detail: error.message };
  }
}

const targets = process.argv.slice(2);
const cities = await readCities();
const selected = targets.length > 0 ? cities.filter((c) => targets.includes(c.id)) : cities;

console.log(`検証対象: ${selected.length} 都市\n`);

const terrain = await check(TERRAIN_URL);
console.log(`地形 (PLATEAU-Terrain): ${terrain.ok ? 'OK' : 'NG'} — ${terrain.detail}`);
console.log('');

let failures = 0;
for (const city of selected) {
  const near = await check(tilesetUrl(city.near));
  const far = city.far ? await check(tilesetUrl(city.far)) : null;

  const status = near.ok ? 'OK' : 'NG';
  if (!near.ok) failures++;
  console.log(`[${status}] ${city.id} (${city.name})`);
  console.log(`      近景 ${tilesetUrl(city.near)}`);
  console.log(`           → ${near.ok ? 'OK' : 'NG'} ${near.detail}`);
  if (far) {
    console.log(`      遠景 ${tilesetUrl(city.far)}`);
    console.log(`           → ${far.ok ? 'OK' : 'NG'} ${far.detail}`);
  }
}

console.log('');
if (failures > 0) {
  console.error(`${failures} 件の都市で 3D Tiles を取得できませんでした。`);
  console.error('PLATEAU 配信サービスの spec（area / lod / year）を確認してください。');
  process.exit(1);
}
console.log('すべての都市で 3D Tiles を取得できました。');
