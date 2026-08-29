import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  LOD_LEVEL,
  lodFallbackChain,
  plateauDatasetId,
  plateauTilesetUrl,
  type PlateauTilesetSpec,
} from '../plateau';
import { CITIES } from '../cities';

test('データセット ID は PLATEAU の命名規則どおりに組み立てられる', () => {
  assert.equal(plateauDatasetId({ area: '13', lod: 'maxlod2' }), '13-bldg-maxlod2-latest');
  assert.equal(plateauDatasetId({ area: '13', lod: 'lod3' }), '13-bldg-lod3-latest');
  assert.equal(
    plateauDatasetId({ area: '13', featureType: 'brid', lod: 'maxlod2' }),
    '13-brid-maxlod2-latest',
  );
  assert.equal(
    plateauDatasetId({ area: '14100', lod: 'maxlod1', notexture: true, year: '2024' }),
    '14100-bldg-maxlod1-notexture-2024',
  );
});

test('タイルセット URL は配信ベースを前に付ける', () => {
  assert.equal(
    plateauTilesetUrl({ area: '13', lod: 'maxlod2' }),
    'https://api.plateauview.mlit.go.jp/datacatalog/3dtiles/13-bldg-maxlod2-latest/tileset.json',
  );
});

test('LOD のフォールバックは指定から下位へ順に落ちる', () => {
  // LOD4 は台東区のみ、LOD3 も 3 区のみなので、下位へ落ちられることが必須
  const chain = lodFallbackChain({ area: '13', lod: 'lod4' });
  assert.deepEqual(
    chain.map((c) => c.lod),
    ['lod4', 'lod3', 'lod2', 'lod1'],
  );

  // max 系は max 系のまま落ちる
  const maxChain = lodFallbackChain({ area: '13', lod: 'maxlod3' });
  assert.deepEqual(
    maxChain.map((c) => c.lod),
    ['maxlod3', 'maxlod2', 'maxlod1'],
  );

  // 最下位は自分だけ
  assert.deepEqual(
    lodFallbackChain({ area: '13', lod: 'lod1' }).map((c) => c.lod),
    ['lod1'],
  );

  // 下限を指定するとそこで止まる。
  // 詳細レイヤはベース (LOD2) に重ねるものなので、LOD2 まで落とすと二重読み込みになる
  assert.deepEqual(
    lodFallbackChain({ area: '13', lod: 'lod4' }, 3).map((c) => c.lod),
    ['lod4', 'lod3'],
  );
  // 下限が指定 LOD より高くても壊れない
  assert.deepEqual(
    lodFallbackChain({ area: '13', lod: 'lod2' }, 4).map((c) => c.lod),
    ['lod2'],
  );

  // area や featureType は保持される
  const brid = lodFallbackChain({ area: '13', featureType: 'brid', lod: 'maxlod2' });
  assert.ok(brid.every((c) => c.area === '13' && c.featureType === 'brid'));
});

test('LOD_LEVEL は lodN と maxlodN を同じ詳しさとして扱う', () => {
  assert.equal(LOD_LEVEL.lod2, LOD_LEVEL.maxlod2);
  assert.ok(LOD_LEVEL.lod4 > LOD_LEVEL.lod3);
  assert.ok(LOD_LEVEL.lod3 > LOD_LEVEL.lod2);
});

test('都市定義の追加レイヤは ID が重複しない', () => {
  for (const city of CITIES) {
    const ids = (city.overlays ?? []).map((o) => o.id);
    assert.equal(new Set(ids).size, ids.length, `${city.id}: 追加レイヤの ID が重複している`);
  }
});

test('近景は遠景より詳しい LOD を指す', () => {
  for (const city of CITIES) {
    if (!city.far) continue;
    assert.ok(
      LOD_LEVEL[city.near.lod] > LOD_LEVEL[city.far.lod],
      `${city.id}: 近景と遠景の LOD が逆転している`,
    );
  }
});

test('詳細レイヤを持つ都市は近景より詳しい LOD を指す', () => {
  for (const city of CITIES) {
    const detail: PlateauTilesetSpec | undefined = city.detail;
    if (!detail) continue;
    assert.ok(
      LOD_LEVEL[detail.lod] > LOD_LEVEL[city.near.lod],
      `${city.id}: 詳細レイヤが近景より詳しくない`,
    );
  }
});
