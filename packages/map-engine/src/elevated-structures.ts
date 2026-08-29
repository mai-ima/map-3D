/**
 * 高架・橋梁を立体として描く。
 *
 * PLATEAU の橋梁モデルが無い地域（浜松市など）では、街の骨格である
 * 高架がまったく見えず、道路が地面に張り付いたままになってしまう。
 * OpenStreetMap の bridge / layer から桁・橋脚・壁を組み立てて補う。
 *
 * 実データと補完の切り分け:
 *   - 位置・形状・幅（車線数）・上下関係（layer）… OSM の実データ
 *   - 桁の厚み・橋脚の間隔と形 … 種別ごとの標準的な寸法
 * 形状そのものを創作しているわけではなく、断面の寸法を標準値で補っている。
 *
 * 拡大に耐えるように、桁は角を落とした断面で押し出し、
 * 橋脚は上下で太さを変えた四角柱にしている。
 */

import * as Cesium from 'cesium';
import type { ElevatedStructure, LatLng, StructureKind } from '@ijm/shared';
import { distanceMeters } from '@ijm/shared';

/**
 * 材質。
 *
 * 実際の構造物に塗られている色は OSM には入っていないため、
 * 「コンクリート」「鋼」といった一般的な材質の色に留めている。
 * 特定の構造物の色を創作しないという方針による。
 */
const MATERIAL: Record<StructureKind, { deck: Cesium.Color; pier: Cesium.Color }> = {
  'rail-elevated': {
    deck: Cesium.Color.fromCssColorString('#b8b4ad'),
    pier: Cesium.Color.fromCssColorString('#aca8a1'),
  },
  'rail-bridge': {
    deck: Cesium.Color.fromCssColorString('#9d9a95'),
    pier: Cesium.Color.fromCssColorString('#aca8a1'),
  },
  'road-elevated': {
    deck: Cesium.Color.fromCssColorString('#bcb8b1'),
    pier: Cesium.Color.fromCssColorString('#b0aca5'),
  },
  'road-bridge': {
    deck: Cesium.Color.fromCssColorString('#b5b1aa'),
    pier: Cesium.Color.fromCssColorString('#aaa6a0'),
  },
  footbridge: {
    deck: Cesium.Color.fromCssColorString('#c2beb7'),
    pier: Cesium.Color.fromCssColorString('#b4b0a9'),
  },
};

/**
 * 桁の断面。角を落として、拡大したときに板が浮いているように見えないようにする。
 * 原点は桁の上面中央。
 */
function deckShape(width: number, thickness: number): Cesium.Cartesian2[] {
  const hw = width / 2;
  // 下面はわずかに絞る（実際の桁も下側が細い）
  const bw = hw * 0.88;
  const chamfer = Math.min(0.25, thickness * 0.25);
  return [
    new Cesium.Cartesian2(-hw, 0),
    new Cesium.Cartesian2(hw, 0),
    new Cesium.Cartesian2(hw, -thickness + chamfer),
    new Cesium.Cartesian2(bw, -thickness),
    new Cesium.Cartesian2(-bw, -thickness),
    new Cesium.Cartesian2(-hw, -thickness + chamfer),
  ];
}

/** 高欄・防音壁の断面（デッキの縁に立てる薄い板） */
function railShape(height: number): Cesium.Cartesian2[] {
  const t = 0.18;
  return [
    new Cesium.Cartesian2(-t, 0),
    new Cesium.Cartesian2(t, 0),
    new Cesium.Cartesian2(t, height),
    new Cesium.Cartesian2(-t, height),
  ];
}

/** 経路を等間隔で分割した点を返す（橋脚の位置決めに使う） */
function samplePath(path: LatLng[], spacing: number): { point: LatLng; heading: number }[] {
  if (path.length < 2 || spacing <= 0) return [];
  const out: { point: LatLng; heading: number }[] = [];
  let carry = spacing / 2;

  for (let i = 0; i < path.length - 1; i += 1) {
    const a = path[i];
    const b = path[i + 1];
    const seg = distanceMeters(a, b);
    if (seg < 0.5) continue;
    const heading = Math.atan2(b.lng - a.lng, b.lat - a.lat);

    let t = carry;
    while (t < seg) {
      const r = t / seg;
      out.push({
        point: { lat: a.lat + (b.lat - a.lat) * r, lng: a.lng + (b.lng - a.lng) * r },
        heading,
      });
      t += spacing;
    }
    carry = t - seg;
  }
  return out;
}

export class ElevatedStructureLayer {
  private primitives: Cesium.Primitive[] = [];
  private loadedKey: string | null = null;

  constructor(private readonly viewer: Cesium.Viewer) {}

  get count(): number {
    return this.primitives.length;
  }

