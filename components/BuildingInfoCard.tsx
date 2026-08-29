'use client';

import type { BuildingInfo } from '@ijm/shared';
import { Icon } from '@ijm/ui';

const SOURCE_LABELS: Record<string, string> = {
  osm: 'OpenStreetMap',
  plateau: 'PLATEAU',
  nominatim: 'Nominatim',
};

export default function BuildingInfoCard({
  building,
  loading,
  onClose,
}: {
  building: BuildingInfo | null;
  loading: boolean;
  onClose: () => void;
}) {
  if (!building && !loading) return null;

  return (
    <div className="glass w-[min(92vw,320px)] rounded-[16px] p-3.5">
      <div className="mb-1.5 flex items-start justify-between gap-2">
        <h2 className="text-[14px] font-semibold">
          {loading ? '建物情報を取得中…' : (building?.name ?? '名称データなし')}
        </h2>
        <button
          onClick={onClose}
          aria-label="建物情報を閉じる"
          className="shrink-0 text-mist-500 transition-colors hover:text-mist-100"
        >
          <Icon name="close" size={15} />
        </button>
      </div>

      {building && (
        <>
          <dl className="space-y-1 text-[12px]">
            {building.buildingType && <Row label="用途" value={building.buildingType} />}
            {building.height !== undefined && (
              <Row label="高さ" value={`${building.height.toFixed(1)} m`} />
            )}
            {building.levels !== undefined && <Row label="階数" value={`${building.levels} 階`} />}
            {building.address && <Row label="住所" value={building.address} />}
            <Row
              label="座標"
              value={`${building.lat.toFixed(5)}, ${building.lng.toFixed(5)}`}
            />
          </dl>
          <p className="mt-2 text-[11px] text-mist-500">
            出典: {building.sources.map((s) => SOURCE_LABELS[s] ?? s).join(' / ')}
          </p>
        </>
      )}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <dt className="w-12 shrink-0 text-mist-500">{label}</dt>
      <dd className="min-w-0 flex-1 break-words text-mist-100">{value}</dd>
    </div>
  );
}
