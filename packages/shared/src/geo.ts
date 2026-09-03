/**
 * 測地・幾何ユーティリティ。
 * 距離計算は WGS84 の平均半径による球面近似（都市スケールでは誤差 0.5% 未満）。
 * より高精度が必要な処理（座標系変換）は coords.ts を使う。
 */

import type { BBox, LatLng } from './types';

export const EARTH_RADIUS_M = 6371008.8;

export const toRad = (deg: number): number => (deg * Math.PI) / 180;
export const toDeg = (rad: number): number => (rad * 180) / Math.PI;

/** 2 点間の距離 (m) — Haversine */
export function distanceMeters(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** a から b への初期方位 (度, 0=北, 時計回り) */
export function bearingDegrees(a: LatLng, b: LatLng): number {
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLng = toRad(b.lng - a.lng);
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/** 方位と距離から目的地を求める */
export function destinationPoint(origin: LatLng, bearingDeg: number, distanceM: number): LatLng {
  const d = distanceM / EARTH_RADIUS_M;
  const brg = toRad(bearingDeg);
  const lat1 = toRad(origin.lat);
  const lng1 = toRad(origin.lng);
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(brg));
  const lng2 =
    lng1 +
    Math.atan2(
      Math.sin(brg) * Math.sin(d) * Math.cos(lat1),
      Math.cos(d) - Math.sin(lat1) * Math.sin(lat2),
    );
  return { lat: toDeg(lat2), lng: ((toDeg(lng2) + 540) % 360) - 180 };
}

/** 角度を [-180, 180) に正規化 */
export function normalizeAngle(deg: number): number {
  let a = ((deg + 180) % 360 + 360) % 360 - 180;
  if (a === 180) a = -180;
  return a;
}

/** 2 つの方位の最短差 (度, -180..180) */
export function angleDelta(from: number, to: number): number {
  return normalizeAngle(to - from);
}

/** 方位の線形補間（360/0 の境界をまたいでも最短経路で回る） */
export function lerpAngle(from: number, to: number, t: number): number {
  return (from + angleDelta(from, to) * t + 360) % 360;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

/**
 * 臨界減衰スプリングによる平滑化。
 * カメラの急な移動を避けるために使う（Game Programming Gems 4 の SmoothDamp と同系）。
 *
 * @param current 現在値
 * @param target  目標値
 * @param velocity 速度（呼び出し側で保持し、この関数が更新する）
 * @param smoothTime 目標に到達するおおよその時間 (s)
 * @param dt フレーム時間 (s)
 */
export function smoothDamp(
  current: number,
  target: number,
  velocity: { value: number },
  smoothTime: number,
  dt: number,
  maxSpeed = Infinity,
): number {
  const st = Math.max(0.0001, smoothTime);
  const omega = 2 / st;
  const x = omega * dt;
  // exp(-x) の有理近似（高速かつ十分な精度）
  const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  let change = current - target;
  const maxChange = maxSpeed * st;
  change = clamp(change, -maxChange, maxChange);
  const temp = (velocity.value + omega * change) * dt;
  velocity.value = (velocity.value - omega * temp) * exp;
  let output = target + (change + temp) * exp;
  // オーバーシュート抑制
  if (target - current > 0 === output > target) {
    output = target;
    velocity.value = (output - target) / dt;
  }
  return output;
}

/** 角度版の smoothDamp（最短回転方向で補間する） */
export function smoothDampAngle(
  current: number,
  target: number,
  velocity: { value: number },
  smoothTime: number,
  dt: number,
): number {
  const adjusted = current + angleDelta(current, target);
  return (smoothDamp(current, adjusted, velocity, smoothTime, dt) + 360) % 360;
}

/** 座標列のバウンディングボックス */
export function bboxOf(coords: [number, number][]): BBox {
  let minLng = Infinity;
  let minLat = Infinity;
  let maxLng = -Infinity;
  let maxLat = -Infinity;
  for (const [lng, lat] of coords) {
    if (lng < minLng) minLng = lng;
    if (lat < minLat) minLat = lat;
    if (lng > maxLng) maxLng = lng;
    if (lat > maxLat) maxLat = lat;
  }
  return [minLng, minLat, maxLng, maxLat];
}

export function bboxContains(bbox: BBox, p: LatLng): boolean {
  return p.lng >= bbox[0] && p.lat >= bbox[1] && p.lng <= bbox[2] && p.lat <= bbox[3];
}

/** 2 つの bbox が重なるか（辺で接する場合も重なりとみなす） */
export function bboxIntersects(a: BBox, b: BBox): boolean {
  const [aMinLng, aMinLat, aMaxLng, aMaxLat] = a;
  const [bMinLng, bMinLat, bMaxLng, bMaxLat] = b;
  return aMinLng <= bMaxLng && aMaxLng >= bMinLng && aMinLat <= bMaxLat && aMaxLat >= bMinLat;
}

/** 中心から指定距離の正方形 bbox を作る */
export function bboxAround(center: LatLng, meters: number): BBox {
  const dLat = meters / 111_320;
  const dLng = meters / (111_320 * Math.cos((center.lat * Math.PI) / 180) || 1);
  return [center.lng - dLng, center.lat - dLat, center.lng + dLng, center.lat + dLat];
}

export function bboxCenter(bbox: BBox): LatLng {
  return { lng: (bbox[0] + bbox[2]) / 2, lat: (bbox[1] + bbox[3]) / 2 };
}

/** bbox を指定メートルだけ拡張する */
export function bboxExpand(bbox: BBox, meters: number): BBox {
  const latDeg = meters / 111320;
  const midLat = (bbox[1] + bbox[3]) / 2;
  const lngDeg = meters / (111320 * Math.max(0.01, Math.cos(toRad(midLat))));
  return [bbox[0] - lngDeg, bbox[1] - latDeg, bbox[2] + lngDeg, bbox[3] + latDeg];
}

export interface ProjectionResult {
  /** 線分上の最近傍点 */
  point: LatLng;
  /** 何番目の区間か（coords[i] → coords[i+1]） */
  segmentIndex: number;
  /** 区間内での位置 0..1 */
  t: number;
  /** 元の点からの距離 (m) */
  distance: number;
  /** 経路始点からの累積距離 (m) */
  distanceAlong: number;
}

/**
 * 点を折れ線に投影する（現在地のルートへのスナップに使う）。
 * @param searchFrom 探索開始区間（前フレームの結果を渡すと O(1) 近くになる）
 * @param searchWindow 探索する区間数
 */
export function projectOnPolyline(
  point: LatLng,
  coords: [number, number][],
  cumulative: number[],
  searchFrom = 0,
  searchWindow = Number.MAX_SAFE_INTEGER,
): ProjectionResult {
  const start = Math.max(0, searchFrom);
  const end = Math.min(coords.length - 2, searchFrom + searchWindow);
  let best: ProjectionResult | null = null;

  const cosLat = Math.cos(toRad(point.lat));
  for (let i = start; i <= end; i++) {
    const a = coords[i];
    const b = coords[i + 1];
    // 局所平面近似（度をメートル換算）
    const ax = a[0] * cosLat * 111320;
    const ay = a[1] * 110540;
    const bx = b[0] * cosLat * 111320;
    const by = b[1] * 110540;
    const px = point.lng * cosLat * 111320;
    const py = point.lat * 110540;
    const dx = bx - ax;
    const dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    const t = lenSq === 0 ? 0 : clamp(((px - ax) * dx + (py - ay) * dy) / lenSq, 0, 1);
    const cx = ax + dx * t;
    const cy = ay + dy * t;
    const dist = Math.hypot(px - cx, py - cy);
    if (!best || dist < best.distance) {
      const snapped: LatLng = {
        lng: a[0] + (b[0] - a[0]) * t,
        lat: a[1] + (b[1] - a[1]) * t,
      };
      const segLen = cumulative[i + 1] - cumulative[i];
      best = {
        point: snapped,
        segmentIndex: i,
        t,
        distance: dist,
        distanceAlong: cumulative[i] + segLen * t,
      };
    }
  }

  if (!best) {
    const first = coords[0] ?? [0, 0];
    return {
      point: { lng: first[0], lat: first[1] },
      segmentIndex: 0,
      t: 0,
      distance: 0,
      distanceAlong: 0,
    };
  }
  return best;
}

/** 折れ線の累積距離配列 */
export function cumulativeDistances(coords: [number, number][]): number[] {
  if (coords.length === 0) return [];
  const out = new Array<number>(coords.length);
  out[0] = 0;
  for (let i = 1; i < coords.length; i++) {
    out[i] =
      out[i - 1] +
      distanceMeters(
        { lng: coords[i - 1][0], lat: coords[i - 1][1] },
        { lng: coords[i][0], lat: coords[i][1] },
      );
  }
  return out;
}

/** 始点からの距離を指定して折れ線上の座標を得る */
export function pointAtDistance(
  coords: [number, number][],
  cumulative: number[],
  distance: number,
): { point: LatLng; segmentIndex: number } {
  if (coords.length === 0) return { point: { lat: 0, lng: 0 }, segmentIndex: 0 };
  const total = cumulative[cumulative.length - 1];
  const d = clamp(distance, 0, total);
  let lo = 0;
  let hi = cumulative.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (cumulative[mid] <= d) lo = mid;
    else hi = mid;
  }
  const segLen = cumulative[lo + 1] - cumulative[lo];
  const t = segLen === 0 ? 0 : (d - cumulative[lo]) / segLen;
  const a = coords[lo];
  const b = coords[Math.min(lo + 1, coords.length - 1)];
  return {
    point: { lng: a[0] + (b[0] - a[0]) * t, lat: a[1] + (b[1] - a[1]) * t },
    segmentIndex: lo,
  };
}

/** 折れ線上の指定位置における進行方位 */
export function headingAtIndex(coords: [number, number][], index: number, lookAhead = 1): number {
  // 線にならない経路には向きが無い。北を向いていることにする。
  // ここで落ちると、壊れたルートを受け取っただけで案内が始まらない
  if (coords.length < 2) return 0;
  const i = clamp(index, 0, coords.length - 2);
  const j = clamp(i + lookAhead, 0, coords.length - 1);
  const a = coords[i];
  const b = coords[j === i ? Math.min(i + 1, coords.length - 1) : j];
  if (!a || !b) return 0;
  return bearingDegrees({ lng: a[0], lat: a[1] }, { lng: b[0], lat: b[1] });
}

/** bbox をクエリ文字列から読むときの制限 */
export interface BBoxLimits {
  /** 東西の幅の上限 (度) */
  maxSpanLng?: number;
  /** 南北の高さの上限 (度) */
  maxSpanLat?: number;
}

/**
 * クエリ文字列を bbox として読む。読めなければ null。
 *
 * 3 つの API（roads / structures / furniture）が同じ検証をしていたが、
 * furniture だけ抜けがあり、南北や東西が逆転した bbox や、
 * 地球上に存在しない座標、50 度四方といった巨大な範囲を通していた。
 * 逆転していると面積が負になり、「広すぎる」の判定をすり抜ける。
 *
 * 検証はここ 1 か所に集約する。
 */
export function parseBBoxParam(value: string | null, limits: BBoxLimits = {}): BBox | null {
  if (!value) return null;
  const parts = value.split(',').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;

  const [minLng, minLat, maxLng, maxLat] = parts;
  // 地球上に無い座標
  if (minLng < -180 || maxLng > 180 || minLat < -90 || maxLat > 90) return null;
  // southwest と northeast が逆
  if (minLng >= maxLng || minLat >= maxLat) return null;

  if (limits.maxSpanLng !== undefined && maxLng - minLng > limits.maxSpanLng) return null;
  if (limits.maxSpanLat !== undefined && maxLat - minLat > limits.maxSpanLat) return null;

  return [minLng, minLat, maxLng, maxLat];
}

/**
 * クエリの数値を読む。読めなければ null。
 *
 * `Number(null)` は 0 になるので、素朴に書くと「指定が無い」ことと
 * 「0 が指定されている」ことを区別できない。これが原因で、
 * lat も lng も無い要求が「緯度 0・経度 0（大西洋）」として通っていた。
 */
export function parseNumberParam(
  value: string | null,
  limits: { min?: number; max?: number } = {},
): number | null {
  if (value === null || value.trim() === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (limits.min !== undefined && n < limits.min) return null;
  if (limits.max !== undefined && n > limits.max) return null;
  return n;
}

/**
 * クエリの数値を、範囲に収めて読む。
 * 読めなければ既定値、範囲外なら端に丸める（半径や件数の上限に使う）。
 */
export function clampNumberParam(
  value: string | null,
  fallback: number,
  min: number,
  max: number,
): number {
  const n = parseNumberParam(value);
  if (n === null) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** クエリから緯度経度を読む。地球上に無い値は null */
export function parseLatLngParam(
  latValue: string | null,
  lngValue: string | null,
): LatLng | null {
  const lat = parseNumberParam(latValue, { min: -90, max: 90 });
  const lng = parseNumberParam(lngValue, { min: -180, max: 180 });
  if (lat === null || lng === null) return null;
  return { lat, lng };
}

/**
 * JSON の本文に入っている座標を読む。
 *
 * クエリ文字列と違い、こちらは型も形も何でも来る（配列、文字列、null、NaN）。
 * そのまま外部への問い合わせに渡すと、NaN を含む URL を組み立てて投げてしまう。
 */
export function readLatLng(value: unknown): LatLng | null {
  if (typeof value !== 'object' || value === null) return null;
  const { lat, lng } = value as { lat?: unknown; lng?: unknown };
  if (typeof lat !== 'number' || typeof lng !== 'number') return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}
