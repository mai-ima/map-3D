/**
 * 道路の描画負荷を実測する。
 *
 * 「重い」「軽くなった」を感覚で言わないために、実データで数える。
 * 数えるのは頂点数と描画のまとまりの数。どちらも見た目では分からない。
 *
 * 使い方:
 *   npx tsx scripts/preprocessing/survey-roads.mts [都市名]
 *
 * 出力は Markdown の表なので、そのまま記録に貼れる。
 */

import {
  buildRoadScene,
  clipToBBox,
  crossingShapes,
  railShapes,
  roadShapes,
  signalShapes,
  stitchRoads,
  type RoadScene,
} from '../../packages/gis/src/road-geometry';
import { runOverpassQuery } from '../../packages/gis/src/overpass';
import { estimateVertexCount } from '../../packages/shared/src/scene';
import type { BBox, SceneShape } from '../../packages/shared/src/types';

/** 測る場所。カメラ周辺 1km に相当する範囲 */
const PLACES: Record<string, BBox> = {
  // 浜松駅周辺（最重要地域）
  浜松: [137.7256, 34.6957, 137.7428, 34.7137],
  // 東京駅周辺（いちばん密なところ）
  東京: [139.7585, 35.6717, 139.7757, 35.6897],
};

async function fetchScene(bbox: BBox): Promise<RoadScene> {
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
  return buildRoadScene(res.elements);
}

/** 形の内訳を数える */
function summarise(shapes: SceneShape[]) {
  let vertices = 0;
  const byKind: Record<string, { count: number; vertices: number }> = {};
  for (const shape of shapes) {
    const v = estimateVertexCount(shape);
    vertices += v;
    const key = shape.kind === 'ribbon' ? `ribbon(order ${shape.order ?? 0})` : shape.kind;
    byKind[key] ??= { count: 0, vertices: 0 };
    byKind[key].count += 1;
    byKind[key].vertices += v;
  }
  return { total: shapes.length, vertices, byKind };
}

/** 経路の頂点の間隔を測る（間引きの余地があるかを見る） */
function spacingStats(scene: RoadScene) {
  const gaps: number[] = [];
  for (const road of scene.roads) {
    for (let i = 0; i < road.path.length - 1; i += 1) {
      const a = road.path[i];
      const b = road.path[i + 1];
      const cos = Math.cos((a.lat * Math.PI) / 180);
      gaps.push(
        Math.hypot((b.lng - a.lng) * cos, b.lat - a.lat) * 111_320,
      );
    }
  }
  gaps.sort((x, y) => x - y);
  const at = (p: number) => gaps[Math.floor(gaps.length * p)] ?? 0;
  return {
    count: gaps.length,
    median: at(0.5),
    p10: at(0.1),
    under2m: gaps.filter((g) => g < 2).length,
  };
}

async function main() {
  const only = process.argv[2];
  for (const [name, bbox] of Object.entries(PLACES)) {
    if (only && name !== only) continue;

    process.stderr.write(`${name} を取得中...\n`);
    const raw = await fetchScene(bbox);
    const clipped = clipToBBox(raw.roads, bbox);
    const scene: RoadScene = {
      roads: stitchRoads(clipped),
      rails: clipToBBox(raw.rails, bbox),
      points: raw.points,
    };

    const ground = () => 0;
    const build = (roads: typeof scene.roads): SceneShape[] => {
      const shapes: SceneShape[] = [];
      for (const road of roads) {
        shapes.push(...(road.cls === 'crossing' ? crossingShapes(road) : roadShapes(road)));
      }
      for (const rail of scene.rails) shapes.push(...railShapes(rail, ground));
      for (const point of scene.points) shapes.push(...signalShapes(point, ground));
      return shapes;
    };

    const before = summarise(build(clipped));
    const shapes = build(scene.roads);
    const s = summarise(shapes);
    const gaps = spacingStats(scene);

    console.log(`\n## ${name}  ${bbox.join(', ')}\n`);
    console.log(
      `道路 ${clipped.length} 本 → つないで ${scene.roads.length} 本 / ` +
        `線路 ${scene.rails.length} 本 / ` +
        `信号 ${scene.points.filter((p) => p.kind === 'traffic_signal').length} 基`,
    );
    console.log(
      `形 ${before.total} → ${s.total} 個 ` +
        `(${(100 - (s.total / before.total) * 100).toFixed(0)}% 減)、` +
        `頂点の目安 ${before.vertices.toLocaleString()} → ${s.vertices.toLocaleString()}\n`,
    );

    console.log('| 種類 | 個数 | 頂点 |');
    console.log('|---|---:|---:|');
    for (const [kind, v] of Object.entries(s.byKind).sort(
      (a, b) => b[1].vertices - a[1].vertices,
    )) {
      console.log(`| ${kind} | ${v.count} | ${v.vertices.toLocaleString()} |`);
    }

    console.log(`\n経路の頂点間隔: 中央値 ${gaps.median.toFixed(1)}m / `);
    console.log(`下位 10% ${gaps.p10.toFixed(1)}m / 2m 未満が ${gaps.under2m} 箇所（全 ${gaps.count}）`);
  }
}

main().catch((e) => {
  process.stderr.write(`${e}\n`);
  process.exit(1);
});
