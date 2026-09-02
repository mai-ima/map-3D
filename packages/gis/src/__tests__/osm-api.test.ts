/**
 * OSM API（XML）のパーサの検証。
 *
 * 信号・横断歩道・街路樹はすべて node なので、node を取り出せないと
 * 街の部品がまとめて消える。実際にそうなっていた。
 * 検証用の XML は api.openstreetmap.org の応答をそのまま写している
 * （浜松駅北口の信号を含む範囲）。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseOsmXml } from '../osm-api';

/** 実際の応答と同じ体裁。改行と字下げも本物に合わせている */
const XML = `<?xml version="1.0" encoding="UTF-8"?>
<osm version="0.6" generator="openstreetmap-cgimap 2.1.0">
 <bounds minlat="34.7040000" minlon="137.7330000" maxlat="34.7055000" maxlon="137.7345000"/>
 <node id="432824891" visible="true" version="8" lat="34.7054940" lon="137.7329740">
  <tag k="highway" v="traffic_signals"/>
  <tag k="name" v="JR浜松駅北口"/>
  <tag k="traffic_signals" v="signal"/>
 </node>
 <node id="432824894" visible="true" version="4" lat="34.7047289" lon="137.7336590"/>
 <node id="432824895" visible="true" version="4" lat="34.7046523" lon="137.7337726"/>
 <node id="900000001" visible="true" version="1" lat="34.7050000" lon="137.7340000">
  <tag k="natural" v="tree"/>
 </node>
 <way id="123456" visible="true" version="3">
  <nd ref="432824894"/>
  <nd ref="432824895"/>
  <tag k="highway" v="residential"/>
  <tag k="name" v="鍛冶町通り"/>
  <tag k="lanes" v="2"/>
 </way>
</osm>`;

test('タグを持つ node を取り出せる', () => {
  const elements = parseOsmXml(XML);
  const nodes = elements.filter((e) => e.type === 'node');

  // タグの無い node（way の形状点）は要素として返さない
  assert.equal(nodes.length, 2, `node が ${nodes.length} 件`);

  const signal = nodes.find((n) => n.tags?.highway === 'traffic_signals');
  assert.ok(signal, '信号が取り出せていない');
  assert.equal(signal.id, 432824891);
  assert.equal(signal.lat, 34.705494);
  assert.equal(signal.lon, 137.732974);
  assert.equal(signal.tags?.name, 'JR浜松駅北口');

  assert.ok(
    nodes.some((n) => n.tags?.natural === 'tree'),
    '街路樹が取り出せていない',
  );
});

test('way は形状点の座標を埋めて返す', () => {
  const elements = parseOsmXml(XML);
  const ways = elements.filter((e) => e.type === 'way');
  assert.equal(ways.length, 1);

  const road = ways[0];
  assert.equal(road.id, 123456);
  assert.equal(road.tags?.highway, 'residential');
  assert.equal(road.tags?.lanes, '2');
  // タグの無い node も座標の解決には使う
  assert.equal(road.geometry?.length, 2);
  assert.equal(road.geometry?.[0].lat, 34.7047289);
  assert.equal(road.geometry?.[1].lon, 137.7337726);
});

test('要素が無い応答でも落ちない', () => {
  assert.deepEqual(parseOsmXml('<?xml version="1.0"?><osm version="0.6"></osm>'), []);
});
