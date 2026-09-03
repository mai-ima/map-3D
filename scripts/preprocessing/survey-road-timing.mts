/**
 * 道路の「形を組み立てる」処理にかかる時間を測る。
 *
 * ワーカーへ逃がすべきかどうかを、感覚ではなく実測で決めるために作った。
 * 逃がす価値があるのは、主スレッドを 1 フレーム（16.7ms）以上止める処理だけ。
 * それ未満なら、ワーカーへの受け渡し（構造化複製）のほうが高くつく。
 *
 * 使い方:
 *   npx tsx scripts/preprocessing/survey-road-timing.mts [都市名]
 */

import {
  buildIntersections,
  buildRoadScene,
  crossingShapes,
  railShapes,
  roadShapes,
  signalShapes,
  type RoadScene,
} from '../../packages/gis/src/road-geometry';
import { runOverpassQuery } from '../../packages/gis/src/overpass';
import { estimateVertexCount } from '../../packages/shared/src/scene';
import type { BBox, SceneShape } from '../../packages/shared/src/types';

const PLACES: Record<string, BBox> = {
  浜松: [137.7256, 34.6957, 137.7428, 34.7137],
  東京: [139.7585, 35.6717, 139.7757, 35.6897],
};

/** カメラの高度に応じた詳細度。engine 側の detailForHeight と同じ 2 段階 */
const FULL = { laneMarkings: true };
const PLAIN = { laneMarkings: false };

/**
 * 取得結果を手元に控える。
 *
 * 測るたびに Overpass を叩くと、公開インスタンスが混んでいるときに
 * 503 で止まって測定そのものができない。同じ入力で何度も測り直したいので、
 * 一度取れたものはファイルに置いて使い回す。
 * 消せば取り直す（`rm .cache/roads-*.json`）。
 */
const CACHE_DIR = new URL('../../.cache/', import.meta.url);

async function cachedElements(name: string, fetchOnce: () => Promise<unknown[]>) {
  const { mkdir, readFile, writeFile } = await import('node:fs/promises');
  const file = new URL(`roads-${encodeURIComponent(name)}.json`, CACHE_DIR);
  try {
    return JSON.parse(await readFile(file, 'utf8')) as never[];
  } catch {
    const elements = await fetchOnce();
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(file, JSON.stringify(elements));
    return elements as never[];
  }
}

async function fetchElements(bbox: BBox): Promise<unknown[]> {
  const [minLng, minLat, maxLng, maxLat] = bbox;
  const box = `${minLat},${minLng},${maxLat},${maxLng}`;
  const query = `[out:json][timeout:60];
(
  way["highway"](${box});
  way["railway"~"^(rail|light_rail|subway|tram|monorail)$"](${box});
  node["highway"="traffic_signals"](${box});
  node["highway"="crossing"](${box});
);
out geom;`;
  const res = await runOverpassQuery(query);
  return res.elements;
}

/** 中央値で測る。1 回だけだと JIT の暖まり具合で 10 倍ぶれる */
function median(run: () => unknown, times = 9): number {
  const ms: number[] = [];
  for (let i = 0; i < times; i += 1) {
    const t0 = performance.now();
    run();
    ms.push(performance.now() - t0);
  }
  ms.sort((a, b) => a - b);
  return ms[Math.floor(ms.length / 2)];
}

async function main() {
  const name = process.argv[2] ?? '東京';
  const bbox = PLACES[name];
  if (!bbox) {
    console.error(`測れる場所: ${Object.keys(PLACES).join(' / ')}`);
    process.exit(1);
  }

  const elements = await cachedElements(name, () => fetchElements(bbox));
  const scene: RoadScene = buildRoadScene(elements as never);
  console.log(`## ${name} 駅周辺 1km 四方`);
  console.log(`道 ${scene.roads.length} 本 / 線路 ${scene.rails.length} 本 / 点 ${scene.points.length} 個\n`);

  // 標高は通信を伴うのでここでは測らない（線路と信号の高さ）。
  // 測りたいのは主スレッドを止める計算のほう
  const ground = () => 0;

  const rows: [string, number, number][] = [];

  const intersectionsMs = median(() => buildIntersections(scene.roads, scene.points));
  const intersections = buildIntersections(scene.roads, scene.points);
  rows.push(['交差点の割り出し', intersectionsMs, intersections.size]);

  for (const [label, detail] of [
    ['形の組み立て（区画線あり）', FULL],
    ['形の組み立て（区画線なし）', PLAIN],
  ] as const) {
    let shapes: SceneShape[] = [];
    const ms = median(() => {
      shapes = [];
      for (const road of scene.roads) {
        shapes.push(
          ...(road.cls === 'crossing'
            ? crossingShapes(road, detail)
            : roadShapes(road, detail, intersections)),
        );
      }
      for (const rail of scene.rails) shapes.push(...railShapes(rail, ground));
      for (const point of scene.points) shapes.push(...signalShapes(point, ground));
    });
    const vertices = shapes.reduce((sum, s) => sum + estimateVertexCount(s), 0);
    rows.push([label, ms, shapes.length]);
    console.log(`${label}: 形 ${shapes.length} / 頂点 ${vertices.toLocaleString()}`);
  }

  console.log('\n| 処理 | 中央値 (ms) | 件数 | 1 フレーム(16.7ms)比 |');
  console.log('|---|---:|---:|---:|');
  for (const [label, ms, count] of rows) {
    console.log(`| ${label} | ${ms.toFixed(2)} | ${count} | ${(ms / 16.7).toFixed(2)} |`);
  }
}

void main();
