/**
 * アイコンの形状データ（フレームワーク非依存）。
 *
 * 絵文字は使わない。理由:
 *  - 環境ごとに字形・色・サイズが変わり、デザインが破綻する
 *  - 3D シーン上のラベルでは特にサイズと余白が制御できない
 *  - 意味が曖昧（例: 🅿 は環境によって別字形になる）
 *
 * ここには「形」だけを持ち、描画は 2 か所で行う:
 *  - packages/ui/src/icons.tsx        … React の SVG コンポーネント
 *  - packages/map-engine/src/marker-icons.ts … Cesium のビルボード用 SVG データ URI
 * 形状データを 1 か所にまとめることで、UI と 3D で同じ絵柄になる。
 *
 * 座標系は 24x24。線は currentColor、既定の線幅は 1.7。
 */

export type IconPrimitive =
  | { kind: 'path'; d: string; filled?: boolean }
  | { kind: 'circle'; cx: number; cy: number; r: number; filled?: boolean }
  | { kind: 'line'; x1: number; y1: number; x2: number; y2: number }
  | { kind: 'rect'; x: number; y: number; w: number; h: number; rx?: number; filled?: boolean };

export interface IconDefinition {
  /** 24x24 前提。異なる場合のみ指定 */
  viewBox?: string;
  primitives: IconPrimitive[];
}

const p = (d: string, filled?: boolean): IconPrimitive => ({ kind: 'path', d, filled });
const c = (cx: number, cy: number, r: number, filled?: boolean): IconPrimitive => ({
  kind: 'circle',
  cx,
  cy,
  r,
  filled,
});
const l = (x1: number, y1: number, x2: number, y2: number): IconPrimitive => ({
  kind: 'line',
  x1,
  y1,
  x2,
  y2,
});
const r = (
  x: number,
  y: number,
  w: number,
  h: number,
  rx = 2,
  filled?: boolean,
): IconPrimitive => ({ kind: 'rect', x, y, w, h, rx, filled });

