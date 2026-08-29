/**
 * 3D シーン上のマーカー画像（SVG データ URI）。
 *
 * Cesium のラベルに絵文字を入れると、環境ごとに字形・サイズ・余白が変わり
 * 見た目が破綻する。そのため、UI と同じ形状データ（@ijm/shared の ICONS）から
 * SVG を組み立て、ビルボード画像として使う。
 */

import type { IconName, IconPrimitive } from '@ijm/shared';
import { getIcon } from '@ijm/shared';

export interface MarkerStyle {
  /** 背景色 */
  background: string;
  /** 枠線色 */
  border: string;
  /** グリフの色 */
  glyph: string;
}

export const MARKER_STYLES = {
  poi: { background: '#12263ae6', border: '#3ddad7', glyph: '#eef4fb' },
  origin: { background: '#0b1622f2', border: '#3ddad7', glyph: '#3ddad7' },
  destination: { background: '#0b1622f2', border: '#ff6b6b', glyph: '#ff6b6b' },
  highlight: { background: '#0b1622f2', border: '#ffc255', glyph: '#ffc255' },
} as const satisfies Record<string, MarkerStyle>;

export type MarkerKind = keyof typeof MARKER_STYLES;

function primitiveToSvg(primitive: IconPrimitive, color: string): string {
  const stroke = `stroke="${color}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"`;
  switch (primitive.kind) {
    case 'path':
      return primitive.filled
        ? `<path d="${primitive.d}" fill="${color}"/>`
        : `<path d="${primitive.d}" fill="none" ${stroke}/>`;
    case 'circle':
      return primitive.filled
        ? `<circle cx="${primitive.cx}" cy="${primitive.cy}" r="${primitive.r}" fill="${color}"/>`
        : `<circle cx="${primitive.cx}" cy="${primitive.cy}" r="${primitive.r}" fill="none" ${stroke}/>`;
    case 'line':
      return `<line x1="${primitive.x1}" y1="${primitive.y1}" x2="${primitive.x2}" y2="${primitive.y2}" ${stroke}/>`;
    case 'rect':
      return primitive.filled
        ? `<rect x="${primitive.x}" y="${primitive.y}" width="${primitive.w}" height="${primitive.h}" rx="${primitive.rx ?? 2}" fill="${color}"/>`
        : `<rect x="${primitive.x}" y="${primitive.y}" width="${primitive.w}" height="${primitive.h}" rx="${primitive.rx ?? 2}" fill="none" ${stroke}/>`;
  }
}

function glyphSvg(name: IconName, color: string): string {
  return getIcon(name)
    .primitives.map((primitive) => primitiveToSvg(primitive, color))
    .join('');
}

function toDataUri(svg: string): string {
  // Cesium はデータ URI をそのまま画像として読み込める。
  // base64 ではなく encodeURIComponent の方が短く、日本語も含まないため安全。
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/**
 * 円形バッジ（POI 用）。
 * 高 DPI 端末でも滲まないよう、SVG のまま渡してブラウザにラスタライズさせる。
 */
export function badgeMarkerUri(name: IconName, kind: MarkerKind = 'poi', size = 44): string {
  const style = MARKER_STYLES[kind];
  const radius = size / 2 - 2;
  const glyphScale = (size * 0.56) / 24;
  const glyphOffset = (size - 24 * glyphScale) / 2;

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
    `<circle cx="${size / 2}" cy="${size / 2}" r="${radius}" fill="${style.background}" stroke="${style.border}" stroke-width="2"/>` +
    `<g transform="translate(${glyphOffset} ${glyphOffset}) scale(${glyphScale})">${glyphSvg(name, style.glyph)}</g>` +
    `</svg>`;

  return toDataUri(svg);
}

/**
 * ピン型マーカー（出発地・目的地・強調地点）。
 * 先端が地面を指すので、ビルボードの原点は下端に置くこと。
 */
export function pinMarkerUri(name: IconName, kind: MarkerKind, width = 44): string {
  const style = MARKER_STYLES[kind];
  const height = Math.round(width * 1.32);
  const headRadius = width / 2 - 2;
  const cx = width / 2;
  const cy = headRadius + 2;

  // 頭部の円と、下端へ伸びる三角形を組み合わせたティアドロップ
  const tail = `M${cx - headRadius * 0.62} ${cy + headRadius * 0.78} L${cx} ${height - 1} L${cx + headRadius * 0.62} ${cy + headRadius * 0.78} Z`;
  const glyphScale = (width * 0.5) / 24;
  const glyphX = cx - (24 * glyphScale) / 2;
  const glyphY = cy - (24 * glyphScale) / 2;

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `<path d="${tail}" fill="${style.border}"/>` +
    `<circle cx="${cx}" cy="${cy}" r="${headRadius}" fill="${style.background}" stroke="${style.border}" stroke-width="2.4"/>` +
    `<g transform="translate(${glyphX} ${glyphY}) scale(${glyphScale})">${glyphSvg(name, style.glyph)}</g>` +
    `</svg>`;

  return toDataUri(svg);
}

/** 生成済み URI のキャッシュ（同じアイコンを何度も文字列生成しない） */
const cache = new Map<string, string>();

export function markerUri(
  name: IconName,
  kind: MarkerKind = 'poi',
  shape: 'badge' | 'pin' = 'badge',
): string {
  const key = `${shape}:${kind}:${name}`;
  let uri = cache.get(key);
  if (!uri) {
    uri = shape === 'pin' ? pinMarkerUri(name, kind) : badgeMarkerUri(name, kind);
    cache.set(key, uri);
  }
  return uri;
}
