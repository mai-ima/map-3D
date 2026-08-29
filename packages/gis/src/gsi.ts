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
  attribution: string;
  /** 3D で建物と重ねたときの見え方の想定 */
  note?: string;
}

export const GSI_TILE_BASE = 'https://cyberjapandata.gsi.go.jp/xyz';

export const GSI_IMAGERY: readonly ImageryDefinition[] = [
  {
    id: 'seamlessphoto',
    label: '航空写真',
    urlTemplate: `${GSI_TILE_BASE}/seamlessphoto/{z}/{x}/{y}.jpg`,
    maximumLevel: 18,
    attribution: '出典：国土地理院（地理院タイル・シームレス空中写真）',
    note: '実際の地表の色がそのまま出るため、リアル志向の既定として採用',
  },
  {
    id: 'pale',
    label: '淡色地図',
    urlTemplate: `${GSI_TILE_BASE}/pale/{z}/{x}/{y}.png`,
    maximumLevel: 18,
    attribution: '出典：国土地理院（地理院タイル）',
    note: '地名・道路名を読みたいとき向け',
  },
  {
    id: 'std',
    label: '標準地図',
    urlTemplate: `${GSI_TILE_BASE}/std/{z}/{x}/{y}.png`,
    maximumLevel: 18,
    attribution: '出典：国土地理院（地理院タイル）',
  },
  {
    id: 'blank',
    label: '白地図',
    urlTemplate: `${GSI_TILE_BASE}/blank/{z}/{x}/{y}.png`,
    maximumLevel: 14,
    attribution: '出典：国土地理院（地理院タイル）',
    note: 'ゲームライクな見た目にしたい場合',
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
