/**
 * 座標系変換モジュール。
 *
 * 日本の GIS データは複数の座標系が混在するため、変換処理はここに集約する。
 *
 * - WGS84 (EPSG:4326)        : アプリ内部の標準。CesiumJS もこれ。
 * - JGD2011 (EPSG:6668)      : 日本の測地基準系。WGS84 とは定義が異なるが、
 *                              測地成果としての差は数 cm 未満のため、本アプリでは
 *                              「同一として扱う」ことを明示的な方針とする（都市可視化用途）。
 *                              cm 精度が要る用途ではこの近似を使ってはいけない。
 * - 平面直角座標系 I〜XIX     : JGD2011 / GRS80 楕円体、縮尺係数 0.9999。
 *                              EPSG:6669(I 系)〜EPSG:6687(XIX 系)。
 *                              PLATEAU の CityGML などで使われる。
 *
 * 平面直角座標系の換算は、国土地理院が公開している計算式（Gauss-Krüger 図法の
 * 級数展開, 6 次項まで）を実装している。
 * 参考: https://vldb.gsi.go.jp/sokuchi/surveycalc/surveycalc/algorithm/bl2xy/bl2xy.htm
 */

import { toDeg, toRad } from './geo';
import type { LatLng } from './types';

/** GRS80 楕円体 */
export const GRS80 = {
  a: 6378137.0,
  /** 扁平率の逆数 */
  invF: 298.257222101,
} as const;

/** 平面直角座標系の縮尺係数 */
export const PLANE_SCALE_FACTOR = 0.9999;

export interface PlaneOrigin {
  /** 系番号 1..19 */
  zone: number;
  /** 原点緯度 (度) */
  lat: number;
  /** 原点経度 (度) */
  lng: number;
  /** JGD2011 系の EPSG コード */
  epsg: number;
  /** 適用地域（参考） */
  area: string;
}

/** 平面直角座標系 I〜XIX の原点（JGD2011 = EPSG:6669..6687） */
export const PLANE_ORIGINS: readonly PlaneOrigin[] = [
  { zone: 1, lat: 33, lng: 129 + 30 / 60, epsg: 6669, area: '長崎・鹿児島の一部' },
  { zone: 2, lat: 33, lng: 131, epsg: 6670, area: '福岡・佐賀・熊本・大分・宮崎・鹿児島の一部' },
  { zone: 3, lat: 36, lng: 132 + 10 / 60, epsg: 6671, area: '山口・島根・広島' },
  { zone: 4, lat: 33, lng: 133 + 30 / 60, epsg: 6672, area: '香川・愛媛・徳島・高知' },
  { zone: 5, lat: 36, lng: 134 + 20 / 60, epsg: 6673, area: '兵庫・鳥取・岡山' },
  { zone: 6, lat: 36, lng: 136, epsg: 6674, area: '京都・大阪・福井・滋賀・三重・奈良・和歌山' },
  { zone: 7, lat: 36, lng: 137 + 10 / 60, epsg: 6675, area: '石川・富山・岐阜・愛知' },
  { zone: 8, lat: 36, lng: 138 + 30 / 60, epsg: 6676, area: '新潟・長野・山梨・静岡' },
  { zone: 9, lat: 36, lng: 139 + 50 / 60, epsg: 6677, area: '東京・福島・栃木・茨城・埼玉・千葉・群馬・神奈川' },
  { zone: 10, lat: 40, lng: 140 + 50 / 60, epsg: 6678, area: '青森・秋田・山形・岩手・宮城' },
  { zone: 11, lat: 44, lng: 140 + 15 / 60, epsg: 6679, area: '北海道(西部)' },
  { zone: 12, lat: 44, lng: 142 + 15 / 60, epsg: 6680, area: '北海道(中部)' },
  { zone: 13, lat: 44, lng: 144 + 15 / 60, epsg: 6681, area: '北海道(東部)' },
  { zone: 14, lat: 26, lng: 142, epsg: 6682, area: '小笠原' },
  { zone: 15, lat: 26, lng: 127 + 30 / 60, epsg: 6683, area: '沖縄本島' },
  { zone: 16, lat: 26, lng: 124, epsg: 6684, area: '先島諸島' },
  { zone: 17, lat: 26, lng: 131, epsg: 6685, area: '大東諸島' },
  { zone: 18, lat: 20, lng: 136, epsg: 6686, area: '沖ノ鳥島' },
  { zone: 19, lat: 26, lng: 154, epsg: 6687, area: '南鳥島' },
];

