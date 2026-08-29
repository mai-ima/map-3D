/**
 * OSM の道路ネットワークと POI を取り込み、PostGIS 投入用の SQL と
 * デバッグ用 GeoJSON を生成する。
 *
 *   npm run import:osm -- tokyo
 *   npm run import:osm -- tokyo --bbox 139.75,35.67,139.78,35.69
 *
 * 生成物:
 *   data/osm/{city}-network.sql    … PostGIS 投入用
 *   data/osm/{city}-network.json   … 確認用 GeoJSON
 *   data/osm/{city}-manifest.json  … 再現性のための記録
 *
 * 大量データを扱う場合は Overpass ではなく Geofabrik の PBF + osm2pgsql を使うこと
 * （scripts/import-osm/import-pbf.sh を参照）。
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { BBox } from '@ijm/shared';
import { CITIES, bboxCenter } from '@ijm/shared';
import { buildRoadNetwork, fetchRoadNetwork, searchNearbyPois } from '@ijm/gis';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const outDir = path.join(repoRoot, 'data', 'osm');

function parseArgs(argv: string[]): { cityId: string; bbox?: BBox } {
  const cityId = argv.find((a) => !a.startsWith('--')) ?? 'tokyo';
  const bboxIndex = argv.indexOf('--bbox');
  if (bboxIndex >= 0 && argv[bboxIndex + 1]) {
    const parts = argv[bboxIndex + 1].split(',').map(Number);
    if (parts.length === 4 && parts.every(Number.isFinite)) {
      return { cityId, bbox: parts as BBox };
    }
  }
  return { cityId };
}

function sqlEscape(value: string | undefined | null): string {
  if (value === undefined || value === null) return 'NULL';
  return `'${value.replace(/'/g, "''")}'`;
}

function jsonEscape(value: unknown): string {
  return value === undefined ? 'NULL' : `'${JSON.stringify(value).replace(/'/g, "''")}'::jsonb`;
}

async function main(): Promise<void> {
  const { cityId, bbox: bboxOverride } = parseArgs(process.argv.slice(2));
  const city = CITIES.find((c) => c.id === cityId);
  if (!city && !bboxOverride) {
    console.error(`未知の都市 ID: ${cityId}（--bbox で範囲を直接指定することもできます）`);
    console.error(`利用可能: ${CITIES.map((c) => c.id).join(', ')}`);
    process.exit(1);
  }

  // 都市 bbox 全体は Overpass には広すぎるため、既定では中心部の小さな矩形を使う
  const bbox: BBox =
    bboxOverride ??
    (() => {
      const center = city ? city.center : bboxCenter(city!.bbox);
      const d = 0.02; // およそ 2km 四方
      return [center.lng - d, center.lat - d, center.lng + d, center.lat + d];
    })();

  console.log(`[import-osm] ${cityId} bbox=${bbox.join(',')} を取得します`);

  const raw = await fetchRoadNetwork(bbox);
  const network = buildRoadNetwork(raw.elements, bbox);
  console.log(
    `[import-osm] ノード ${network.nodes.length} 件 / エッジ ${network.edges.length} 件を構築しました`,
  );

  const center = bboxCenter(bbox);
  const pois = await searchNearbyPois({ center, radius: 1500, limit: 500 });
  console.log(`[import-osm] POI ${pois.length} 件を取得しました`);

  await mkdir(outDir, { recursive: true });

  // ---- SQL --------------------------------------------------------------
  const lines: string[] = [
    '-- OpenStreetMap 由来の道路ネットワーク（© OpenStreetMap contributors, ODbL 1.0）',
    `-- 生成: ${new Date().toISOString()}  bbox: ${bbox.join(',')}`,
    'BEGIN;',
  ];

  for (const node of network.nodes) {
    lines.push(
      `INSERT INTO road_nodes (id, kind, degree, has_signal, has_crossing, tags, geom) VALUES (` +
        `${sqlEscape(node.id)}, ${sqlEscape(node.kind)}, ${node.degree}, ${node.hasSignal}, ${node.hasCrossing}, ` +
        `${jsonEscape(node.tags)}, ST_SetSRID(ST_MakePoint(${node.lng}, ${node.lat}), 4326)) ` +
        `ON CONFLICT (id) DO UPDATE SET degree = EXCLUDED.degree, kind = EXCLUDED.kind;`,
    );
  }

  for (const edge of network.edges) {
    const wkt = edge.coordinates.map(([lng, lat]) => `${lng} ${lat}`).join(',');
    lines.push(
      `INSERT INTO road_edges (id, kind, name, highway, oneway, lanes, length_m, start_node_id, end_node_id, tags, geom) VALUES (` +
        `${sqlEscape(edge.id)}, ${sqlEscape(edge.kind)}, ${sqlEscape(edge.name)}, ${sqlEscape(edge.highway)}, ` +
        `${edge.oneway}, ${edge.lanes ?? 'NULL'}, ${edge.length.toFixed(2)}, ` +
        `${sqlEscape(edge.startNodeId)}, ${sqlEscape(edge.endNodeId)}, ${jsonEscape(edge.tags)}, ` +
        `ST_SetSRID(ST_GeomFromText('LINESTRING(${wkt})'), 4326)) ON CONFLICT (id) DO NOTHING;`,
    );
  }

  for (const poi of pois) {
    lines.push(
      `INSERT INTO pois (id, name, category, tags, geom) VALUES (` +
        `${sqlEscape(poi.id)}, ${sqlEscape(poi.name)}, ${sqlEscape(poi.category)}, ${jsonEscape(poi.tags)}, ` +
        `ST_SetSRID(ST_MakePoint(${poi.lng}, ${poi.lat}), 4326)) ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name;`,
    );
  }

  lines.push('COMMIT;');
  const sql = lines.join('\n');
  await writeFile(path.join(outDir, `${cityId}-network.sql`), sql, 'utf8');

  // ---- GeoJSON（確認用） -------------------------------------------------
  const geojson = {
    type: 'FeatureCollection',
    features: [
      ...network.edges.map((edge) => ({
        type: 'Feature',
        properties: { id: edge.id, kind: edge.kind, name: edge.name, highway: edge.highway },
        geometry: { type: 'LineString', coordinates: edge.coordinates },
      })),
      ...network.nodes
        .filter((n) => n.kind !== 'endpoint')
        .map((node) => ({
          type: 'Feature',
          properties: { id: node.id, kind: node.kind, degree: node.degree },
          geometry: { type: 'Point', coordinates: [node.lng, node.lat] },
        })),
    ],
  };
  await writeFile(
    path.join(outDir, `${cityId}-network.json`),
    JSON.stringify(geojson),
    'utf8',
  );

  // ---- マニフェスト（再現性の記録） -------------------------------------
  await writeFile(
    path.join(outDir, `${cityId}-manifest.json`),
    JSON.stringify(
      {
        city: cityId,
        bbox,
        generatedAt: new Date().toISOString(),
        source: 'Overpass API (OpenStreetMap)',
        license: 'ODbL 1.0 — © OpenStreetMap contributors',
        counts: {
          nodes: network.nodes.length,
          edges: network.edges.length,
          pois: pois.length,
        },
        sqlSha256: createHash('sha256').update(sql).digest('hex'),
      },
      null,
      2,
    ),
    'utf8',
  );

  console.log(`[import-osm] 出力: data/osm/${cityId}-network.sql / .json / -manifest.json`);
  console.log(
    `[import-osm] 投入例: psql "$DATABASE_URL" -f data/osm/${cityId}-network.sql`,
  );
}

main().catch((error) => {
  console.error('[import-osm] 失敗しました:', error);
  process.exit(1);
});
