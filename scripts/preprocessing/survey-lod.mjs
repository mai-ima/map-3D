#!/usr/bin/env node
/**
 * PLATEAU の LOD・地物タイプの整備状況を調べる。
 *
 * LOD3（開口部）・LOD4（室内）は整備済みの市区町村が非常に限られており、
 * 未整備でも HTTP 200 で「中身が空の tileset」が返ってくる。
 * そのため URL の存在確認だけでは判断できず、root.children の件数まで見る必要がある。
 *
 * 都市を追加するとき、どの LOD・どの地物が使えるかをここで確認してから
 * packages/shared/src/cities.ts に反映する。
 *
 *   node scripts/preprocessing/survey-lod.mjs           # 登録済み都市の都道府県を調べる
 *   node scripts/preprocessing/survey-lod.mjs 13 14 27  # 都道府県コードを直接指定
 */

const BASE = 'https://api.plateauview.mlit.go.jp/datacatalog/3dtiles';
const TIMEOUT_MS = 30000;

const LODS = ['maxlod1', 'maxlod2', 'lod3', 'lod4'];
const FEATURES = [
  ['bldg', '建築物'],
  ['brid', '橋梁'],
  ['tran', '道路'],
  ['frn', '都市設備'],
  ['veg', '植生'],
];

async function fetchTileset(datasetId) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE}/${datasetId}/tileset.json`, {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return { ok: false, status: res.status, children: 0, names: [] };
    const json = await res.json();
    const children = json?.root?.children ?? [];
    const names = children
      .map((c) => c?.content?.uri ?? '')
      .map((uri) => {
        const parts = uri.split('/');
        return parts.length > 1 ? parts[parts.length - 2] : uri;
      })
      // 13103_minato-ku_pref_2025_... → minato-ku
      .map((name) => name.split('_').slice(0, 2).join('_'));
    return { ok: true, status: res.status, children: children.length, names };
  } catch (error) {
    return { ok: false, status: 0, children: 0, names: [], error: String(error) };
  } finally {
    clearTimeout(timer);
  }
}

async function surveyArea(area) {
  console.log(`\n=== 都道府県コード ${area} ===`);

  console.log('--- 建築物の LOD ---');
  for (const lod of LODS) {
    const r = await fetchTileset(`${area}-bldg-${lod}-latest`);
    const status = r.ok ? `${r.children} 市区町村` : `取得失敗 (HTTP ${r.status})`;
    console.log(`  ${lod.padEnd(9)} ${status}`);
    // LOD3 以上は整備範囲が狭いので、対象の市区町村名まで出す
    if (r.ok && r.children > 0 && (lod === 'lod3' || lod === 'lod4')) {
      for (const name of r.names) console.log(`      - ${name}`);
    }
  }

  console.log('--- 地物タイプ (maxlod2) ---');
  for (const [feature, label] of FEATURES) {
    const r = await fetchTileset(`${area}-${feature}-maxlod2-latest`);
    const status = r.ok ? `${r.children} 市区町村` : `取得失敗 (HTTP ${r.status})`;
    console.log(`  ${feature.padEnd(5)} ${label.padEnd(6)} ${status}`);
  }
}

async function main() {
  let areas = process.argv.slice(2);

  if (areas.length === 0) {
    // 登録済み都市の都道府県コードを対象にする
    const source = await import('node:fs/promises').then((fs) =>
      fs.readFile(new URL('../../packages/shared/src/cities.ts', import.meta.url), 'utf8'),
    );
    areas = [...new Set([...source.matchAll(/prefectureCode:\s*'(\d+)'/g)].map((m) => m[1]))];
  }

  if (areas.length === 0) {
    console.error('調査対象の都道府県コードが見つかりませんでした');
    process.exitCode = 1;
    return;
  }

  console.log('PLATEAU の LOD・地物タイプ整備状況');
  console.log(`対象: ${areas.join(', ')}`);
  console.log(
    '\n注意: 未整備でも HTTP 200 で中身が空の tileset が返るため、市区町村の件数で判断する。',
  );

  for (const area of areas) {
    await surveyArea(area);
  }
}

await main();
