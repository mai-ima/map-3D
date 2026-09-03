/**
 * tileset.json の配信（クエリで条件を渡す入口）。
 *
 * 中身は `tileset-service.ts` にある。
 *
 * Cesium が読むのはパス形式の入口（`[...spec]/route.ts`）のほうで、
 * こちらは調査スクリプトや手元での確認のために残してある。
 * **Cesium からこの形で読ませてはいけない。**
 * Cesium は tileset.json の URL に付いているクエリを、その中の子 tileset.json や
 * タイル本体（b3dm）にもそのまま引き継ぐ。bbox はカメラが動くたびに変わるので、
 * 同じタイルが毎回ちがう URL になり、ブラウザにも CDN にも一切キャッシュが効かない。
 * 実際にそうなっていた（`docs/pitfalls.md` の「Cesium は tileset.json の
 * クエリを子へ引き継ぐ」を参照）。
 */

import { tilesetResponse } from './tileset-service';

export const runtime = 'nodejs';
export const maxDuration = 30;

export async function GET(request: Request) {
  const url = new URL(request.url);
  return tilesetResponse({
    city: url.searchParams.get('city'),
    // 旧クエリ（lod=near|far）との互換を保つ
    layer: url.searchParams.get('layer') ?? url.searchParams.get('lod'),
    model: url.searchParams.get('model'),
    bbox: url.searchParams.get('bbox'),
  });
}
