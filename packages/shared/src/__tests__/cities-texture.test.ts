import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CITIES, getCity } from '../cities';

// PLATEAU の LOD2 は自治体・年度でテクスチャの有無が違う。
// 実測（b3dm の glTF を直接解析）した結果を都市定義に反映している。
test('浜松はテクスチャ無しとして扱う', () => {
  const hamamatsu = getCity('hamamatsu');
  assert.ok(hamamatsu);
  // 2023 年度データ。b3dm に images:0 / textures:0、配布 ZIP にも画像が無い
  assert.equal(hamamatsu.texturedBuildings, false);
});

test('既定はテクスチャ付き（色に手を加えない）', () => {
  // 実写テクスチャがある都市に色を当てると、事実と違う見た目になる。
  // 明示的に false を指定した都市だけが塗り分けの対象。
  const tokyo = getCity('tokyo');
  assert.ok(tokyo);
  assert.notEqual(tokyo.texturedBuildings, false);

  const untextured = CITIES.filter((c) => c.texturedBuildings === false);
  assert.deepEqual(
    untextured.map((c) => c.id),
    ['hamamatsu'],
    '塗り分け対象は実測で確認した都市だけにする',
  );
});
