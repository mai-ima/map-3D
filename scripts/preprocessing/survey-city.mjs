#!/usr/bin/env node
/**
 * PLATEAU の GraphQL API から、指定した市区町村の配信データを調べる。
 *
 * datacatalog の `{area}-{feature}-{lod}` 形式はまとめ配信であり、
 * すべての市区町村が入っているわけではない。
 * 例えば浜松市は 22130 / 22131 のいずれでもまとめ配信が空になるが、
 * GraphQL API を見ると区ごとに個別の tileset.json が配信されている。
 *
 * まとめ配信が空だった都市を追加するときは、このスクリプトで
 * 実際の配信 URL を取得し、cities.ts の spec に url として書く。
 *
 *   node scripts/preprocessing/survey-city.mjs 22130     # 浜松市
 *   node scripts/preprocessing/survey-city.mjs 13101     # 千代田区
 */

const ENDPOINT = 'https://api.plateauview.mlit.go.jp/datacatalog/graphql';
const TIMEOUT_MS = 60000;

const QUERY = `
  query Area($code: AreaCode!) {
    area(code: $code) {
      id
      name
      code
      datasets {
        name
        type { name }
        ... on PlateauDataset {
          items { name url format lod texture }
        }
      }
    }
  }
`;

async function query(code) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: QUERY, variables: { code } }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (json.errors) throw new Error(json.errors.map((e) => e.message).join(' / '));
    return json.data?.area ?? null;
  } finally {
    clearTimeout(timer);
  }
}

/** tileset.json を実際に読んで、範囲と規模を確かめる */
async function inspect(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return { ok: false, status: res.status };
    const json = await res.json();
    const root = json.root ?? {};
    const region = root.boundingVolume?.region;
    const deg = 180 / Math.PI;
    return {
      ok: true,
      children: root.children?.length ?? 0,
      refine: root.refine,
      bbox: region
        ? [region[0] * deg, region[1] * deg, region[2] * deg, region[3] * deg].map((n) =>
            Number(n.toFixed(5)),
          )
        : null,
    };
  } catch {
    return { ok: false, status: 0 };
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const code = process.argv[2];
  if (!code) {
    console.error('市区町村コード（5 桁）または都道府県コード（2 桁）を指定してください');
    console.error('  例: node scripts/preprocessing/survey-city.mjs 22130');
    process.exitCode = 1;
    return;
  }

  const area = await query(code);
  if (!area) {
    console.error(`コード ${code} の地域が見つかりませんでした`);
    process.exitCode = 1;
    return;
  }

  console.log(`${area.name} (${area.code})`);
  const datasets = area.datasets ?? [];
  console.log(`データセット: ${datasets.length} 件\n`);

  // 建築物モデルの 3D Tiles だけを詳しく見る（地図表示に使うのはこれ）
  const buildings = datasets.filter((d) => (d.type?.name ?? '') === '建築物モデル');
  console.log(`=== 建築物モデル (${buildings.length} 件) ===`);

  for (const ds of buildings) {
    console.log(`\n■ ${ds.name}`);
    for (const item of ds.items ?? []) {
      if (item.format !== 'CESIUM3DTILES') continue;
      const info = await inspect(item.url);
      const detail = info.ok
        ? `子 ${info.children} 件 / refine=${info.refine} / bbox=[${info.bbox?.join(', ')}]`
        : `取得失敗 (HTTP ${info.status})`;
      console.log(`  LOD${item.lod} ${item.texture === 'TEXTURE' ? 'テクスチャ有' : 'テクスチャ無'}`);
      console.log(`    ${detail}`);
      console.log(`    ${item.url}`);
    }
  }

  // 建築物以外はどんな種類があるかだけ出す
  const others = new Map();
  for (const ds of datasets) {
    const type = ds.type?.name ?? '不明';
    if (type === '建築物モデル') continue;
    const hasTiles = (ds.items ?? []).some((i) => i.format === 'CESIUM3DTILES');
    const key = `${type}${hasTiles ? '' : '（3D Tiles なし）'}`;
    others.set(key, (others.get(key) ?? 0) + 1);
  }
  if (others.size > 0) {
    console.log('\n=== その他のモデル ===');
    for (const [type, count] of [...others].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${type}: ${count} 件`);
    }
  }
}

await main();