export const ICONS = {
  // ---- 操作 -------------------------------------------------------------
  search: { primitives: [c(11, 11, 6.4), l(15.8, 15.8, 21, 21)] },
  close: { primitives: [l(6.5, 6.5, 17.5, 17.5), l(17.5, 6.5, 6.5, 17.5)] },
  chevronDown: { primitives: [p('M6 9.5 12 15.5 18 9.5')] },
  chevronUp: { primitives: [p('M6 14.5 12 8.5 18 14.5')] },
  /** AI アシスタント（4 芒星） */
  sparkle: {
    primitives: [
      p('M12 3.2 13.5 9.3 19.6 10.8 13.5 12.3 12 18.4 10.5 12.3 4.4 10.8 10.5 9.3Z'),
      p('M18.4 15.6 19.1 18.2 21.7 18.9 19.1 19.6 18.4 22.2 17.7 19.6 15.1 18.9 17.7 18.2Z'),
    ],
  },
  /** 出発地（同心円） */
  origin: { primitives: [c(12, 12, 7), c(12, 12, 2.6, true)] },
  /** 目的地（旗） */
  destination: {
    primitives: [l(6.5, 21, 6.5, 3.4), p('M6.5 4.4h10.8l-2.4 3.6 2.4 3.6H6.5Z')],
  },
  /** 地点マーカー */
  pin: { primitives: [p('M12 21.2s6.6-6.4 6.6-10.5A6.6 6.6 0 0 0 5.4 10.7C5.4 14.8 12 21.2 12 21.2Z'), c(12, 10.5, 2.4)] },
  layers: {
    primitives: [p('M12 3.5 21 8.2 12 12.9 3 8.2Z'), p('M3 12.6 12 17.3l9-4.7'), p('M3 16.9 12 21.6l9-4.7')],
  },

  // ---- 移動手段 ---------------------------------------------------------
  walk: {
    primitives: [
      c(13.2, 4.4, 1.9),
      p('M13.4 8.1 10 10.2 8.4 13.7'),
      p('M13.4 8.1l2.9 2.2 1 3.3'),
      p('M11.6 12.2 10.6 16.3 8.2 20.6'),
      p('M11.6 12.2l3.1 2.5.9 3.1 1.6 2.8'),
    ],
  },
  car: {
    primitives: [
      p('M4 16.2v-3.4l2-4.6A2.2 2.2 0 0 1 8 6.8h8a2.2 2.2 0 0 1 2 1.4l2 4.6v3.4'),
      l(4, 12.8, 20, 12.8),
      c(7.6, 16.4, 1.7),
      c(16.4, 16.4, 1.7),
      l(9.4, 16.4, 14.6, 16.4),
    ],
  },
  bike: {
    primitives: [
      c(5.8, 16.2, 3.6),
      c(18.2, 16.2, 3.6),
      p('M5.8 16.2 10.4 8.8h5.2l2.6 7.4'),
      l(10.4, 8.8, 14.4, 16.2),
      l(14.6, 7, 17.4, 7),
    ],
  },
  transit: {
    primitives: [
      r(5.5, 4, 13, 12, 3),
      l(5.5, 10.4, 18.5, 10.4),
      c(9, 13.3, 1),
      c(15, 13.3, 1),
      l(8.6, 16, 6.6, 20),
      l(15.4, 16, 17.4, 20),
    ],
  },

  // ---- 天候 -------------------------------------------------------------
  sun: {
    primitives: [
      c(12, 12, 4.2),
      l(12, 2.6, 12, 5),
      l(12, 19, 12, 21.4),
      l(2.6, 12, 5, 12),
      l(19, 12, 21.4, 12),
      l(5.4, 5.4, 7.1, 7.1),
      l(16.9, 16.9, 18.6, 18.6),
      l(18.6, 5.4, 16.9, 7.1),
      l(7.1, 16.9, 5.4, 18.6),
    ],
  },
  cloud: {
    primitives: [
      p('M7.2 18.4h9.6a3.7 3.7 0 0 0 .4-7.4 5.3 5.3 0 0 0-10-1.6 3.9 3.9 0 0 0 0 9Z'),
    ],
  },
  rain: {
    primitives: [
      p('M7.4 15.2h9.2a3.5 3.5 0 0 0 .4-7 5 5 0 0 0-9.5-1.5 3.7 3.7 0 0 0-.1 8.5Z'),
      l(8.6, 17.6, 7.4, 20.6),
      l(12.4, 17.6, 11.2, 20.6),
      l(16.2, 17.6, 15, 20.6),
    ],
  },
  snow: {
    primitives: [
      p('M7.4 15.2h9.2a3.5 3.5 0 0 0 .4-7 5 5 0 0 0-9.5-1.5 3.7 3.7 0 0 0-.1 8.5Z'),
      c(8.4, 19, 1, true),
      c(12, 20.4, 1, true),
      c(15.6, 19, 1, true),
    ],
  },
  fog: {
    primitives: [
      p('M7.4 13.6h9.2a3.5 3.5 0 0 0 .4-7 5 5 0 0 0-9.5-1.5 3.7 3.7 0 0 0-.1 8.5Z'),
      l(5, 17.2, 19, 17.2),
      l(7.4, 20.2, 16.6, 20.2),
    ],
  },

  // ---- POI --------------------------------------------------------------
  store: {
    primitives: [
      p('M4.6 9.4 6.2 4.6h11.6l1.6 4.8'),
      l(4.6, 9.4, 19.4, 9.4),
      p('M6 9.4V19.4h12V9.4'),
      r(9.8, 13.4, 4.4, 6, 0.6),
    ],
  },
  cafe: {
    primitives: [
      p('M6 8.4h10v4.8a5 5 0 0 1-10 0Z'),
      p('M16 9.4h1.8a2.3 2.3 0 0 1 0 4.6H16'),
      l(4.6, 20.2, 17.4, 20.2),
    ],
  },
  restaurant: {
    primitives: [
      p('M7.6 3.4v4.2a2.3 2.3 0 0 0 4.6 0V3.4'),
      l(9.9, 3.4, 9.9, 7.6),
      l(9.9, 9.9, 9.9, 20.6),
      p('M16.6 3.4c2 2.2 2 6.6 0 8.8v8.4'),
    ],
  },
  hospital: { primitives: [r(4.2, 4.2, 15.6, 15.6, 3.4), l(12, 8.4, 12, 15.6), l(8.4, 12, 15.6, 12)] },
  school: {
    primitives: [
      p('M3.4 10.6 12 5.8l8.6 4.8'),
      p('M5.6 11.4V19.8h12.8V11.4'),
      r(10.2, 15, 3.6, 4.8, 0.6),
      l(12, 5.8, 12, 3),
      p('M12 3.2h2.8l-1 1.1 1 1.1H12'),
    ],
  },
  park: {
    primitives: [
      p('M12 3.8 16.6 10.2H7.4Z'),
      p('M12 8.6 18 15.6H6Z'),
      l(12, 15.6, 12, 20.4),
    ],
  },
  parking: {
    primitives: [r(4.2, 4.2, 15.6, 15.6, 3.4), p('M10 17V7.6h3.2a2.9 2.9 0 0 1 0 5.8H10')],
  },
  shop: {
    primitives: [p('M6 8.4h12l-1.1 11.8H7.1Z'), p('M9.4 8.4a2.6 2.6 0 0 1 5.2 0')],
  },
  toilets: {
    primitives: [
      c(7.6, 4.8, 1.7),
      l(7.6, 7.4, 7.6, 13.6),
      l(5.5, 9.6, 9.7, 9.6),
      l(7.6, 13.6, 6.4, 19.6),
      l(7.6, 13.6, 8.8, 19.6),
      c(16.4, 4.8, 1.7),
      l(14.3, 9.6, 18.5, 9.6),
      p('M16.4 7.4 14.3 15.8h4.2Z'),
      l(15.3, 15.8, 14.9, 19.6),
      l(17.5, 15.8, 17.9, 19.6),
      l(12, 3.6, 12, 20.4),
    ],
  },
  atm: { primitives: [r(3.2, 5.4, 17.6, 13.2, 2.4), l(3.2, 9.8, 20.8, 9.8), l(6.6, 14.6, 10.4, 14.6)] },
  hotel: {
    primitives: [
      l(3.4, 19.6, 3.4, 8.4),
      p('M3.4 13.6h13.4a3.8 3.8 0 0 1 3.8 3.8v2.2'),
      c(7.4, 11, 1.8),
      l(3.4, 19.6, 20.6, 19.6),
    ],
  },

  // ---- マニューバ（案内） ----------------------------------------------
  straight: { primitives: [l(12, 20.6, 12, 5.4), p('M6.6 10.8 12 5.4l5.4 5.4')] },
  turnLeft: { primitives: [p('M17.6 20.6v-6.2a4 4 0 0 0-4-4H7'), p('M11.4 6.2 7 10.4l4.4 4.2')] },
  turnRight: { primitives: [p('M6.4 20.6v-6.2a4 4 0 0 1 4-4H17'), p('M12.6 6.2 17 10.4l-4.4 4.2')] },
  slightLeft: { primitives: [p('M15.4 20.6v-7.4L8.6 6.6'), p('M8.2 12.2V6.2h6')] },
  slightRight: { primitives: [p('M8.6 20.6v-7.4l6.8-6.6'), p('M15.8 12.2V6.2h-6')] },
  sharpLeft: { primitives: [p('M17.4 20.6v-4a5 5 0 0 0-5-5H8.6'), p('M12 7.4 7.6 11.6 12 15.8')] },
  sharpRight: { primitives: [p('M6.6 20.6v-4a5 5 0 0 1 5-5h3.8'), p('M12 7.4l4.4 4.2L12 15.8')] },
  uturn: { primitives: [p('M8 20.6v-8.2a4 4 0 0 1 8 0v3.4'), p('M12.4 14.8 16 18.4l3.6-3.6')] },
  merge: {
    primitives: [
      p('M7.8 20.6v-4.8c0-2.2 1.8-3 4.2-4.2'),
      p('M16.2 20.6v-4.8c0-2.2-1.8-3-4.2-4.2'),
      l(12, 11.6, 12, 4.8),
      p('M9 7.8 12 4.8l3 3'),
    ],
  },
  ramp: { primitives: [p('M7 20.6v-7a7 7 0 0 1 7-7h3.4'), p('M14.6 3.4 18 6.6l-3.4 3.2')] },
  roundabout: {
    primitives: [
      c(11, 11.4, 4),
      l(11, 20.6, 11, 15.4),
      l(15, 11.4, 19.4, 11.4),
      p('M17.4 9.4 19.4 11.4 17.4 13.4'),
    ],
  },
  stairs: { primitives: [p('M4 19.4h4v-4.2h4V11h4V6.8h4')] },
  ferry: {
    primitives: [
      p('M4.2 15.4h15.6l-2.6 4.4H6.8Z'),
      p('M8.2 15.4v-4.8h7.6v4.8'),
      l(12, 10.6, 12, 5.4),
      p('M12 5.8h3.6l-1.3 1.7 1.3 1.7H12'),
    ],
  },
} as const satisfies Record<string, IconDefinition>;

export type IconName = keyof typeof ICONS;

export function getIcon(name: IconName): IconDefinition {
  return ICONS[name];
}

export function hasIcon(name: string): name is IconName {
  return name in ICONS;
}
