/**
 * 国土地理院（地理院タイル）の定義。
 *
 * 利用規約: ウェブ地図としてリアルタイムに読み込む場合は「出典明示のみ」で申請不要。
 * https://www.gsi.go.jp/kikakuchousei/kikakuchousei40182.html
 */

export interface ImageryDefinition {
  id: string;
  label: string;
  urlTemplate: string;
  maximumLevel: number;
  /**
   * 提供されている最小のズームレベル。
   *
   * 地理院タイルには **ズーム 0 と 1 が無い**（404 が返る）。
   * これを指定しないと Cesium はズーム 0 から読もうとして失敗し、
   * 引いた状態で地球に何も貼られず、日本地図が消えたように見える。
   * 実測（2026-09）: 0/1 は全レイヤ 404、2 以上は seamlessphoto /
   * std / pale なら世界中で 200 が返る。
   */
  minimumLevel: number;
  attribution: string;
  /**
   * 提供範囲 [minLng, minLat, maxLng, maxLat]。
   * 日本国内しか無いレイヤは、範囲外を要求しないようここで区切る。
   */
  coverage?: [number, number, number, number];
  /** 3D で建物と重ねたときの見え方の想定 */
  note?: string;
}

/**
 * 日本の範囲（南西諸島から北方領土まで）。
 * 国外に絵が無いレイヤの提供範囲に使う。
 */
export const JAPAN_BOUNDS: [number, number, number, number] = [122.9, 20.4, 154.0, 45.6];

export const GSI_TILE_BASE = 'https://cyberjapandata.gsi.go.jp/xyz';

export const GSI_IMAGERY: readonly ImageryDefinition[] = [
  {
    id: 'seamlessphoto',
    label: '航空写真',
    urlTemplate: `${GSI_TILE_BASE}/seamlessphoto/{z}/{x}/{y}.jpg`,
    maximumLevel: 18,
    minimumLevel: 2,
    attribution: '出典：国土地理院（地理院タイル・シームレス空中写真）',
    note: '実際の地表の色がそのまま出るため、リアル志向の既定として採用',
  },
  {
    id: 'pale',
    label: '淡色地図',
    urlTemplate: `${GSI_TILE_BASE}/pale/{z}/{x}/{y}.png`,
    maximumLevel: 18,
    minimumLevel: 2,
    attribution: '出典：国土地理院（地理院タイル）',
    note: '地名・道路名を読みたいとき向け',
  },
  {
    id: 'std',
    label: '標準地図',
    urlTemplate: `${GSI_TILE_BASE}/std/{z}/{x}/{y}.png`,
    maximumLevel: 18,
    minimumLevel: 2,
    attribution: '出典：国土地理院（地理院タイル）',
  },
  {
    id: 'blank',
    label: '白地図',
    urlTemplate: `${GSI_TILE_BASE}/blank/{z}/{x}/{y}.png`,
    maximumLevel: 14,
    // 白地図はズーム 5 から。しかも日本国内にしか絵が無い（国外は 404）
    minimumLevel: 5,
    coverage: JAPAN_BOUNDS,
    attribution: '出典：国土地理院（地理院タイル）',
    note: 'ゲームライクな見た目にしたい場合。日本国内のみ',
  },
];

/** 既定は航空写真（実際の地表の色をそのまま出すため） */
export const DEFAULT_IMAGERY_ID = 'seamlessphoto';

/** 標高タイル（terrain を自前生成する場合の入力） */
export const GSI_DEM_URL_TEMPLATE = `${GSI_TILE_BASE}/dem_png/{z}/{x}/{y}.png`;

export function getImagery(id: string): ImageryDefinition {
  return GSI_IMAGERY.find((i) => i.id === id) ?? GSI_IMAGERY[0];
}

/**
 * 引いたときに全球を覆うのに要るタイルの枚数。
 *
 * minimumLevel を上げるほど枚数が増える（レベル n で 4^n 枚）。
 * ズーム 2 なら 16 枚で、起動時の負担にはならない。
 * ここが増えすぎていないかを検証で見るために出しておく。
 */
export function tilesToCoverGlobe(minimumLevel: number): number {
  return 4 ** minimumLevel;
}

/**
 * 地理院の標高タイル (dem_png) の画素値を標高 (m) に変換する。
 * R,G,B から 24bit 符号付き整数 x を作り、x < 2^23 なら h = x * 0.01、
 * x = 2^23 は無効値、x > 2^23 なら h = (x - 2^24) * 0.01。
 * https://maps.gsi.go.jp/development/demtile.html
 */
export function demPixelToElevation(r: number, g: number, b: number): number | null {
  const x = r * 65536 + g * 256 + b;
  if (x === 8388608) return null; // 無効値
  return x < 8388608 ? x * 0.01 : (x - 16777216) * 0.01;
}
