/**
 * 描画エンジンに依存しない「形の記述」。
 *
 * この層を挟む理由:
 *
 *   1. 何を描くかを決める処理（OSM の解釈・寸法の決定）が、
 *      Cesium の API から切り離される。純粋な関数になるので、
 *      入力を与えて出力を測るだけで検証できる。
 *   2. 描画側を差し替えられる。将来 Swift（SceneKit / RealityKit）へ
 *      移すときも、ここまでの処理はそのまま移植できる。
 *      構造体・列挙型にそのまま対応する形にしてある。
 *
 * 座標はすべて WGS84 の緯度経度と楕円体高 (m)。
 * 断面や寸法はメートル。色は #rrggbb の文字列で、
 * 描画側がそれぞれの色表現へ変換する。
 */

import type { LatLng, LatLngAlt } from './types';

/**
 * 断面の 1 点。
 *
 * x は進行方向に対して右向き、y は上向き。どちらもメートル。
 * y = 0 が中心線の高さになるよう、断面は下端を 0 として書く。
 */
export interface SectionPoint {
  x: number;
  y: number;
}

/**
 * 経路に沿って断面を掃いた立体。
 *
 * 高架の床版・梁・防音壁、道路の縁石など、
 * 「線に沿って同じ断面が続くもの」はすべてこれで表せる。
 */
export interface ExtrudedShape {
  kind: 'extrusion';
  id?: string;
  /** 中心線。各点の高さは楕円体高 (m) */
  path: LatLngAlt[];
  /** 断面。下端を y = 0 とする */
  section: SectionPoint[];
  color: string;
  /** 影を落とすか。既定は落とす */
  castsShadow?: boolean;
}

/**
 * 向きを持つ直方体。
 *
 * 柱・橋台・信号機の箱など、点として置くものに使う。
 */
export interface BoxShape {
  kind: 'box';
  id?: string;
  centre: LatLngAlt;
  /** 真北を 0 とし、東回りを正とする方位角 (度) */
  headingDeg: number;
  /** x = 進行方向に対して右、y = 進行方向、z = 上（いずれも全長 m） */
  size: { x: number; y: number; z: number };
  color: string;
  castsShadow?: boolean;
}

/**
 * 地表に貼り付ける帯。
 *
 * 車道の舗装、車線の区画線、横断歩道など、
 * 「地面の模様」として見えるものに使う。立体ではないので
 * 地形の起伏に沿い、深度の競合も起こさない。
 */
export interface GroundRibbon {
  kind: 'ribbon';
  id?: string;
  path: LatLng[];
  /** 帯の幅 (m) */
  width: number;
  color: string;
  /** 破線にするときの [線の長さ, 空きの長さ] (m) */
  dash?: [number, number];
  /** 重なり順。大きいほど手前（区画線は舗装より手前） */
  order?: number;
}

export type SceneShape = ExtrudedShape | BoxShape | GroundRibbon;

/**
 * まとまりを持つ形の集合。
 *
 * 「この一群をまとめて出し入れする」「距離で描き分ける」といった
 * 扱いの単位。描画側はこの単位でバッチにまとめる。
 */
export interface SceneLayer {
  id: string;
  /** 人が読むための名前（診断表示に使う） */
  label: string;
  shapes: SceneShape[];
  /**
   * この層を描く最大距離 (m)。
   * 指定すると、視点から遠いところでは組み立てない。
   */
  maxDistanceM?: number;
}

/** 形が持つ頂点数の目安。負荷の見積もりに使う */
export function estimateVertexCount(shape: SceneShape): number {
  switch (shape.kind) {
    case 'extrusion':
      // 断面の点数 × 経路の点数（側面）+ 両端のふた
      return shape.section.length * shape.path.length * 2 + shape.section.length * 2;
    case 'box':
      return 24;
    case 'ribbon':
      return shape.path.length * 2;
  }
}

/** 層全体の頂点数の目安 */
export function estimateLayerVertices(layer: SceneLayer): number {
  let total = 0;
  for (const shape of layer.shapes) total += estimateVertexCount(shape);
  return total;
}
