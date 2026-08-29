import { NextResponse } from 'next/server';
import { getGisConfig } from '@ijm/gis';
import { PUBLIC_VALHALLA_URL, createRouteProvider } from '@ijm/routing';
import { isAIConfigured } from '@ijm/ai';
import { envUrl } from '@ijm/shared';

/**
 * 診断用エンドポイント。
 *
 * 「解決後の外部サービス URL」と「そこへ到達できるか」を返す。
 * 環境変数が空文字で登録されている等の設定事故を、デプロイ先で切り分けるために使う。
 * 返すのは公開サービスの URL だけで、API キーは has/なし のみ（値は絶対に返さない）。
 */

export const runtime = 'nodejs';
export const maxDuration = 30;
export const dynamic = 'force-dynamic';

interface ProbeResult {
  name: string;
  url: string;
  ok: boolean;
  status?: number;
  ms: number;
  error?: string;
}

async function probe(name: string, url: string, timeoutMs = 8000): Promise<ProbeResult> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': getGisConfig().userAgent, Accept: '*/*' },
      cache: 'no-store',
    });
    // 本文は読み捨てる（接続できたかどうかだけ見る）
    await res.arrayBuffer().catch(() => undefined);
    return { name, url, ok: res.ok, status: res.status, ms: Date.now() - started };
  } catch (error) {
    return {
      name,
      url,
      ok: false,
      ms: Date.now() - started,
      error: (error as Error).message,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function GET() {
  const gis = getGisConfig();
  const valhallaBase = envUrl(process.env.VALHALLA_URL, PUBLIC_VALHALLA_URL);
  const plateauTerrain = envUrl(
    process.env.PLATEAU_TERRAIN_URL,
    'https://tile.plateauview.mlit.go.jp/terrain',
  );

  const probes = await Promise.all([
    probe('nominatim', `${gis.nominatimEndpoint}/status.php?format=json`),
    probe('overpass', `${gis.overpassEndpoints[0]}?data=%5Bout%3Ajson%5D%3Bout%20count%3B`),
    probe('valhalla', `${valhallaBase}/status`),
    probe('gsi-tile', 'https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/10/909/403.jpg'),
    probe(
      'plateau-tileset',
      'https://api.plateauview.mlit.go.jp/datacatalog/3dtiles/13-bldg-maxlod2-latest/tileset.json',
    ),
    probe('plateau-terrain', `${plateauTerrain}/layer.json`),
  ]);

  return NextResponse.json(
    {
      ok: probes.every((p) => p.ok),
      runtime: {
        node: process.version,
        region: process.env.VERCEL_REGION ?? null,
        env: process.env.VERCEL_ENV ?? 'local',
        commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null,
      },
      resolved: {
        nominatim: gis.nominatimEndpoint,
        overpass: gis.overpassEndpoints,
        valhalla: valhallaBase,
        routingEngine: createRouteProvider().name,
        plateauTerrain,
        gisTimeoutMs: gis.timeoutMs,
        aiConfigured: isAIConfigured(),
      },
      probes,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