export interface PlaneXY {
  /** X = 北方向 (m) */
  x: number;
  /** Y = 東方向 (m) */
  y: number;
  zone: number;
}

const n = 1 / (2 * GRS80.invF - 1);

// 子午線弧長用の係数
const A_ = [
  1 + n ** 2 / 4 + n ** 4 / 64,
  -(3 / 2) * (n - n ** 3 / 8 - n ** 5 / 64),
  (15 / 16) * (n ** 2 - n ** 4 / 4),
  -(35 / 48) * (n ** 3 - (5 / 16) * n ** 5),
  (315 / 512) * n ** 4,
  -(693 / 1280) * n ** 5,
];

const ALPHA = [
  (1 / 2) * n - (2 / 3) * n ** 2 + (5 / 16) * n ** 3 + (41 / 180) * n ** 4 - (127 / 288) * n ** 5,
  (13 / 48) * n ** 2 - (3 / 5) * n ** 3 + (557 / 1440) * n ** 4 + (281 / 630) * n ** 5,
  (61 / 240) * n ** 3 - (103 / 140) * n ** 4 + (15061 / 26880) * n ** 5,
  (49561 / 161280) * n ** 4 - (179 / 168) * n ** 5,
  (34729 / 80640) * n ** 5,
];

const BETA = [
  (1 / 2) * n - (2 / 3) * n ** 2 + (37 / 96) * n ** 3 - (1 / 360) * n ** 4 - (81 / 512) * n ** 5,
  (1 / 48) * n ** 2 + (1 / 15) * n ** 3 - (437 / 1440) * n ** 4 + (46 / 105) * n ** 5,
  (17 / 480) * n ** 3 - (37 / 840) * n ** 4 - (209 / 4480) * n ** 5,
  (4397 / 161280) * n ** 4 - (11 / 504) * n ** 5,
  (4583 / 161280) * n ** 5,
];

const DELTA = [
  2 * n - (2 / 3) * n ** 2 - 2 * n ** 3 + (116 / 45) * n ** 4 + (26 / 45) * n ** 5 - (2854 / 675) * n ** 6,
  (7 / 3) * n ** 2 - (8 / 5) * n ** 3 - (227 / 45) * n ** 4 + (2704 / 315) * n ** 5 + (2323 / 945) * n ** 6,
  (56 / 15) * n ** 3 - (136 / 35) * n ** 4 - (1262 / 105) * n ** 5 + (73814 / 2835) * n ** 6,
  (4279 / 630) * n ** 4 - (332 / 35) * n ** 5 - (399572 / 14175) * n ** 6,
  (4174 / 315) * n ** 5 - (144838 / 6237) * n ** 6,
  (601676 / 22275) * n ** 6,
];

const A_BAR = ((PLANE_SCALE_FACTOR * GRS80.a) / (1 + n)) * A_[0];

/** 赤道から緯度 phi (rad) までの子午線弧長に相当する量 */
function meridianArc(phiRad: number): number {
  let s = A_[0] * phiRad;
  for (let i = 1; i <= 5; i++) {
    s += A_[i] * Math.sin(2 * i * phiRad);
  }
  return ((PLANE_SCALE_FACTOR * GRS80.a) / (1 + n)) * s;
}

export function getPlaneOrigin(zone: number): PlaneOrigin {
  const o = PLANE_ORIGINS.find((p) => p.zone === zone);
  if (!o) throw new Error(`不正な平面直角座標系の系番号: ${zone}`);
  return o;
}

