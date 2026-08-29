import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchOsmMap } from '../osm-api';

// OSM API は bbox が 0.25 度四方を超えると 400 を返す。
// 投げる前に弾いて、無駄な往復とエラーログを避ける。
test('広すぎる範囲は要求前に弾く', async () => {
  await assert.rejects(
    () => fetchOsmMap([139.0, 35.0, 140.0, 36.0]),
    /範囲が広すぎます/,
  );
});
