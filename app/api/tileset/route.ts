import { NextResponse } from 'next/server';
import type { BBox } from '@ijm/shared';
import {
  bboxIntersects,
  getCity,
  isDirectTileset,
  lodFallbackChain,
  plateauDatasetId,
  plateauTilesetUrl,
  type PlateauTilesetSpec,
} from '@ijm/shared';

/**
 * 3D Tiles の tileset.json を「必要な範囲だけ」に絞って配信する。
 *
 * PLATEAU の配信 URL（例: 13-bldg-maxlod2-latest）が指す tileset.json は
 * 都道府県まるごとで、root の children に各市区町村の tileset.json が並んでいる。
 * refine は ADD なので、これをそのまま読み込ませると Cesium は視界に入る
 * 全市区町村の tileset を一斉に展開しにいく。東京都の LOD2 は 23 区分あり、
 * それぞれがさらに子タイルを持つため、開いた直後に数千リクエストと
 * 大量のメモリ確保が発生してタブごと落ちる。
 *
 * ここで bbox と交差する子だけを残してから返すことで、
 * 「起動時に広域データを読まない」という要件をそのまま満たせる。
 * 子の content.uri は絶対 URL のままなので、タイル本体は従来どおり
 * 配信元から直接ダウンロードされる（この API は tileset.json だけを扱う）。
 */

export const runtime = 'nodejs';
export const maxDuration = 30;

/** 3D Tiles の boundingVolume。region はラジアン、box/sphere は直交座標 */
interface BoundingVolume {
  region?: number[];
  box?: number[];
  sphere?: number[];
}

interface Tile {
  boundingVolume?: BoundingVolume;
  children?: Tile[];
  content?: { uri?: string };
  [key: string]: unknown;
}

interface Tileset {
  root?: Tile;
  [key: string]: unknown;
}

const RAD_TO_DEG = 180 / Math.PI;

/** region 形式の boundingVolume を経緯度の bbox に変換する（region 以外は判定不能） */
function regionToBBox(volume: BoundingVolume | undefined): BBox | null {
  const region = volume?.region;
  if (!region || region.length < 4) return null;
  const [west, south, east, north] = region;
  return [west * RAD_TO_DEG, south * RAD_TO_DEG, east * RAD_TO_DEG, north * RAD_TO_DEG];
}

function parseBBox(value: string | null): BBox | null {
  if (!value) return null;
  const parts = value.split(',').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
  const [minLng, minLat, maxLng, maxLat] = parts;
  if (minLng >= maxLng || minLat >= maxLat) return null;
  if (Math.abs(minLat) > 90 || Math.abs(maxLat) > 90) return null;
  if (Math.abs(minLng) > 180 || Math.abs(maxLng) > 180) return null;
  return [minLng, minLat, maxLng, maxLat];
}

/**
 * タイル内の相対 URI を、上流の tileset.json を基準に絶対 URL へ書き換える。
 *
 * この API は tileset.json を自分のオリジンから配信するため、中身の URI が
 * 相対のままだと `/api/data/xxx.b3dm` のように自分のオリジン基準で
 * 解決されてしまい、タイル本体が 404 になる。
 *
 * 東京都のように子が絶対 URL で書かれているデータセットもあれば、
 * 浜松市のように相対 URI（data/data239.b3dm）で書かれているものもある。
 */
function absolutizeUris(tile: Tile, baseUrl: string): Tile {
  const content = tile.content?.uri
    ? { ...tile.content, uri: new URL(tile.content.uri, baseUrl).toString() }
    : tile.content;

  const children = tile.children?.map((child) => absolutizeUris(child, baseUrl));

  return {
    ...tile,
    ...(content ? { content } : {}),
    ...(children ? { children } : {}),
  };
}

/** 2 つの範囲が重なる面積（度の 2 乗。大小の比較にだけ使う） */
function overlapArea(a: BBox, b: BBox): number {
  const width = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const height = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  return width > 0 && height > 0 ? width * height : 0;
}

/**
 * 一度に開く子タイルセットの数の上限。
 *
 * 東京都心の実測（2026-08, 東京駅の周辺 3km を要求）:
 *
 *   千代田区 17.4km²(95%) 中央区 16.4km²(84%) 江東区 15.7km² 港区 13.9km²
 *   台東区    5.0km²(29%) 新宿区  4.2km²(10%) 文京区  3.3km² 墨田区  2.4km²(8%)
 *
 * 交差するかどうかだけで選ぶと、端がかすっているだけの 4 区まで開いてしまう。
 * その 4 区が総タイル数のおよそ半分（1,781 / 3,555）を占めていた。
 * 区の tileset.json だけでも 8 区で 4.3MB あり、開いた時点で
 * その中のタイルが読み込み対象になる。
 *
 * 重なりの大きい順に選べば、実際に見えている範囲を落とさずに済む。
 * カメラが移動すれば読み直されるので、進んだ先の区はその時に開かれる。
 */
const MAX_CHILDREN: Record<'near' | 'far', number> = { near: 5, far: 10 };

/**
 * bbox と重ならない子を落とし、重なりの大きい順に上限まで残す。
 * boundingVolume が region でない子は判定できないので、安全側に倒して残す。
 */
