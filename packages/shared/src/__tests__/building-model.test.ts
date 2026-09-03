/**
 * 建物モデルの見え方の選択。
 *
 * 「建物のテクスチャありか、浜松と同レベルの LOD にするかを東京でも
 * 選択できるようにして」という依頼への対応をここで固定する。
 *
 * PLATEAU は同じ地域について 3 通りの配信を持っている。
 * 実測（2026-09, https://api.plateauview.mlit.go.jp/datacatalog/3dtiles/）:
 *
 *   13-bldg-maxlod2-latest             HTTP 200  62 市区町村  19,858 byte
 *   13-bldg-maxlod2-notexture-latest   HTTP 200  45 市区町村  15,037 byte
 *   13-bldg-maxlod1-latest             HTTP 200  62 市区町村  19,858 byte
 *
 * 中心 5 区（13101 千代田・13102 中央・13103 港・13104 新宿・13113 渋谷）は
 * 3 つとも揃っていることを確認済み。
 *
 * ここで測るのは「どのデータ指定になるか」だけ。
 * 描画側の都合は入れない（Swift へ移してもこの判断はそのまま使う）。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  applyBuildingModel,
  availableBuildingModes,
  isBuildingModelMode,
  needsFarLayer,
  needsUsageColouring,
  resolveBuildingMode,
} from '../building-model';
import { getCity } from '../cities';
import { plateauDatasetId, type PlateauTilesetSpec } from '../plateau';

const TOKYO = getCity('tokyo')!;
const HAMAMATSU = getCity('hamamatsu')!;

test('東京は 3 通りとも選べる', () => {
  assert.deepEqual(availableBuildingModes(TOKYO), ['textured', 'untextured', 'block']);
});

test('URL 直指定の都市では選べない', () => {
  // 浜松は市区町村コード単位のまとめ配信が無く、区ごとの tileset.json を
  // URL で直接指している。URL は特定 LOD・特定テクスチャの実体そのものなので、
  // 差し替えても別のデータにはならない
  assert.deepEqual(availableBuildingModes(HAMAMATSU), ['untextured']);
});

test('選択がデータセット名に反映される', () => {
  const near = TOKYO.near;
  assert.equal(plateauDatasetId(applyBuildingModel(near, 'textured')), '13-bldg-maxlod2-latest');
  assert.equal(
    plateauDatasetId(applyBuildingModel(near, 'untextured')),
    '13-bldg-maxlod2-notexture-latest',
  );
  assert.equal(plateauDatasetId(applyBuildingModel(near, 'block')), '13-bldg-maxlod1-latest');
});

test('箱型に notexture は付けない', () => {
  // `13-bldg-maxlod1-notexture-latest` という配信は存在しない。
  // LOD1 はそもそもテクスチャを持たないため
  const fromUntextured: PlateauTilesetSpec = { area: '13', lod: 'maxlod2', notexture: true };
  const block = applyBuildingModel(fromUntextured, 'block');
  assert.equal(block.notexture, undefined);
  assert.equal(plateauDatasetId(block), '13-bldg-maxlod1-latest');
});

test('テクスチャ付きに戻すと notexture が外れる', () => {
  // 外し忘れると、選び直しても永久にテクスチャが戻らない
  const untextured = applyBuildingModel(TOKYO.near, 'untextured');
  const back = applyBuildingModel(untextured, 'textured');
  assert.equal(plateauDatasetId(back), '13-bldg-maxlod2-latest');
});

test('URL 直指定のデータ指定は書き換えない', () => {
  const spec: PlateauTilesetSpec = { area: '22131', lod: 'maxlod2', url: 'https://example/x.json' };
  for (const mode of ['textured', 'untextured', 'block'] as const) {
    assert.deepEqual(applyBuildingModel(spec, mode), spec);
  }
});

test('選べない見え方は近いものへ落とす', () => {
  // 浜松では実写テクスチャが配信されていない。形が同じ untextured へ寄せる
  assert.equal(resolveBuildingMode(HAMAMATSU, 'textured'), 'untextured');
  assert.equal(resolveBuildingMode(HAMAMATSU, 'block'), 'untextured');
  // 東京はそのまま通る
  assert.equal(resolveBuildingMode(TOKYO, 'block'), 'block');
  assert.equal(resolveBuildingMode(TOKYO, 'untextured'), 'untextured');
});

test('壊れた値は既定へ落とす', () => {
  // 設定は URL クエリからも来る。何が入っていても街は出す
  for (const bad of [undefined, null, '', 'lod9', 42, {}]) {
    assert.equal(resolveBuildingMode(TOKYO, bad), 'textured');
    assert.equal(resolveBuildingMode(HAMAMATSU, bad), 'untextured');
  }
});

test('箱型を選んだまま都市を移っても箱型のまま', () => {
  // 選べないからと既定へ飛ばすと、軽くしていた人が都市を移った拍子に
  // 実写テクスチャへ跳ね上がって通信量が増える
  const yokohama = getCity('yokohama')!;
  assert.equal(resolveBuildingMode(yokohama, 'block'), 'block');
});

test('塗り分けるのはテクスチャが無いときだけ', () => {
  // 実写テクスチャの上に用途色を乗せると、事実と違う色になる
  assert.equal(needsUsageColouring('textured'), false);
  assert.equal(needsUsageColouring('untextured'), true);
  assert.equal(needsUsageColouring('block'), true);
});

test('箱型では遠景を重ねない', () => {
  // 近景そのものが LOD1 なので、遠景を重ねると同じ箱が二重に描かれ、
  // 深度が競合してちらつく
  assert.equal(needsFarLayer('block'), false);
  assert.equal(needsFarLayer('textured'), true);
  assert.equal(needsFarLayer('untextured'), true);
});

test('見え方の判定', () => {
  assert.equal(isBuildingModelMode('textured'), true);
  assert.equal(isBuildingModelMode('untextured'), true);
  assert.equal(isBuildingModelMode('block'), true);
  assert.equal(isBuildingModelMode('lod2'), false);
  assert.equal(isBuildingModelMode(undefined), false);
});
