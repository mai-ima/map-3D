/**
 * ツール実行器。
 *
 * LLM が返したツール呼び出しを、実際の GIS / ルーティング処理に接続する。
 * 「LLM が座標を捏造する」ことを防ぐため、場所は必ず geocode を通し、
 * 生成された UI コマンドの座標はツール実行で得られた実データのみを使う。
 */

import type { LatLng, Route, TravelMode } from '@ijm/shared';
import { distanceMeters } from '@ijm/shared';
import { getBuildingInfo, geocode, searchNearbyPois } from '@ijm/gis';
import { routeWithFallback } from '@ijm/routing';
import type { MapContext, ToolCall, UICommand } from './types';

export interface ToolExecutionContext {
  mapContext: MapContext;
  /** 直近に計算されたルート（start_navigation 用） */
  lastRoute: Route | null;
  uiCommands: UICommand[];
  attribution: Set<string>;
  /** ツール実行で実際に得られた座標。UI コマンドはここにある座標しか使えない。 */
  knownPoints: { name: string; point: LatLng }[];
}

export interface ToolExecutionResult {
  ok: boolean;
  /** LLM に返す文字列（JSON 文字列） */
  content: string;
  error?: string;
}

/** 日本の概ねの範囲。範囲外の座標はツール由来でないとみなす。 */
const JAPAN_BBOX = { minLng: 122, minLat: 20, maxLng: 154, maxLat: 46 };