/**
 * 各系のおおよその適用範囲 [minLng, minLat, maxLng, maxLat]。
 *
 * 正式な系の割り当ては「都道府県・市区町村」という行政区域単位で法令に定められており、
 * 座標だけからは一意に決まらない。この表は座標から系を推定するための近似であり、
 * データに系番号が付いている場合は必ずそちらを優先すること。
 */
const PLANE_ZONE_EXTENTS: Record<number, [number, number, number, number]> = {
  1: [128.0, 30.0, 130.3, 34.6],
  2: [129.8, 30.5, 131.9, 34.0],
  3: [131.0, 33.0, 133.3, 36.5],
  4: [132.9, 32.5, 134.8, 34.6],
  5: [133.3, 34.0, 135.2, 36.0],
  6: [134.9, 33.4, 136.4, 36.5],
  7: [136.2, 34.5, 137.9, 37.5],
  8: [137.6, 34.5, 139.4, 38.0],
  9: [138.4, 34.5, 141.0, 37.6],
  10: [139.4, 37.6, 142.2, 41.6],
  11: [139.5, 41.3, 141.6, 45.6],
  12: [141.6, 41.5, 143.6, 45.6],
  13: [143.6, 42.0, 146.2, 45.6],
  14: [141.0, 24.0, 143.0, 27.8],
  15: [126.6, 25.5, 128.5, 27.1],
  16: [122.9, 23.5, 125.5, 25.0],
  17: [130.5, 25.5, 131.5, 26.2],
  18: [135.5, 20.0, 136.5, 21.0],
  19: [153.5, 24.0, 154.5, 24.6],
};

/**
 * 緯度経度から平面直角座標系の系番号を推定する。
 * 適用範囲に含まれる系を優先し、複数該当する場合は原点が最も近いものを選ぶ。
 * どれにも含まれない場合は原点が最も近い系を返す。
 */
export function guessPlaneZone(p: LatLng): number {
  const distanceToOrigin = (o: PlaneOrigin): number =>
    Math.abs(p.lng - o.lng) * 2 + Math.abs(p.lat - o.lat);

  const candidates = PLANE_ORIGINS.filter((o) => {
    const ext = PLANE_ZONE_EXTENTS[o.zone];
    return ext && p.lng >= ext[0] && p.lat >= ext[1] && p.lng <= ext[2] && p.lat <= ext[3];
  });

  const pool = candidates.length > 0 ? candidates : PLANE_ORIGINS;
  let best = pool[0];
  let bestScore = distanceToOrigin(best);
  for (const o of pool) {
    const score = distanceToOrigin(o);
    if (score < bestScore) {
      bestScore = score;
      best = o;
    }
  }
  return best.zone;
}

/** 緯度経度 (JGD2011) → 平面直角座標 */
export function latLngToPlane(p: LatLng, zone = guessPlaneZone(p)): PlaneXY {
  const origin = getPlaneOrigin(zone);
  const phi = toRad(p.lat);
  const lambda = toRad(p.lng);
  const phi0 = toRad(origin.lat);
  const lambda0 = toRad(origin.lng);

  const dLambda = lambda - lambda0;
  const lc = Math.cos(dLambda);
  const ls = Math.sin(dLambda);

  const twoSqrtN = (2 * Math.sqrt(n)) / (1 + n);
  const t = Math.sinh(Math.atanh(Math.sin(phi)) - twoSqrtN * Math.atanh(twoSqrtN * Math.sin(phi)));
  const tBar = Math.sqrt(1 + t * t);

  const xi2 = Math.atan2(t, lc);
  const eta2 = Math.atanh(ls / tBar);

  let sigmaXi = xi2;
  let sigmaEta = eta2;
  for (let j = 1; j <= 5; j++) {
    sigmaXi += ALPHA[j - 1] * Math.sin(2 * j * xi2) * Math.cosh(2 * j * eta2);
    sigmaEta += ALPHA[j - 1] * Math.cos(2 * j * xi2) * Math.sinh(2 * j * eta2);
  }

  return {
    x: A_BAR * sigmaXi - meridianArc(phi0),
    y: A_BAR * sigmaEta,
    zone,
  };
}

