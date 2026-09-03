/**
 * OpenStreetMap 本体の API（api.openstreetmap.org）から範囲内の生データを取る。
 *
 * Overpass の公開インスタンスは可用性が読めず、混雑時は 503 や
 * 接続断が続くことがある。実際に浜松市中区で POI が取得できない事象が起きた。
 *
 * OSM 本体の API は Overpass のような絞り込みができない代わりに、
 * 「範囲内の全要素」を確実に返す。取得後にこちら側でタグを絞れば、
 * Overpass が全滅していても POI や構造物を出せる。
 *
 * 制約:
 *   - bbox は 0.25 度四方まで（それを超えると 400 が返る）
 *   - 要素数が 50,000 を超えると 509 が返る
 *   - 全要素が返るので転送量は大きい（浜松駅周辺 1.2km 四方で約 8.7MB）
 * このため「Overpass が使えないときの最後の手段」として使う。
 */

import type { BBox } from '@ijm/shared';
import { fetchWithTimeout, getGisConfig, remainingMs } from './config';
import type { OverpassElement } from './overpass';

const OSM_API = 'https://api.openstreetmap.org/api/0.6/map';
/** API 側の上限。これを超える範囲は投げる前に弾く */
const MAX_SPAN_DEG = 0.25;

/** XML から要素を取り出す。DOM が無い環境（Node）でも動くよう手書きで走査する */
export function parseOsmXml(xml: string): OverpassElement[] {
  const elements: OverpassElement[] = [];
  const nodePos = new Map<number, { lat: number; lon: number }>();

  /**
   * node は 2 つの形で現れる。
   *
   *   タグ無し  <node id=".." lat=".." lon=".." />
   *   タグ付き  <node id=".." ...>\n  <tag k=".." v=".."/>\n </node>
   *
   * 以前は「次の要素が始まるところまで」を先読みで探していたが、
   * 実際の XML は </node> と次の <node> の間に改行と字下げが入るため
   * 先読みが一度も成立せず、ノードを 1 件も取り出せていなかった。
   * 信号・横断歩道・街路樹はすべてノードなので、これらが丸ごと落ちていた。
   * 閉じタグそのものを終端にすれば、間に何が入っていても取り出せる。
   */
  const nodeRe = /<node\b([^>]*?)(?:\/>|>([\s\S]*?)<\/node>)/g;
  const attrRe = /(\w+(?::\w+)*)="([^"]*)"/g;
  const tagRe = /<tag\s+k="([^"]*)"\s+v="([^"]*)"\s*\/>/g;

  const readAttrs = (s: string): Record<string, string> => {
    const out: Record<string, string> = {};
    attrRe.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = attrRe.exec(s))) out[m[1]] = m[2];
    return out;
  };

  const readTags = (s: string): Record<string, string> => {
    const out: Record<string, string> = {};
    tagRe.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = tagRe.exec(s))) out[m[1]] = m[2];
    return out;
  };

  let m: RegExpExecArray | null;
  while ((m = nodeRe.exec(xml))) {
    const attrs = readAttrs(m[1]);
    const id = Number(attrs.id);
    const lat = Number(attrs.lat);
    const lon = Number(attrs.lon);
    if (!Number.isFinite(id) || !Number.isFinite(lat)) continue;
    nodePos.set(id, { lat, lon });
    const tags = m[2] ? readTags(m[2]) : {};
    if (Object.keys(tags).length > 0) {
      elements.push({ type: 'node', id, lat, lon, tags });
    }
  }

  // way は参照している node の座標を geometry として埋める
  const wayRe = /<way\b([^>]*?)>([\s\S]*?)<\/way>/g;
  const ndRe = /<nd\s+ref="(\d+)"\s*\/>/g;
  while ((m = wayRe.exec(xml))) {
    const attrs = readAttrs(m[1]);
    const id = Number(attrs.id);
    if (!Number.isFinite(id)) continue;
    const body = m[2];
    const tags = readTags(body);
    if (Object.keys(tags).length === 0) continue;

    const geometry: { lat: number; lon: number }[] = [];
    ndRe.lastIndex = 0;
    let n: RegExpExecArray | null;
    while ((n = ndRe.exec(body))) {
      const p = nodePos.get(Number(n[1]));
      if (p) geometry.push(p);
    }
    if (geometry.length === 0) continue;

    const center = {
      lat: geometry.reduce((s, p) => s + p.lat, 0) / geometry.length,
      lon: geometry.reduce((s, p) => s + p.lon, 0) / geometry.length,
    };
    elements.push({ type: 'way', id, tags, geometry, center });
  }

  return elements;
}