function inJapan(p: LatLng): boolean {
  return (
    p.lng >= JAPAN_BBOX.minLng &&
    p.lng <= JAPAN_BBOX.maxLng &&
    p.lat >= JAPAN_BBOX.minLat &&
    p.lat <= JAPAN_BBOX.maxLat
  );
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function num(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/** 場所名を座標に解決する。解決できたものだけを knownPoints に記録する。 */
async function resolvePlace(
  ctx: ToolExecutionContext,
  place: string | undefined,
): Promise<{ point: LatLng; name: string } | null> {
  if (!place || place === 'current' || place === '現在地' || place === 'ここ') {
    const fallback = ctx.mapContext.viewCenter ?? ctx.mapContext.camera?.center;
    if (!fallback) return null;
    const resolved = { point: fallback, name: '現在の地図の中心' };
    ctx.knownPoints.push(resolved);
    return resolved;
  }

  const results = await geocode(place, {
    limit: 1,
    near: ctx.mapContext.viewCenter ?? ctx.mapContext.camera?.center,
  });
  ctx.attribution.add('nominatim');
  if (results.length === 0) return null;

  const top = results[0];
  const resolved = { point: { lat: top.lat, lng: top.lng }, name: top.name };
  ctx.knownPoints.push(resolved);
  return resolved;
}

/** UI コマンドに載せてよい座標か（ツール由来か）を検証する */
function isKnownPoint(ctx: ToolExecutionContext, p: LatLng): boolean {
  if (!inJapan(p)) return false;
  return ctx.knownPoints.some((k) => distanceMeters(k.point, p) < 300);
}

export async function executeTool(
  call: ToolCall,
  ctx: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  try {
    switch (call.name) {
      case 'search_place': {
        const query = str(call.arguments.query);
        if (!query) return { ok: false, content: '', error: 'query が指定されていません' };
        const results = await geocode(query, {
          limit: 5,
          near: ctx.mapContext.viewCenter ?? ctx.mapContext.camera?.center,
        });
        ctx.attribution.add('nominatim');
        for (const r of results) {
          ctx.knownPoints.push({ name: r.name, point: { lat: r.lat, lng: r.lng } });
        }
        if (results.length > 0) {
          ctx.uiCommands.push({ type: 'showSearchResults', payload: { results } });
        }
        return {
          ok: true,
          content: JSON.stringify({
            results: results.map((r) => ({
              name: r.name,
              address: r.address,
              lat: r.lat,
              lng: r.lng,
            })),
          }),
        };
      }

      case 'search_nearby': {
        const category = str(call.arguments.category) ?? 'convenience';
        const center = await resolvePlace(ctx, str(call.arguments.place));
        if (!center) {
          return { ok: false, content: '', error: '基準となる場所を特定できませんでした' };
        }
        const radius = Math.min(num(call.arguments.radius) ?? 500, 3000);
        const limit = Math.min(num(call.arguments.limit) ?? 10, 30);

        const pois = await searchNearbyPois({
          center: center.point,
          radius,
          categories: [category],
          limit,
        });
        ctx.attribution.add('overpass');
        for (const p of pois) {
          ctx.knownPoints.push({ name: p.name, point: { lat: p.lat, lng: p.lng } });
        }
        if (pois.length > 0) {
          ctx.uiCommands.push({ type: 'showPois', payload: { pois } });
        }
        return {
          ok: true,
          content: JSON.stringify({
            center: center.name,
            count: pois.length,
            pois: pois.map((p) => ({ name: p.name, category: p.category, distance: p.distance })),
          }),
        };
      }

      case 'calculate_route': {
        const fromName = str(call.arguments.from);
        const toName = str(call.arguments.to);
        if (!toName) return { ok: false, content: '', error: '目的地が指定されていません' };

        const from = await resolvePlace(ctx, fromName);
        const to = await resolvePlace(ctx, toName);
        if (!from) return { ok: false, content: '', error: `出発地「${fromName}」が見つかりません` };
        if (!to) return { ok: false, content: '', error: `目的地「${toName}」が見つかりません` };

        const mode = (str(call.arguments.mode) ?? 'walk') as TravelMode;
        const route = await routeWithFallback({ from: from.point, to: to.point, mode });
        ctx.attribution.add('osm');
        ctx.attribution.add(route.engine === 'osrm' ? 'osrm' : 'valhalla');
        ctx.lastRoute = route;
        ctx.uiCommands.push({ type: 'showRoute', payload: { route } });

        return {
          ok: true,
          content: JSON.stringify({
            from: from.name,
            to: to.name,
            mode,
            distanceMeters: route.distance,
            durationSeconds: route.duration,
            maneuverCount: route.maneuvers.length,
            firstInstructions: route.maneuvers.slice(0, 3).map((m) => m.instruction),
          }),
        };
      }

      case 'get_building_info': {
        const place = await resolvePlace(ctx, str(call.arguments.place));
        if (!place) return { ok: false, content: '', error: '場所を特定できませんでした' };
        const info = await getBuildingInfo(place.point);
        ctx.attribution.add('osm');
        ctx.uiCommands.push({
          type: 'showBuildingInfo',
          payload: { position: { lat: info.lat, lng: info.lng } },
        });
        return {
          ok: true,
          content: JSON.stringify({
            name: info.name ?? null,
            buildingType: info.buildingType ?? null,
            height: info.height ?? null,
            levels: info.levels ?? null,
            address: info.address ?? null,
            sources: info.sources,
          }),
        };
      }

      case 'get_map_context': {
        return { ok: true, content: JSON.stringify(ctx.mapContext) };
      }

      case 'set_camera': {
        const place = await resolvePlace(ctx, str(call.arguments.place));
        if (!place) return { ok: false, content: '', error: '移動先を特定できませんでした' };
        if (!isKnownPoint(ctx, place.point)) {
          return { ok: false, content: '', error: '座標を検証できませんでした' };
        }
        ctx.uiCommands.push({
          type: 'setCamera',
          payload: {
            position: place.point,
            height: num(call.arguments.height),
            heading: num(call.arguments.heading),
            pitch: num(call.arguments.pitch),
          },
        });
        return { ok: true, content: JSON.stringify({ movedTo: place.name }) };
      }

      case 'highlight_location': {
        const place = await resolvePlace(ctx, str(call.arguments.place));
        if (!place) return { ok: false, content: '', error: '場所を特定できませんでした' };
        if (!isKnownPoint(ctx, place.point)) {
          return { ok: false, content: '', error: '座標を検証できませんでした' };
        }
        ctx.uiCommands.push({
          type: 'highlightLocation',
          payload: { position: place.point, label: str(call.arguments.label) ?? place.name },
        });
        return { ok: true, content: JSON.stringify({ highlighted: place.name }) };
      }

      case 'start_navigation': {
        if (!ctx.lastRoute) {
          return { ok: false, content: '', error: '先に経路を計算する必要があります' };
        }
        ctx.uiCommands.push({
          type: 'startNavigation',
          payload: { routeId: ctx.lastRoute.id },
        });
        return { ok: true, content: JSON.stringify({ started: true }) };
      }

      case 'set_time_of_day': {
        const hour = num(call.arguments.hour);
        if (hour === undefined || hour < 0 || hour > 23.99) {
          return { ok: false, content: '', error: 'hour は 0〜23 で指定してください' };
        }
        ctx.uiCommands.push({ type: 'setTimeOfDay', payload: { hour } });
        return { ok: true, content: JSON.stringify({ hour }) };
      }

      case 'set_weather': {
        const weather = str(call.arguments.weather) ?? 'clear';
        if (!['clear', 'cloudy', 'rain', 'snow', 'fog'].includes(weather)) {
          return { ok: false, content: '', error: '未対応の天候です' };
        }
        ctx.uiCommands.push({ type: 'setWeather', payload: { weather } });
        return { ok: true, content: JSON.stringify({ weather }) };
      }

      default:
        return { ok: false, content: '', error: `未知のツール: ${call.name}` };
    }
  } catch (error) {
    return { ok: false, content: '', error: (error as Error).message };
  }
}
