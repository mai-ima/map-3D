/**
 * アイコン一覧のプレビューを生成する。
 *
 *   npm run preview:icons
 *   → data/icon-preview.html をブラウザで開く
 *
 * 本アプリは絵文字を使わず、すべて SVG アイコンで表現している。
 * 形状は packages/shared/src/icons.ts に一元化されており、UI（React）と
 * 3D シーンのマーカー（Cesium のビルボード）が同じ絵柄になる。
 * アイコンを追加・修正したら、このプレビューで実寸の見えかたを確認すること。
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ICONS, type IconName, type IconPrimitive } from '@ijm/shared';
import { badgeMarkerUri, pinMarkerUri } from '@ijm/map-engine/marker-icons';

const OUT = path.resolve(import.meta.dirname, '..', '..', 'data', 'icon-preview.html');

function primitiveToSvg(primitive: IconPrimitive): string {
  const stroke = 'stroke="currentColor" fill="none"';
  const fill = 'fill="currentColor"';
  switch (primitive.kind) {
    case 'path':
      return `<path d="${primitive.d}" ${primitive.filled ? fill : stroke}/>`;
    case 'circle':
      return `<circle cx="${primitive.cx}" cy="${primitive.cy}" r="${primitive.r}" ${primitive.filled ? fill : stroke}/>`;
    case 'line':
      return `<line x1="${primitive.x1}" y1="${primitive.y1}" x2="${primitive.x2}" y2="${primitive.y2}" stroke="currentColor"/>`;
    case 'rect':
      return `<rect x="${primitive.x}" y="${primitive.y}" width="${primitive.w}" height="${primitive.h}" rx="${primitive.rx ?? 2}" ${primitive.filled ? fill : stroke}/>`;
  }
}

function iconSvg(name: IconName, size: number): string {
  const body = ICONS[name].primitives.map(primitiveToSvg).join('');
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
}

function cell(inner: string, label: string): string {
  return `<div class="cell">${inner}<span>${label}</span></div>`;
}

const names = Object.keys(ICONS) as IconName[];

const uiCells = names.map((n) => cell(iconSvg(n, 30), n)).join('');
const zoomCells = names.map((n) => cell(iconSvg(n, 72), n)).join('');

const poiNames: IconName[] = [
  'store',
  'cafe',
  'restaurant',
  'transit',
  'park',
  'hospital',
  'parking',
  'hotel',
  'atm',
  'shop',
  'toilets',
  'school',
];
const badgeCells = poiNames
  .map((n) => cell(`<img src="${badgeMarkerUri(n)}" width="44" height="44" alt="">`, n))
  .join('');

const pinCells = ([
  ['origin', 'origin'],
  ['destination', 'destination'],
  ['pin', 'highlight'],
] as const)
  .map(([icon, kind]) =>
    cell(`<img src="${pinMarkerUri(icon, kind)}" width="44" height="58" alt="">`, kind),
  )
  .join('');

const html = `<!doctype html>
<meta charset="utf-8">
<title>Immersive Japan Map — アイコン一覧</title>
<style>
  body { margin: 0; background: #0a1017; color: #eef4fb; font: 13px/1.5 system-ui, sans-serif; padding: 28px; }
  h1 { font-size: 16px; margin: 0 0 4px; }
  p.lead { color: #7e91a8; font-size: 12px; margin: 0 0 20px; }
  h2 { font-size: 13px; color: #3ddad7; margin: 26px 0 12px; }
  .grid { display: flex; flex-wrap: wrap; gap: 14px; }
  .cell { width: 104px; display: flex; flex-direction: column; align-items: center; justify-content: flex-end;
          gap: 8px; padding: 12px; border: 1px solid #ffffff18; border-radius: 12px; background: #111a25; }
  .cell span { font-size: 10px; color: #7e91a8; text-align: center; word-break: break-all; }
  .zoom .cell { width: 132px; }
</style>
<h1>アイコン一覧（${names.length} 種）</h1>
<p class="lead">絵文字は使用しない。形状は packages/shared/src/icons.ts に一元化され、UI と 3D マーカーで共有される。</p>
<h2>UI サイズ（30px）</h2><div class="grid">${uiCells}</div>
<h2>拡大（72px）</h2><div class="grid zoom">${zoomCells}</div>
<h2>3D POI バッジ（Cesium ビルボード）</h2><div class="grid">${badgeCells}</div>
<h2>3D ピン（出発地 / 目的地 / 強調）</h2><div class="grid">${pinCells}</div>
`;

await mkdir(path.dirname(OUT), { recursive: true });
await writeFile(OUT, html, 'utf8');
console.log(`[preview-icons] ${names.length} 種のアイコンを出力しました: ${path.relative(process.cwd(), OUT)}`);