  /**
   * 構造物を描画する。
   *
   * 地形の標高は非同期でしか取れないので、まず地表高 0 を基準に組み立ててから、
   * 取得できた標高で位置を作り直す（最初から待つと表示が遅れる）。
   */
  async render(structures: ElevatedStructure[], key: string): Promise<void> {
    if (this.loadedKey === key) return;
    this.clear();
    this.loadedKey = key;
    if (structures.length === 0) return;

    // 構造物の代表点の標高をまとめて取得する
    const samples = structures.map((s) =>
      Cesium.Cartographic.fromDegrees(s.path[0].lng, s.path[0].lat),
    );
    let heights: number[] = samples.map(() => 0);
    try {
      const terrain = this.viewer.terrainProvider;
      if (terrain && !(terrain instanceof Cesium.EllipsoidTerrainProvider)) {
        const updated = await Cesium.sampleTerrainMostDetailed(terrain, samples);
        heights = updated.map((c) => c.height ?? 0);
      }
    } catch {
      /* 標高が取れなければ 0 のまま（平地では実害が小さい） */
    }

    const deckInstances: Cesium.GeometryInstance[] = [];
    const pierInstances: Cesium.GeometryInstance[] = [];
    const railInstances: Cesium.GeometryInstance[] = [];

    structures.forEach((s, index) => {
      const ground = heights[index] ?? 0;
      const deckTop = ground + s.clearance + s.deckThickness;
      const material = MATERIAL[s.kind];

      const positions = s.path.map((p) => Cesium.Cartesian3.fromDegrees(p.lng, p.lat, deckTop));
      if (positions.length < 2) return;

      // 桁
      deckInstances.push(
        new Cesium.GeometryInstance({
          id: s.id,
          geometry: new Cesium.PolylineVolumeGeometry({
            polylinePositions: positions,
            shapePositions: deckShape(s.width, s.deckThickness),
            cornerType: Cesium.CornerType.MITERED,
            vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
          }),
          attributes: {
            color: Cesium.ColorGeometryInstanceAttribute.fromColor(material.deck),
          },
        }),
      );

      // 高欄（鉄道は防音壁が高い）
      const railHeight = s.kind.startsWith('rail') ? 1.8 : 1.0;
      for (const side of [-1, 1]) {
        const offset = (s.width / 2 - 0.2) * side;
        const shifted = this.offsetPath(s.path, offset, deckTop);
        if (shifted.length < 2) continue;
        railInstances.push(
          new Cesium.GeometryInstance({
            geometry: new Cesium.PolylineVolumeGeometry({
              polylinePositions: shifted,
              shapePositions: railShape(railHeight),
              cornerType: Cesium.CornerType.MITERED,
              vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
            }),
            attributes: {
              color: Cesium.ColorGeometryInstanceAttribute.fromColor(
                material.deck.brighten(0.1, new Cesium.Color()),
              ),
            },
          }),
        );
      }

      // 橋脚
      if (s.pierSpacing > 0) {
        const pierHeight = s.clearance;
        if (pierHeight > 1) {
          for (const { point } of samplePath(s.path, s.pierSpacing)) {
            const center = Cesium.Cartesian3.fromDegrees(
              point.lng,
              point.lat,
              ground + pierHeight / 2,
            );
            const size = Math.min(2.4, Math.max(1.1, s.width * 0.18));
            pierInstances.push(
              new Cesium.GeometryInstance({
                geometry: new Cesium.BoxGeometry({
                  // 上を少し太くして、実際の橋脚に近い形にする
                  maximum: new Cesium.Cartesian3(size, size, pierHeight / 2),
                  minimum: new Cesium.Cartesian3(-size * 0.82, -size * 0.82, -pierHeight / 2),
                  vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
                }),
                modelMatrix: Cesium.Transforms.eastNorthUpToFixedFrame(center),
                attributes: {
                  color: Cesium.ColorGeometryInstanceAttribute.fromColor(material.pier),
                },
              }),
            );
          }
        }
      }
    });

    for (const instances of [deckInstances, pierInstances, railInstances]) {
      if (instances.length === 0) continue;
      const primitive = new Cesium.Primitive({
        geometryInstances: instances,
        appearance: new Cesium.PerInstanceColorAppearance({
          flat: false,
          translucent: false,
          closed: true,
        }),
        // 影を落とすと立体感が出る（品質設定で影を切っている場合は無視される）
        shadows: Cesium.ShadowMode.ENABLED,
        asynchronous: true,
      });
      this.viewer.scene.primitives.add(primitive);
      this.primitives.push(primitive);
    }
  }

  /** 中心線を法線方向にずらした経路を作る（高欄の位置決め） */
  private offsetPath(path: LatLng[], offsetM: number, height: number): Cesium.Cartesian3[] {
    const out: Cesium.Cartesian3[] = [];
    for (let i = 0; i < path.length; i += 1) {
      const prev = path[Math.max(0, i - 1)];
      const next = path[Math.min(path.length - 1, i + 1)];
      const dLat = next.lat - prev.lat;
      const dLng = next.lng - prev.lng;
      const len = Math.hypot(dLat, dLng);
      if (len === 0) continue;
      // 進行方向に垂直な単位ベクトル（度）
      const cos = Math.cos((path[i].lat * Math.PI) / 180) || 1;
      const nLat = (dLng / len) * (offsetM / 111_320);
      const nLng = (-dLat / len) * (offsetM / (111_320 * cos));
      out.push(
        Cesium.Cartesian3.fromDegrees(path[i].lng + nLng, path[i].lat + nLat, height),
      );
    }
    return out;
  }

  clear(): void {
    for (const p of this.primitives) {
      this.viewer.scene.primitives.remove(p);
    }
    this.primitives = [];
    this.loadedKey = null;
  }
}
