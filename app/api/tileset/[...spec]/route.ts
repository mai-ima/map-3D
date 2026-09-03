/**
 * tileset.json の配信（パスで条件を渡す入口）。
 *
 *   /api/tileset/{都市}/{レイヤ}/{建物モデル}/{bbox}/tileset.json
 *   例: /api/tileset/tokyo/near/textured/139.7395,35.6588,139.7948,35.7037/tileset.json
 *
 * **なぜクエリではなくパスなのか。**
 *
 * Cesium は tileset.json を読み込んだ URL のクエリを、その中の子 tileset.json や
 * タイル本体（b3dm）にもそのまま引き継ぐ（Resource が queryParameters を継承する）。
 * 条件をクエリで渡していたときは、配信元へこう飛んでいた:
 *
 *   https://assets.cms.plateau.reearth.io/.../13101_chiyoda-ku_.../tileset.json
 *     ?city=tokyo&layer=near&bbox=139.7395,35.6588,139.7948,35.7037&model=textured
 *
 * bbox はカメラが動くたびに変わる。つまり **同じタイルが毎回ちがう URL になり、
 * ブラウザにも CDN にも一切キャッシュが効かない。**
 * 街を往復するだけで、同じ建物を何度も取り直していた。
 *
 * パスに書けばクエリが無いので、引き継がれるものも無い。
 * 末尾を tileset.json にしてあるのは、拡張子から中身が分かるようにするため。
 */

import { tilesetResponse } from '../tileset-service';

export const runtime = 'nodejs';
export const maxDuration = 30;

export async function GET(_request: Request, context: { params: Promise<{ spec: string[] }> }) {
  const { spec } = await context.params;
  const [city, layer, model, bbox] = spec;
  return tilesetResponse({
    city: city ?? null,
    layer: layer ?? null,
    // 「都市の既定に任せる」を表す綴り。パスには空のセグメントを置けない
    model: model && model !== 'auto' ? model : null,
    bbox: bbox && bbox !== 'all' ? decodeURIComponent(bbox) : null,
  });
}