function filterChildren(
  root: Tile,
  bbox: BBox,
  limit: number,
): { root: Tile; kept: number; total: number } {
  const children = root.children ?? [];
  if (children.length === 0) return { root, kept: 0, total: 0 };

  const scored: { child: Tile; area: number }[] = [];
  for (const child of children) {
    const childBBox = regionToBBox(child.boundingVolume);
    // 判定できない子は、重なりが最大だったことにして必ず残す
    if (childBBox === null) {
      scored.push({ child, area: Number.POSITIVE_INFINITY });
      continue;
    }
    if (!bboxIntersects(childBBox, bbox)) continue;
    scored.push({ child, area: overlapArea(childBBox, bbox) });
  }

  scored.sort((a, b) => b.area - a.area);
  const kept = scored.slice(0, limit).map((s) => s.child);

  return {
    root: { ...root, children: kept },
    kept: kept.length,
    total: children.length,
  };
}

async function fetchTileset(spec: PlateauTilesetSpec): Promise<Tileset | null> {
  const upstream = plateauTilesetUrl(spec);
  const res = await fetch(upstream, {
    headers: { Accept: 'application/json' },
    // 上流の更新頻度は日次程度なので、エッジで長めに保持してよい
    next: { revalidate: 3600 },
  });
  if (!res.ok) return null;
  const tileset = (await res.json()) as Tileset;
  if (!tileset.root) return null;
  // タイル本体は配信元から直接取得させる（この API が扱うのは tileset.json だけ）
  return { ...tileset, root: absolutizeUris(tileset.root, upstream) };
}

/**
 * 指定 LOD から順に下位へ落としつつ、bbox に中身が残るものを探す。
 *
 * LOD3・LOD4 は整備範囲が狭く、未整備の地域では HTTP 200 のまま
 * children が 0 件の tileset が返る。「取得できた」だけでは判断できないので、
 * bbox で絞ったあとに実際に子が残るかどうかで採否を決める。
 */
async function resolveTileset(
  spec: PlateauTilesetSpec,
  bbox: BBox,
  minLevel = 1,
  childLimit = MAX_CHILDREN.near,
): Promise<{ tileset: Tileset; root: Tile; spec: PlateauTilesetSpec; kept: number; total: number } | null> {
  for (const candidate of lodFallbackChain(spec, minLevel)) {
    const tileset = await fetchTileset(candidate);
    if (!tileset?.root) continue;

    // URL 直接指定のデータセットは既に単一の区に絞られている。
    // その children は地理的な四分木なので、絞り込むと穴が開いてしまう。
    if (isDirectTileset(candidate)) {
      const total = tileset.root.children?.length ?? 0;
      return { tileset, root: tileset.root, spec: candidate, kept: total, total };
    }

    const { root, kept, total } = filterChildren(tileset.root, bbox, childLimit);
    if (kept > 0) return { tileset, root, spec: candidate, kept, total };
  }
  return null;
}

/** layer 名から対象のデータ指定を引く */
function resolveSpec(
  city: NonNullable<ReturnType<typeof getCity>>,
  layer: string,
): PlateauTilesetSpec | undefined {
  switch (layer) {
    case 'near':
      return city.near;
    case 'far':
      return city.far;
    case 'detail':
      return city.detail;
    default:
      return city.overlays?.find((o) => o.id === layer)?.spec;
  }
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const cityId = url.searchParams.get('city');
  // 旧クエリ（lod=near|far）との互換を保つ
  const layer = url.searchParams.get('layer') ?? url.searchParams.get('lod') ?? 'near';

  const city = cityId ? getCity(cityId) : undefined;
  if (!city) {
    return NextResponse.json({ error: '都市が見つかりません' }, { status: 404 });
  }

  const spec = resolveSpec(city, layer);
  if (!spec) {
    return NextResponse.json(
      { error: `この都市には ${layer} レイヤがありません` },
      { status: 404 },
    );
  }

  // 明示指定が無ければ都市の bbox を使う
  const bbox = parseBBox(url.searchParams.get('bbox')) ?? city.bbox;

  try {
    // 詳細レイヤはベース（LOD2）に重ねるものなので、LOD3 未満には落とさない。
    // 落とすとベースと同じデータを二重に読み込むことになる。
    const minLevel = layer === 'detail' ? 3 : 1;
    // 遠景は 1 枚が軽い LOD1 なので、広い範囲を担わせてよい
    const childLimit = layer === 'far' ? MAX_CHILDREN.far : MAX_CHILDREN.near;
    const resolved = await resolveTileset(spec, bbox, minLevel, childLimit);
    if (!resolved) {
      // この範囲に該当データが無い。呼び出し側は「重ねない」判断ができればよい
      return NextResponse.json(
        { error: 'この範囲には該当する 3D データがありません', layer },
        { status: 404 },
      );
    }

    return NextResponse.json(
      { ...resolved.tileset, root: resolved.root },
      {
        headers: {
          'Cache-Control': 'public, max-age=600, s-maxage=86400, stale-while-revalidate=86400',
          // 何件に絞ったか・どの LOD が採用されたかを確認できるようにしておく
          'X-Tileset-Children': `${resolved.kept}/${resolved.total}`,
          'X-Tileset-Dataset': resolved.spec.url
            ? resolved.spec.url.split('/').slice(-2, -1)[0]
            : plateauDatasetId(resolved.spec),
          'X-Tileset-Lod': resolved.spec.lod,
        },
      },
    );
  } catch (error) {
    return NextResponse.json(
      { error: (error as Error).message ?? '3D データを取得できませんでした' },
      { status: 502 },
    );
  }
}
