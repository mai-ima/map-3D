/**
 * 到着地点の案内（建物の出入口と駐車場）。
 *
 * カーナビで最後に困るのは「着いたけれど、どこから入るのか」。
 * 大きな駅や商業施設では、目的地の座標に着いても建物の裏側だったり、
 * 駐車場の入口が反対側だったりする。
 *
 * 出典は OSM の `entrance=*` と `amenity=parking`。
 * 実測（2026-09、OSM 本体 API、1km 四方）:
 *
 *   東京駅  入口 117 件（main 17 / yes 99 / shop 1）・駐車場 49 件
 *           名前つきの入口 30 件（「八重洲中央南口」「丸の内北口」「京橋口」など）
 *   浜松駅  入口 7 件（main 1 / yes 6）・駐車場 705 件
 *           名前つきの入口 0 件
 *
 * 地域によって整備の傾向が違う。東京は入口、浜松は駐車場が充実している。
 * ここで測るのは「あるものだけを、近い順に、正しい呼び名で出す」こと。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ARRIVAL_RADIUS_M,
  buildArrivalGuide,
  hasArrivalGuide,
  type ArrivalElement,
} from '../arrival';

const TOKYO = { lat: 35.6812, lng: 139.7671 };
const M_PER_DEG = 111_320;

/** 目的地から北へ n メートルの地点にある要素 */
function at(metres: number, tags: Record<string, string>, id = metres): ArrivalElement {
  return { type: 'node', id, lat: TOKYO.lat + metres / M_PER_DEG, lon: TOKYO.lng, tags };
}

test('入口と駐車場を分けて、近い順に出す', () => {
  const guide = buildArrivalGuide(
    [
      at(80, { entrance: 'yes', name: '八重洲中央南口' }, 1),
      at(30, { entrance: 'yes', name: '丸の内北口' }, 2),
      at(60, { amenity: 'parking', name: '丸の内パーキング' }, 3),
      at(20, { amenity: 'parking' }, 4),
    ],
    TOKYO,
  );
  assert.deepEqual(
    guide.entrances.map((e) => e.name),
    ['丸の内北口', '八重洲中央南口'],
  );
  assert.deepEqual(
    guide.parking.map((p) => p.name),
    ['駐車場', '丸の内パーキング'],
  );
  // 距離はメートルの整数で出す
  assert.equal(guide.entrances[0].distanceM, 30);
});

test('正面入口を先に出す', () => {
  // 大きな施設では、正面が遠くても「正面へ回る」ほうが結局は早い
  const guide = buildArrivalGuide(
    [
      at(20, { entrance: 'yes' }, 1),
      at(90, { entrance: 'main', name: '中央口' }, 2),
      at(40, { entrance: 'yes' }, 3),
    ],
    TOKYO,
  );
  assert.equal(guide.entrances[0].name, '中央口');
});

test('名前が無ければ種別から呼び名を決める', () => {
  // **位置から「北口」などと推測しない。** 建物の向きは分からないし、
  // 実際の呼び名と食い違う
  const guide = buildArrivalGuide(
    [at(10, { entrance: 'main' }, 1), at(20, { entrance: 'yes' }, 2)],
    TOKYO,
  );
  assert.deepEqual(
    guide.entrances.map((e) => e.name),
    ['正面入口', '入口'],
  );
});

test('駐車場の呼び名は OSM の値から決める', () => {
  // 屋根の有無は実データとして入っていることがある
  const guide = buildArrivalGuide(
    [
      at(10, { amenity: 'parking', parking: 'multi-storey' }, 1),
      at(20, { amenity: 'parking', parking: 'underground' }, 2),
      at(30, { amenity: 'parking', name: '駅前パーキング' }, 3),
    ],
    TOKYO,
  );
  assert.deepEqual(
    guide.parking.map((p) => p.name),
    ['立体駐車場', '地下駐車場', '駅前パーキング'],
  );
});

test('使えない入口は案内しない', () => {
  // 非常口と業務用へ誘導すると、入れないところへ行かせることになる
  const guide = buildArrivalGuide(
    [
      at(10, { entrance: 'emergency' }, 1),
      at(20, { entrance: 'service' }, 2),
      at(30, { entrance: 'yes' }, 3),
    ],
    TOKYO,
  );
  assert.equal(guide.entrances.length, 1);
});

test('私有の駐車場は案内しない', () => {
  const guide = buildArrivalGuide(
    [
      at(10, { amenity: 'parking', access: 'private' }, 1),
      at(20, { amenity: 'parking', access: 'no' }, 2),
      at(30, { amenity: 'parking' }, 3),
    ],
    TOKYO,
  );
  assert.equal(guide.parking.length, 1);
  assert.equal(guide.parking[0].distanceM, 30);
});

test('遠すぎるものは混ぜない', () => {
  // 大きな駅は端から端まで数百メートルあるが、広げすぎると
  // 別の建物の入口まで混ざる
  const guide = buildArrivalGuide(
    [at(ARRIVAL_RADIUS_M - 10, { entrance: 'yes' }, 1), at(ARRIVAL_RADIUS_M + 50, { entrance: 'yes' }, 2)],
    TOKYO,
  );
  assert.equal(guide.entrances.length, 1);
});

test('面で入っている駐車場は中心点で扱う', () => {
  // way の駐車場は敷地の形で入っているので、Overpass に中心をもらう
  const guide = buildArrivalGuide(
    [
      {
        type: 'way',
        id: 100,
        center: { lat: TOKYO.lat + 50 / M_PER_DEG, lon: TOKYO.lng },
        tags: { amenity: 'parking', name: '駅北駐車場' },
      },
    ],
    TOKYO,
  );
  assert.equal(guide.parking.length, 1);
  assert.equal(guide.parking[0].distanceM, 50);
});

test('壊れた要素があっても案内は成立する', () => {
  const guide = buildArrivalGuide(
    [
      { type: 'node', id: 1 },
      { type: 'node', id: 2, tags: { entrance: 'yes' } },
      { type: 'node', id: 3, lat: Number.NaN, lon: 139.76, tags: { entrance: 'yes' } },
      at(10, { entrance: 'yes' }, 4),
    ],
    TOKYO,
  );
  assert.equal(guide.entrances.length, 1);
});

test('出すものが無ければ何も出さない', () => {
  // 浜松では名前つきの入口が 0 件。無いものを作らない
  assert.equal(hasArrivalGuide(buildArrivalGuide([], TOKYO)), false);
  assert.equal(hasArrivalGuide(null), false);
  assert.equal(hasArrivalGuide(buildArrivalGuide([at(10, { entrance: 'yes' })], TOKYO)), true);
});

test('多すぎるときは近いものだけに絞る', () => {
  // 東京駅の 1km 四方には入口が 117 件ある。全部出しても選べない
  const many = Array.from({ length: 30 }, (_, i) => at(10 + i, { entrance: 'yes' }, i));
  const guide = buildArrivalGuide(many, TOKYO);
  assert.ok(guide.entrances.length <= 5, `入口が ${guide.entrances.length} 件`);
  // 近いものが残る
  assert.equal(guide.entrances[0].distanceM, 10);
});
