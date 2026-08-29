import { NextResponse } from 'next/server';
import { attributionStrings } from '@ijm/shared';
import { getBuildingInfo, type PlateauFeatureAttributes } from '@ijm/gis';

export const runtime = 'nodejs';
export const maxDuration = 30;

/**
 * 建物情報。
 * クライアントが 3D Tiles の feature から読み取った PLATEAU 属性を渡せるようにしている
 * （PLATEAU の属性名は地域・年度でぶれるため、素直に受け取って正規化する）。
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    lat?: number;
    lng?: number;
    attributes?: Record<string, unknown>;
  };

  if (!Number.isFinite(body.lat) || !Number.isFinite(body.lng)) {
    return NextResponse.json({ error: 'lat と lng が必要です' }, { status: 400 });
  }

  const attrs = body.attributes ?? {};
  const plateau: PlateauFeatureAttributes = {
    gmlId: pickString(attrs, ['gml_id', 'gmlId', '_gml_id', 'id']),
    measuredHeight: pickNumber(attrs, ['bldg_measuredHeight', 'measuredHeight', '計測高さ']),
    usage: pickString(attrs, ['bldg_usage', 'usage', '用途']),
    name: pickString(attrs, ['bldg_name', 'name', '名称']),
    storeysAboveGround: pickNumber(attrs, [
      'bldg_storeysAboveGround',
      'storeysAboveGround',
      '地上階数',
    ]),
  };

  try {
    const info = await getBuildingInfo({ lat: body.lat!, lng: body.lng! }, plateau);
    return NextResponse.json({
      building: info,
      attribution: attributionStrings(['osm', 'plateau', 'nominatim']),
    });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 502 });
  }
}

function pickString(attrs: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = attrs[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function pickNumber(attrs: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = Number(attrs[key]);
    if (Number.isFinite(value) && value !== 0) return value;
  }
  return undefined;
}
