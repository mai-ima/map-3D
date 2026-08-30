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
import { needsFarTileset } from '../buildings';

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
