/**
 * 建物タイルセットの重ね方の検証。
 *
 * 近景 (LOD2) と遠景 (LOD1) は同じ建物を含む。重ねて描くと、
 * 屋根形状のある LOD2 と箱の LOD1 が同じ場所で深度を奪い合い、
 * 建物が二重に見えたりちらついたりする。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getCity } from '@ijm/shared';
import { needsFarTileset, servedModel, tilesetUrl } from '../buildings';

test('近景が市域全体をカバーする都市では遠景を読まない', () => {
  // 浜松の実測（2026-08）: near lod2 と far lod1 が
  // まったく同じ範囲 [137.6808, 34.6804, 137.7611, 34.7831] の
  // 同じ四分木（子 4 件）を返す。重ねると全建物が二重になる
  const hamamatsu = getCity('hamamatsu');
  assert.ok(hamamatsu);
  assert.equal(needsFarTileset(hamamatsu), false, '浜松は遠景を重ねない');

  // 姫路も tileset.json を直接指定していて同じ形
  const himeji = getCity('himeji');
  assert.ok(himeji);
  assert.equal(needsFarTileset(himeji), false);
});

test('まとめ配信の都市では遠景を使う', () => {
  // 東京は都道府県のまとめ配信を BFF が範囲で絞る。
  // 近景は半径 3km、遠景は 7km と範囲が違うので、遠景には
  // 近景が持っていない外側の街並みが入っている
  const tokyo = getCity('tokyo');
  assert.ok(tokyo);
  assert.equal(needsFarTileset(tokyo), true);

  for (const id of ['yokohama', 'osaka', 'kyoto', 'nagoya', 'sapporo', 'fukuoka']) {
    const city = getCity(id);
    assert.ok(city, id);
    assert.equal(needsFarTileset(city), true, `${city.name} は遠景を使う`);
  }
});

/**
 * 建物モデルの見え方（実写テクスチャ / 用途で塗り分け / 箱型）。
 *
 * 「建物のテクスチャありか、浜松と同レベルの LOD にするかを東京でも
 * 選択できるようにして」という依頼への対応。
 * ここで測るのは BFF への伝わり方と、返ってきたものの読み取り方。
 */

test('選んだ見え方が BFF への要求に載る', () => {
  const tokyo = getCity('tokyo')!;
  const bbox: [number, number, number, number] = [139.75, 35.67, 139.78, 35.69];
  for (const mode of ['textured', 'untextured', 'block'] as const) {
    assert.equal(
      tilesetUrl(tokyo, 'near', bbox, mode),
      `/api/tileset/tokyo/near/${mode}/139.7500,35.6700,139.7800,35.6900/tileset.json`,
    );
  }
});

test('tileset.json の URL にクエリを付けない', () => {
  // Cesium は tileset.json の URL のクエリを、その中の子 tileset.json や
  // タイル本体（b3dm）にも引き継ぐ。bbox はカメラが動くたびに変わるので、
  // クエリで渡すと同じタイルが毎回ちがう URL になり、
  // ブラウザにも CDN にも一切キャッシュが効かなくなる
  const tokyo = getCity('tokyo')!;
  const url = tilesetUrl(tokyo, 'near', [139.75, 35.67, 139.78, 35.69], 'textured');
  assert.ok(!url.includes('?'), `クエリが付いている: ${url}`);
  assert.ok(url.endsWith('/tileset.json'), '拡張子から中身が分かる形にする');
});

test('わずかな移動では URL が変わらない', () => {
  // 小数 4 桁（およそ 11m）で丸める。ここを細かくすると、
  // カメラが少し動いただけで別の URL になってキャッシュが当たらない
  const tokyo = getCity('tokyo')!;
  const a = tilesetUrl(tokyo, 'near', [139.75, 35.67, 139.78, 35.69], 'textured');
  const b = tilesetUrl(tokyo, 'near', [139.750001, 35.670001, 139.78, 35.69], 'textured');
  assert.equal(a, b);
});

test('実際に配信されたものを見て塗り分けを決める', () => {
  // テクスチャ無し版の整備範囲はテクスチャ付きより狭い
  // （2026-09 の東京都で 45 市区町村 / 62 市区町村）。
  // 未整備の区ではテクスチャ付きが返るので、要求した値のまま塗ると
  // 実写テクスチャの上に用途色が乗り、事実と違う色になる
  const withExtras = (value: unknown) =>
    ({ extras: value === undefined ? undefined : { ijmBuildingModel: value } }) as never;

  assert.equal(servedModel(withExtras('textured'), 'untextured'), 'textured');
  assert.equal(servedModel(withExtras('untextured'), 'untextured'), 'untextured');
  assert.equal(servedModel(withExtras('block'), 'textured'), 'block');
  // extras が無い・壊れているときは要求した値で通す（表示は止めない）
  assert.equal(servedModel(withExtras(undefined), 'untextured'), 'untextured');
  assert.equal(servedModel(withExtras('lod9'), 'block'), 'block');
});
