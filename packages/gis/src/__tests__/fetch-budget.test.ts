/**
 * 取得にかける時間の管理と、切り替え先への引き継ぎ。
 *
 * ここが崩れると、利用者には「エラー」としてしか見えない。
 *
 * 実測（2026-09、浜松の高架）で起きていたこと:
 *   1. Overpass の 3 か所が順に時間切れ（20 秒 × 3）
 *   2. そのあと OSM 本体に切り替えてさらに待つ
 *   3. 合計 80 秒。API の maxDuration は 45 秒なので、
 *      応答が返る前に打ち切られていた
 *
 * さらに、合計の締め切りだけを足すと今度は
 *   4. Overpass が締め切りを使い切り、OSM 本体を一度も呼ばずに空を返す
 * という別の失敗になった。主の取得先には締め切りより手前で諦めさせる。
 *
 * OSM 本体の API には「1 回で 50,000 ノードまで」という上限があり、
 * 市街地の 3km 四方はこれに当たる。断られたら 4 分割して取り直す。
 */

import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { FALLBACK_RESERVE_MS, primaryDeadline } from '../config';
import { fetchOsmMap } from '../osm-api';
import { OverpassUnavailableError, deadlineIn, runOverpassQuery } from '../overpass';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('合計時間の締め切り', () => {
  test('締め切りを過ぎたら、残りの取得先は試さない', async () => {
    // 3 か所すべてを毎回試すと、1 か所あたりの上限 × 3 だけ待つことになる
    let calls = 0;
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      calls += 1;
      // 中断されるまで返さない（時間切れを模す）
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    }) as typeof fetch;

    const started = Date.now();
    await assert.rejects(
      () => runOverpassQuery('[out:json];node(1);out;', { deadline: Date.now() + 2500 }),
      OverpassUnavailableError,
    );
    const elapsed = Date.now() - started;

    assert.ok(elapsed < 4000, `締め切りを超えて待っている: ${elapsed}ms`);
    // 残り時間が足りない分は投げずに打ち切る
    assert.ok(calls <= 2, `打ち切れていない: ${calls} 回`);
  });

  test('主の取得先には、切り替えぶんを残した締め切りを渡す', () => {
    const deadline = Date.now() + 30000;
    const primary = primaryDeadline(deadline);
    const reserved = deadline - primary;
    assert.ok(
      Math.abs(reserved - FALLBACK_RESERVE_MS) < 50,
      `切り替えぶんが残っていない: ${reserved}ms`,
    );
  });

  test('締め切りが目前でも、主の取得先に最低限の時間は与える', () => {
    // 全部を予備に回すと、Overpass を一度も呼ばないことになる
    const primary = primaryDeadline(Date.now() + 1000);
    assert.ok(primary - Date.now() >= 2900, '主の取得先の時間が無い');
  });

  test('締め切りは「いまから何ミリ秒後か」で作れる', () => {
    const before = Date.now();
    const deadline = deadlineIn(5000);
    assert.ok(deadline - before >= 5000 && deadline - before < 5200);
  });
});

describe('OSM 本体 API のノード数上限', () => {
  /** 1 つの way だけを含む OSM XML */
  const xmlWith = (id: number) => `<?xml version="1.0"?>
<osm version="0.6">
  <node id="${id}1" lat="34.70" lon="137.73"/>
  <node id="${id}2" lat="34.71" lon="137.74"/>
  <way id="${id}">
    <nd ref="${id}1"/><nd ref="${id}2"/>
    <tag k="highway" v="residential"/>
  </way>
</osm>`;

  test('ノード数で断られたら 4 分割して取り直す', async () => {
    // 実測では 3km 四方で
    // 「You requested too many nodes (limit is 50000)」が返っていた。
    // 分割しないと、切り替え先があるのに何も出ないまま終わる
    const asked: string[] = [];
    globalThis.fetch = (async (input: unknown) => {
      const url = String(input);
      asked.push(url);
      if (asked.length === 1) {
        return new Response('You requested too many nodes (limit is 50000).', { status: 400 });
      }
      return new Response(xmlWith(asked.length), { status: 200 });
    }) as typeof fetch;

    const elements = await fetchOsmMap([137.71, 34.69, 137.75, 34.72]);
    assert.equal(asked.length, 5, '1 回目 + 4 分割にならない');
    assert.equal(elements.filter((e) => e.type === 'way').length, 4);
  });

  test('分割した区画にまたがる要素は 1 つにまとめる', async () => {
    // 境界をまたぐ way は複数の区画に現れる。4 区画とも同じ way を返す
    let first = true;
    globalThis.fetch = (async () => {
      if (first) {
        first = false;
        return new Response('You requested too many nodes (limit is 50000).', { status: 400 });
      }
      return new Response(xmlWith(7), { status: 200 });
    }) as typeof fetch;

    const elements = await fetchOsmMap([137.71, 34.69, 137.75, 34.72]);
    assert.equal(elements.filter((e) => e.type === 'way').length, 1, '重複が落ちていない');
  });

  test('分割しても全部空なら、取れなかったこととして扱う', async () => {
    globalThis.fetch = (async () =>
      new Response('You requested too many nodes (limit is 50000).', {
        status: 400,
      })) as typeof fetch;

    await assert.rejects(() => fetchOsmMap([137.71, 34.69, 137.75, 34.72]));
  });

  test('残り時間が無ければ、投げずに諦める', async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response('', { status: 200 });
    }) as typeof fetch;

    await assert.rejects(() => fetchOsmMap([137.71, 34.69, 137.75, 34.72], Date.now()));
    assert.equal(called, false, '締め切りを過ぎているのに投げている');
  });
});
