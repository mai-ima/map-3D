/**
 * OSM の生データを「構造化された道路ネットワーク」に変換する。
 *
 * 道路を単なる線として持つのではなく、
 *   ノード: intersection / crossing / traffic_signal / stop / entrance
 *   エッジ: road / sidewalk / crosswalk / cycleway / footway / stairs
 * に分類して保持する。ナビゲーションの視覚表現（交差点ハイライト、横断歩道の強調）に使う。
 */

import type { BBox, LatLng } from '@ijm/shared';
import { bearingDegrees, distanceMeters } from '@ijm/shared';
import type { OverpassElement } from './overpass';

export type RoadNodeKind =
  | 'intersection'
  | 'crossing'
  | 'traffic_signal'
  | 'stop'
  | 'entrance'
  | 'endpoint';

export type RoadEdgeKind =
  | 'road'
  | 'sidewalk'
  | 'crosswalk'
  | 'cycleway'
  | 'footway'
  | 'stairs'
  | 'service';

export interface RoadNode {
  id: string;
  kind: RoadNodeKind;
  lat: number;
  lng: number;
  /** 接続しているエッジ数（交差点の複雑さの指標） */
  degree: number;
  /** 信号の有無 */
  hasSignal: boolean;
  /** 横断歩道の有無 */
  hasCrossing: boolean;
  tags?: Record<string, string>;
}

export interface RoadEdge {
  id: string;
  kind: RoadEdgeKind;
  name?: string;
  /** OSM の highway タグ値 */
  highway: string;
  oneway: boolean;
  lanes?: number;
  /** [lng, lat][] */
  coordinates: [number, number][];
  length: number;
  startNodeId: string;
  endNodeId: string;
  tags?: Record<string, string>;
}

export interface RoadNetwork {
  bbox: BBox;
  nodes: RoadNode[];
  edges: RoadEdge[];
}

const SIDEWALK_HIGHWAYS = new Set(['footway', 'path', 'pedestrian', 'steps', 'corridor']);
const SERVICE_HIGHWAYS = new Set(['service', 'track', 'driveway']);

function classifyEdge(tags: Record<string, string>): RoadEdgeKind {
  const highway = tags.highway ?? '';
  if (highway === 'steps') return 'stairs';
  if (highway === 'cycleway' || tags.bicycle === 'designated') return 'cycleway';
  if (highway === 'footway' && tags.footway === 'crossing') return 'crosswalk';
  if (highway === 'footway' && tags.footway === 'sidewalk') return 'sidewalk';
  if (SIDEWALK_HIGHWAYS.has(highway)) return 'footway';
  if (SERVICE_HIGHWAYS.has(highway)) return 'service';
  return 'road';
}

function classifyNode(tags: Record<string, string>, degree: number): RoadNodeKind {
  if (tags.highway === 'traffic_signals') return 'traffic_signal';
  if (tags.highway === 'crossing' || tags.footway === 'crossing') return 'crossing';
  if (tags.highway === 'stop') return 'stop';
  if (tags.entrance) return 'entrance';
  if (degree >= 3) return 'intersection';
  return 'endpoint';
}

function nodeKey(lat: number, lng: number): string {
  // 約 1cm 精度で丸めて同一ノードを束ねる
  return `${lat.toFixed(7)},${lng.toFixed(7)}`;
}

/**
 * Overpass の `out geom` 応答から道路ネットワークを構築する。
 * way の端点・共有点を交差点候補として抽出し、タグ付きノード情報を統合する。
 */
