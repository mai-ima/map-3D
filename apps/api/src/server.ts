/**
 * セルフホスト用のスタンドアロン API サーバ。
 *
 * Vercel では apps/web の Route Handlers が同じ処理を担う。
 * こちらは Docker Compose 構成（自前 Valhalla / PostGIS / Overpass）で使う。
 * ロジックは packages/* を共有しており、実装の二重管理をしていない。
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import {
  BASE_ATTRIBUTION_IDS,
  CITIES,
  DEFAULT_CITY_ID,
  PLATEAU_TERRAIN_URL,
  attributionStrings,
  cityTilesetUrls,
  resolveAttributions,
  type LatLng,
  type TravelMode,
} from '@ijm/shared';
import {
  GSI_IMAGERY,
  OverpassUnavailableError,
  fetchStreetFurniture,
  geocode,
  getBuildingInfo,
  searchNearbyPois,
} from '@ijm/gis';
import { RoutingError, routeWithFallback } from '@ijm/routing';
import {
  createAIProvider,
  isAIConfigured,
  runMapAgent,
  type ChatMessage,
  type MapContext,
} from '@ijm/ai';

const PORT = Number(process.env.PORT ?? 8787);
const CORS_ORIGIN = process.env.CORS_ORIGIN ?? '*';

interface JsonResponse {
  status: number;
  body: unknown;
}

function json(status: number, body: unknown): JsonResponse {
  return { status, body };
}

function parsePoint(value: string | null): LatLng | null {
  if (!value) return null;
  const [lat, lng] = value.split(',').map(Number);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return { lat, lng };
}

async function readBody<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {} as T;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
  } catch {
    return {} as T;
  }
}

async function handle(req: IncomingMessage, url: URL): Promise<JsonResponse> {
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (path === '/health') {
    return json(200, { ok: true, routing: process.env.VALHALLA_URL ?? 'public-demo' });
  }

  if (path === '/api/config') {
    return json(200, {
      defaultCityId: DEFAULT_CITY_ID,
      cities: CITIES.map((city) => {
        const urls = cityTilesetUrls(city);
        return {
          id: city.id,
          name: city.name,
          nameEn: city.nameEn,
          center: city.center,
          bbox: city.bbox,
          buildingTilesetUrl: urls.near,
          farBuildingTilesetUrl: urls.far,
          initialHeight: city.initialHeight,
        };
      }),
      imagery: GSI_IMAGERY.map((i) => ({
        id: i.id,
        label: i.label,
        urlTemplate: i.urlTemplate,
        attribution: i.attribution,
      })),
      terrainUrl: process.env.PLATEAU_TERRAIN_URL ?? PLATEAU_TERRAIN_URL,
      features: { routing: true, poi: true, ai: isAIConfigured(), weather: true },
      attributions: resolveAttributions([...BASE_ATTRIBUTION_IDS, 'valhalla', 'nominatim', 'overpass']),
    });
  }

  if (path === '/api/route') {
    const from =
      req.method === 'GET' ? parsePoint(url.searchParams.get('from')) : null;
    const to = req.method === 'GET' ? parsePoint(url.searchParams.get('to')) : null;
    const body =
      req.method === 'POST'
        ? await readBody<{ from?: LatLng; to?: LatLng; mode?: TravelMode }>(req)
        : {};

    const origin = from ?? body.from;
    const destination = to ?? body.to;
    const mode = ((url.searchParams.get('mode') ?? body.mode) ?? 'walk') as TravelMode;

    if (!origin || !destination) {
      return json(400, { error: 'from と to が必要です' });
    }

    try {
      const route = await routeWithFallback({ from: origin, to: destination, mode, language: 'ja-JP' });
      return json(200, route);
    } catch (error) {
      const status = error instanceof RoutingError ? error.status : 502;
      return json(status, { error: (error as Error).message });
    }
  }

  if (path === '/api/search') {
    const query = url.searchParams.get('q');
    if (!query) return json(400, { error: '検索語 (q) を指定してください' });
    const near = parsePoint(url.searchParams.get('near')) ?? undefined;
    try {
      const results = await geocode(query, { near, limit: 8 });
      return json(200, { results, attribution: attributionStrings(['nominatim', 'osm']) });
    } catch (error) {
      return json(502, { error: (error as Error).message });
    }
  }

  if (path === '/api/poi') {
    const center = parsePoint(
      `${url.searchParams.get('lat')},${url.searchParams.get('lng')}`,
    );
    if (!center) return json(400, { error: 'lat と lng が必要です' });
    const radius = Math.min(Number(url.searchParams.get('radius') ?? 500), 3000);
    const categories = (url.searchParams.get('categories') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    try {
      const pois = await searchNearbyPois({ center, radius, categories, limit: 30 });
      return json(200, { pois, attribution: attributionStrings(['overpass', 'osm']) });
    } catch (error) {
      if (error instanceof OverpassUnavailableError) {
        return json(200, { pois: [], degraded: true, message: error.message });
      }
      return json(502, { error: (error as Error).message });
    }
  }

  if (path === '/api/building' && req.method === 'POST') {
    const body = await readBody<{ lat?: number; lng?: number }>(req);
    if (!Number.isFinite(body.lat) || !Number.isFinite(body.lng)) {
      return json(400, { error: 'lat と lng が必要です' });
    }
    const info = await getBuildingInfo({ lat: body.lat!, lng: body.lng! });
    return json(200, { building: info, attribution: attributionStrings(['osm', 'plateau']) });
  }

  if (path === '/api/furniture') {
    const raw = url.searchParams.get('bbox');
    const parts = raw?.split(',').map(Number) ?? [];
    if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
      return json(400, { error: 'bbox=minLng,minLat,maxLng,maxLat が必要です' });
    }
    try {
      const elements = await fetchStreetFurniture(parts as [number, number, number, number]);
      const points = elements
        .filter((e) => typeof e.lat === 'number' && typeof e.lon === 'number')
        .map((e) => ({
          lat: e.lat!,
          lng: e.lon!,
          kind:
            e.tags?.natural === 'tree'
              ? 'tree'
              : e.tags?.highway === 'street_lamp'
                ? 'street_lamp'
                : 'bench',
        }));
      return json(200, { points, attribution: attributionStrings(['overpass', 'osm']) });
    } catch (error) {
      if (error instanceof OverpassUnavailableError) {
        return json(200, { points: [], degraded: true, message: error.message });
      }
      return json(502, { error: (error as Error).message });
    }
  }

  if (path === '/api/ai/chat' && req.method === 'POST') {
    if (!isAIConfigured()) {
      return json(503, { error: 'AI 機能が未設定です', configured: false });
    }
    const body = await readBody<{ messages?: ChatMessage[]; mapContext?: MapContext }>(req);
    const messages = (body.messages ?? []).filter((m) => m.role === 'user' || m.role === 'assistant');
    if (messages.length === 0) return json(400, { error: 'messages が空です' });

    try {
      const result = await runMapAgent({
        provider: createAIProvider(),
        messages: messages.slice(-12),
        mapContext: body.mapContext ?? {},
      });
      return json(200, result);
    } catch (error) {
      return json(502, { error: (error as Error).message });
    }
  }

  return json(404, { error: 'Not Found' });
}

const server = createServer((req, res: ServerResponse) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');

  if (req.method === 'OPTIONS') {
    res.writeHead(204).end();
    return;
  }

  handle(req, url)
    .then(({ status, body }) => {
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(body));
    })
    .catch((error: Error) => {
      console.error('[api] 予期しないエラー', error);
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'サーバ内部エラー' }));
    });
});

server.listen(PORT, () => {
  console.log(`[api] http://localhost:${PORT} で待機中`);
});