/** 平面直角座標 → 緯度経度 (JGD2011) */
export function planeToLatLng(xy: PlaneXY): LatLng {
  const origin = getPlaneOrigin(xy.zone);
  const phi0 = toRad(origin.lat);
  const lambda0 = toRad(origin.lng);

  const xi = (xy.x + meridianArc(phi0)) / A_BAR;
  const eta = xy.y / A_BAR;

  let xi2 = xi;
  let eta2 = eta;
  for (let j = 1; j <= 5; j++) {
    xi2 -= BETA[j - 1] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
    eta2 -= BETA[j - 1] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
  }

  const chi = Math.asin(Math.sin(xi2) / Math.cosh(eta2));
  let phi = chi;
  for (let j = 1; j <= 6; j++) {
    phi += DELTA[j - 1] * Math.sin(2 * j * chi);
  }
  const lambda = lambda0 + Math.atan2(Math.sinh(eta2), Math.cos(xi2));

  return { lat: toDeg(phi), lng: toDeg(lambda) };
}

/**
 * JGD2011 と WGS84 の相互変換。
 * 現行の測地成果では両者の差は数 cm 未満であり、本アプリの用途（都市の 3D 可視化）では
 * 無視できるため恒等変換とする。cm 精度が必要な場合はこの関数を使わないこと。
 */
export function jgd2011ToWgs84(p: LatLng): LatLng {
  return { lat: p.lat, lng: p.lng };
}

export function wgs84ToJgd2011(p: LatLng): LatLng {
  return { lat: p.lat, lng: p.lng };
}

/**
 * 旧日本測地系 (Tokyo Datum, EPSG:4301) → WGS84 の簡易変換。
 * 古い資料由来のデータを扱う場合の近似式（誤差数 m）。正確な変換が必要なら
 * 国土地理院の TKY2JGD パラメータを使うこと。
 */
export function tokyoDatumToWgs84(p: LatLng): LatLng {
  return {
    lat: p.lat - 0.00010695 * p.lat + 0.000017464 * p.lng + 0.0046017,
    lng: p.lng - 0.000046038 * p.lat - 0.000083043 * p.lng + 0.010040,
  };
}

/** EPSG コード文字列を解釈して、対応する変換関数の識別子を返す */
export function resolveCrs(epsg: string | number): {
  kind: 'wgs84' | 'jgd2011' | 'plane' | 'tokyo';
  zone?: number;
} {
  const code = typeof epsg === 'number' ? epsg : Number(String(epsg).replace(/[^0-9]/g, ''));
  if (code === 4326) return { kind: 'wgs84' };
  if (code === 6668 || code === 6697) return { kind: 'jgd2011' };
  if (code === 4301 || code === 4326 + 0) return { kind: 'tokyo' };
  const plane = PLANE_ORIGINS.find((o) => o.epsg === code);
  if (plane) return { kind: 'plane', zone: plane.zone };
  // JGD2000 の平面直角座標系 (EPSG:2443..2461) も同じ原点
  if (code >= 2443 && code <= 2461) return { kind: 'plane', zone: code - 2442 };
  throw new Error(`未対応の座標系: EPSG:${code}`);
}

/** 任意の対応座標系から WGS84 へ変換する共通入口 */
export function toWgs84(
  coords: { x: number; y: number },
  crs: string | number,
): LatLng {
  const resolved = resolveCrs(crs);
  switch (resolved.kind) {
    case 'wgs84':
    case 'jgd2011':
      // x=経度, y=緯度 の順で受け取る規約
      return { lng: coords.x, lat: coords.y };
    case 'tokyo':
      return tokyoDatumToWgs84({ lng: coords.x, lat: coords.y });
    case 'plane':
      return jgd2011ToWgs84(planeToLatLng({ x: coords.x, y: coords.y, zone: resolved.zone! }));
  }
}