export class OsmApiUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OsmApiUnavailableError';
  }
}

/**
 * 分割して取り直す深さの上限。
 *
 * 1 段で 4 分割、2 段で 16 分割。市街地の 3km 四方は 1 段で足りる。
 * 際限なく割ると、公開 API に大量の要求を投げることになる。
 */
const MAX_SPLIT_DEPTH = 2;

/** OSM API が「1 回で返せるノード数の上限」を理由に断ったか */
function isTooManyNodes(status: number, body: string): boolean {
  return status === 400 && /too many nodes/i.test(body);
}

/** bbox を 4 つに割る */
function quarters(bbox: BBox): BBox[] {
  const [minLng, minLat, maxLng, maxLat] = bbox;
  const midLng = (minLng + maxLng) / 2;
  const midLat = (minLat + maxLat) / 2;
  return [
    [minLng, minLat, midLng, midLat],
    [midLng, minLat, maxLng, midLat],
    [minLng, midLat, midLng, maxLat],
    [midLng, midLat, maxLng, maxLat],
  ];
}

/**
 * 範囲内の全要素を取得する。
 * タグを持つ node と way だけを返す（タグの無い形状点は使わない）。
 *
 * OSM 本体の API は **1 回の応答が 50,000 ノードを超えると 400 を返す。**
 * 市街地では 3km 四方でこの上限に当たる（実測: 浜松駅周辺で
 * 「You requested too many nodes (limit is 50000)」）。
 * Overpass が混んでいるときの切り替え先がここなので、
 * 断られたら範囲を 4 つに割って取り直す。割らないと、
 * 切り替え先があるのに何も出ないまま終わる。
 */
export async function fetchOsmMap(
  bbox: BBox,
  /** この時刻（Date.now() 基準）までに諦める。Overpass と合計の時間を共有する */
  deadline?: number,
  depth = 0,
): Promise<OverpassElement[]> {
  const [minLng, minLat, maxLng, maxLat] = bbox;
  if (maxLng - minLng > MAX_SPAN_DEG || maxLat - minLat > MAX_SPAN_DEG) {
    throw new OsmApiUnavailableError(
      `範囲が広すぎます（OSM API の上限は ${MAX_SPAN_DEG} 度四方）`,
    );
  }

  const cfg = getGisConfig();
  const remaining = remainingMs(deadline, cfg.timeoutMs);
  if (remaining < 1000) {
    throw new OsmApiUnavailableError('取得にかけられる時間を使い切りました');
  }

  const url = `${OSM_API}?bbox=${minLng},${minLat},${maxLng},${maxLat}`;
  const res = await fetchWithTimeout(url, {
    headers: { 'User-Agent': cfg.userAgent, Accept: 'application/xml' },
    timeoutMs: Math.min(cfg.timeoutMs, remaining),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    if (isTooManyNodes(res.status, body) && depth < MAX_SPLIT_DEPTH) {
      return fetchOsmMapSplit(bbox, deadline, depth);
    }
    throw new OsmApiUnavailableError(`OSM API から取得できませんでした (HTTP ${res.status})`);
  }
  return parseOsmXml(await res.text());
}

/**
 * 4 つに割って取り直し、結果をつなぐ。
 *
 * 境界にまたがる way は複数の区画に現れるので、id で重複を落とす。
 * 一部が失敗しても、取れたものは返す（切り替え先なので全部揃わなくてよい）。
 */
async function fetchOsmMapSplit(
  bbox: BBox,
  deadline: number | undefined,
  depth: number,
): Promise<OverpassElement[]> {
  const parts = await Promise.all(
    quarters(bbox).map((part) =>
      fetchOsmMap(part, deadline, depth + 1).catch(() => [] as OverpassElement[]),
    ),
  );

  const seen = new Set<string>();
  const merged: OverpassElement[] = [];
  for (const part of parts) {
    for (const el of part) {
      const key = `${el.type}/${el.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(el);
    }
  }
  if (merged.length === 0) {
    throw new OsmApiUnavailableError('OSM API から取得できませんでした（分割しても空）');
  }
  return merged;
}
