/**
 * 建物タイルセットの重ね方の検証。
 *
 * 近景 (LOD2) と遠景 (LOD1) は同じ建物を含む。重ねて描くと、
 * 屋根形状のある LOD2 と箱の LOD1 が同じ場所で深度を奪い合い、
 * 建物が二重に見えたりちらついたりする。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bboxAround, getCity } from '@ijm/shared';
import { clampBBox, needsFarTileset, nextNearBBox, servedModel, tilesetUrl } from '../buildings';

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

/**
 * 近景タイルセットの取り直しの判断。
 *
 * 「自分が近づくと（建物が）消えたりする」という指摘への対応。
 * 原因は取り直しの判断そのものにあり、見た目では追えなかったので
 * ここで数字として測る。
 */

test('まだ縁まで余裕があるうちは取り直さない', () => {
  const tokyo = getCity('tokyo')!;
  // 東京 bbox の内側で、活動範囲を半径 3km 相当に取る
  const centre = { lat: 35.68, lng: 139.76 };
  const active = bboxAround(centre, 3000);
  // 同じ場所、そして 500m 動いた程度では取り直す理由がない
  // （余裕は 3000 − 1000 = 2000m ある）
  assert.equal(nextNearBBox(active, centre, 3000, tokyo.bbox), null);
  assert.equal(nextNearBBox(active, { lat: 35.6845, lng: 139.76 }, 3000, tokyo.bbox), null);
});

test('読み込み済み範囲の縁に近づいたら取り直す', () => {
  const tokyo = getCity('tokyo')!;
  const centre = { lat: 35.68, lng: 139.76 };
  const active = bboxAround(centre, 3000);
  // 東へ 2.5km。カメラ ± 1km が読み込み済みの範囲からはみ出す
  const moved = { lat: 35.68, lng: 139.76 + 2500 / (111_320 * Math.cos((35.68 * Math.PI) / 180)) };
  const next = nextNearBBox(active, moved, 3000, tokyo.bbox);
  assert.ok(next, '縁に近づいたら取り直す');
  assert.ok(next[2] > active[2], '新しい範囲は移動した向きへ広がっている');
});

test('市域に収めた結果が同じ範囲になるなら取り直さない', () => {
  /**
   * これが以前は抜けていて、市域の縁で建物が消えては現れるを繰り返していた。
   *
   * 浜松市の bbox は東西 7.3km。高品質時の近景半径 4km（東西 8km）は
   * どこにカメラを置いても市域からはみ出すので、要求する範囲は常に
   * 市域そのものへ収められる。一方「カメラ ± 1km が読み込み済み範囲に
   * 収まっているか」は、縁から 1km 以内では永久に満たされない。
   *
   * つまり 0.5 秒ごとに「同じ範囲のタイルセットを作り直す」が走っていた。
   * 作り直すたびに古いタイルは解放されるので、そのあいだ建物が消える。
   */
  const hamamatsu = getCity('hamamatsu')!;
  // 市域の西の縁から 500m のところにカメラを置き、そこで読み込んだ状態にする
  const nearEdge = {
    lat: hamamatsu.center.lat,
    lng: hamamatsu.bbox[0] + 500 / (111_320 * Math.cos((hamamatsu.center.lat * Math.PI) / 180)),
  };
  const active = clampBBox(bboxAround(nearEdge, 4000), hamamatsu.bbox);

  // 前提 1: 読み込んだ範囲は西側が市域に収められている
  assert.equal(active[0], hamamatsu.bbox[0], '前提: 西側は市域で切られている');
  // 前提 2: カメラは動いていないのに「カメラ ± 1km」は範囲からはみ出す。
  // つまり「まだ余裕がある」という判定は、この場所では永久に成立しない
  const inner = bboxAround(nearEdge, 1000);
  assert.ok(inner[0] < active[0], '前提: 縁に寄っているのではみ出す');

  // それでも、取り直したところで同じ範囲にしかならない。
  // ここで取り直すと 0.5 秒ごとにタイルセットを作り直し続けることになる
  assert.equal(nextNearBBox(active, nearEdge, 4000, hamamatsu.bbox), null);
});

test('都市の外へ出たら取り直さない', () => {
  // 都市の切り替えは loadCity の担当。ここで読み直すと、
  // 空のタイルセットへ入れ替わって街が消える
  const hamamatsu = getCity('hamamatsu')!;
  const active = clampBBox(bboxAround(hamamatsu.center, 3000), hamamatsu.bbox);
  const faraway = { lat: 35.68, lng: 139.76 }; // 東京
  assert.equal(nextNearBBox(active, faraway, 3000, hamamatsu.bbox), null);
});