export function buildRoadNetwork(elements: OverpassElement[], bbox: BBox): RoadNetwork {
  const nodeMap = new Map<string, RoadNode>();
  const edges: RoadEdge[] = [];
  // 座標ごとの出現回数（共有＝交差点）
  const visitCount = new Map<string, number>();

  const taggedNodes = elements.filter(
    (e) => e.type === 'node' && e.tags && typeof e.lat === 'number' && typeof e.lon === 'number',
  );

  const ways = elements.filter((e) => e.type === 'way' && e.geometry && e.tags?.highway);

  // 1 パス目: 座標の出現回数を数える
  for (const way of ways) {
    for (const g of way.geometry!) {
      const key = nodeKey(g.lat, g.lon);
      visitCount.set(key, (visitCount.get(key) ?? 0) + 1);
    }
  }

  const ensureNode = (lat: number, lng: number): RoadNode => {
    const key = nodeKey(lat, lng);
    let node = nodeMap.get(key);
    if (!node) {
      node = {
        id: key,
        kind: 'endpoint',
        lat,
        lng,
        degree: visitCount.get(key) ?? 1,
        hasSignal: false,
        hasCrossing: false,
      };
      nodeMap.set(key, node);
    }
    return node;
  };

  // 2 パス目: エッジを作る（共有点で分割する）
  for (const way of ways) {
    const tags = way.tags!;
    const geom = way.geometry!;
    const kind = classifyEdge(tags);
    let segment: { lat: number; lon: number }[] = [];
    let segIndex = 0;

    const flush = (): void => {
      if (segment.length < 2) return;
      const coordinates = segment.map((p) => [p.lon, p.lat] as [number, number]);
      let length = 0;
      for (let i = 1; i < coordinates.length; i++) {
        length += distanceMeters(
          { lng: coordinates[i - 1][0], lat: coordinates[i - 1][1] },
          { lng: coordinates[i][0], lat: coordinates[i][1] },
        );
      }
      const startNode = ensureNode(segment[0].lat, segment[0].lon);
      const endNode = ensureNode(segment[segment.length - 1].lat, segment[segment.length - 1].lon);
      edges.push({
        id: `${way.id}-${segIndex++}`,
        kind,
        name: tags.name ?? tags['name:ja'],
        highway: tags.highway ?? '',
        oneway: tags.oneway === 'yes' || tags.oneway === '1' || tags.junction === 'roundabout',
        lanes: tags.lanes ? Number(tags.lanes) : undefined,
        coordinates,
        length,
        startNodeId: startNode.id,
        endNodeId: endNode.id,
        tags,
      });
    };

    for (const g of geom) {
      segment.push(g);
      const shared = (visitCount.get(nodeKey(g.lat, g.lon)) ?? 0) > 1;
      if (shared && segment.length > 1) {
        flush();
        segment = [g];
      }
    }
    flush();
  }

  // 3 パス目: タグ付きノードの情報を統合
  for (const tn of taggedNodes) {
    const node = ensureNode(tn.lat!, tn.lon!);
    node.tags = { ...(node.tags ?? {}), ...tn.tags };
    if (tn.tags!.highway === 'traffic_signals') node.hasSignal = true;
    if (tn.tags!.highway === 'crossing' || tn.tags!.footway === 'crossing') node.hasCrossing = true;
  }

  for (const node of nodeMap.values()) {
    node.kind = classifyNode(node.tags ?? {}, node.degree);
  }

  return { bbox, nodes: [...nodeMap.values()], edges };
}

/** 指定地点に最も近い交差点を返す（カメラ演出の対象を決めるのに使う） */
export function nearestIntersection(
  network: RoadNetwork,
  point: LatLng,
  maxDistance = 60,
): RoadNode | null {
  let best: RoadNode | null = null;
  let bestDist = maxDistance;
  for (const node of network.nodes) {
    if (node.kind !== 'intersection' && node.kind !== 'traffic_signal') continue;
    const d = distanceMeters(point, { lat: node.lat, lng: node.lng });
    if (d < bestDist) {
      bestDist = d;
      best = node;
    }
  }
  return best;
}

/**
 * ある地点における交差点の複雑さを推定する。
 * カメラが INTERSECTION 状態に入るかどうかの判断に使う。
 */
export function intersectionComplexity(network: RoadNetwork, point: LatLng, radius = 35): number {
  let branches = 0;
  let signals = 0;
  let crossings = 0;
  for (const node of network.nodes) {
    const d = distanceMeters(point, { lat: node.lat, lng: node.lng });
    if (d > radius) continue;
    if (node.kind === 'intersection') branches = Math.max(branches, node.degree);
    if (node.hasSignal) signals++;
    if (node.hasCrossing) crossings++;
  }
  return branches + signals * 1.5 + crossings * 0.5;
}

/** 交差点から伸びる道路の方位一覧（矢印表示用） */
export function branchBearings(network: RoadNetwork, node: RoadNode): number[] {
  const bearings: number[] = [];
  for (const edge of network.edges) {
    if (edge.startNodeId === node.id && edge.coordinates.length > 1) {
      const [lng1, lat1] = edge.coordinates[0];
      const [lng2, lat2] = edge.coordinates[1];
      bearings.push(bearingDegrees({ lat: lat1, lng: lng1 }, { lat: lat2, lng: lng2 }));
    } else if (edge.endNodeId === node.id && edge.coordinates.length > 1) {
      const n = edge.coordinates.length;
      const [lng1, lat1] = edge.coordinates[n - 1];
      const [lng2, lat2] = edge.coordinates[n - 2];
      bearings.push(bearingDegrees({ lat: lat1, lng: lng1 }, { lat: lat2, lng: lng2 }));
    }
  }
  return bearings;
}
