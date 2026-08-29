import { NextResponse } from 'next/server';
import type { BBox } from '@ijm/shared';
import {
  bboxIntersects,
  getCity,
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
 * bbox と交差しない子を落とす。
 * boundingVolume が region でない子は判定できないので、安全側に倒して残す。
 */
function filterChildren(root: Tile, bbox: BBox): { root: Tile; kept: number; total: number } {
  const children = root.children ?? [];
  if (children.length === 0) return { root, kept: 0, total: 0 };

  const kept = children.filter((child) => {
    const childBBox = regionToBBox(child.boundingVolume);
    return childBBox === null ? true : bboxIntersects(childBBox, bbox);
  });

  return {
    root: { ...root, children: kept },
    kept: kept.length,
    total: children.length,
  };
}

async function fetchTileset(spec: PlateauTilesetSpec): Promise<Tileset | null> {
  const res = await fetch(plateauTilesetUrl(spec), {
    headers: { Accept: 'application/json' },
    // 上流の更新頻度は日次程度なので、エッジで長めに保持してよい
    next: { revalidate: 3600 },
  });
  if (!res.ok) return null;
  const tileset = (await res.json()) as Tileset;
  return tileset.root ? tileset : null;
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
): Promise<{ tileset: Tileset; root: Tile; spec: PlateauTilesetSpec; kept: number; total: number } | null> {
  for (const candidate of lodFallbackChain(spec, minLevel)) {
    const tileset = await fetchTileset(candidate);
    if (!tileset?.root) continue;
    const { root, kept, total } = filterChildren(tileset.root, bbox);
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
    const resolved = await resolveTileset(spec, bbox, minLevel);
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
          'X-Tileset-Dataset': plateauDatasetId(resolved.spec),
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
