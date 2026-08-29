'use client';

import { useEffect, useState } from 'react';
import type { EngineDiagnostics, MapEngine } from '@ijm/map-engine';
import { Icon } from '@ijm/ui';

interface Props {
  engine: MapEngine | null;
  onClose: () => void;
}

const row = (label: string, value: string, warn = false) => ({ label, value, warn });

/**
 * 実機での描画負荷を確認するためのパネル（URL に ?debug=1 を付けると出る）。
 *
 * クラッシュの再現条件は端末・回線・見ている場所に強く依存するため、
 * 開発環境では再現できないことがある。実際に動かしている環境の数値を
 * その場で見られるようにしておく。
 */
export default function DiagnosticsPanel({ engine, onClose }: Props) {
  const [diag, setDiag] = useState<EngineDiagnostics | null>(null);

  useEffect(() => {
    if (!engine) return;
    const timer = window.setInterval(() => setDiag(engine.getDiagnostics()), 500);
    return () => window.clearInterval(timer);
  }, [engine]);

  if (!diag) return null;

  const heapRatio =
    diag.heapUsedMb !== null && diag.heapLimitMb ? diag.heapUsedMb / diag.heapLimitMb : null;

  const rows = [
    row('品質ティア', diag.tier),
    // 静止中は描画自体をしていないので、0 を性能不足と読み違えないようにする
    row('FPS', diag.idle ? '静止中（描画停止）' : String(diag.fps), !diag.idle && diag.fps < 25),
    row('カメラ高度', `${diag.cameraHeightM.toLocaleString()} m`),
    row('描画距離', `${(diag.viewDistanceM / 1000).toFixed(1)} km`),
    row('精細度 (SSE)', `${diag.appliedScreenSpaceError} (基準 ${diag.baseScreenSpaceError})`),
    row('負荷軽減係数', `×${diag.detailPenalty}`, diag.detailPenalty > 1),
    row('描画解像度', `×${diag.resolutionScale}`),
    row(
      '3D タイル使用量',
      `${diag.tileMemoryMb.toLocaleString()} MB / 目安 ${diag.cacheLimitMb.toLocaleString()} MB`,
      diag.tileMemoryMb > diag.cacheLimitMb,
    ),
    row(
      'JS ヒープ',
      diag.heapUsedMb === null
        ? 'このブラウザでは取得できません'
        : `${diag.heapUsedMb.toLocaleString()} MB / ${diag.heapLimitMb?.toLocaleString()} MB`,
      heapRatio !== null && heapRatio > 0.75,
    ),
    row('読み込み待ち', `${diag.loadQueue} タイル`, diag.loadQueue > 60),
    row('遠景タイルセット', diag.farTilesetLoaded ? '読み込み中' : '未使用'),
    row(
      '描画オプション',
      [
        diag.shadows ? '影' : null,
        diag.hdr ? 'HDR' : null,
        diag.msaaSamples > 1 ? `MSAA×${diag.msaaSamples}` : null,
      ]
        .filter(Boolean)
        .join(' / ') || 'なし（軽量描画）',
    ),
  ];

  const issueLabels: Record<string, string> = {
    'tile-failed': 'タイル取得失敗',
    'render-error': '描画エラー',
    'context-lost': '描画中断',
    'context-restored': '描画復帰',
    'memory-pressure': 'メモリ逼迫',
    'quality-degraded': '品質自動調整',
    stall: '描画停止',
  };

  return (
    <div className="pointer-events-auto absolute bottom-4 left-4 z-30 max-h-[70dvh] w-[19rem] overflow-y-auto rounded-xl bg-ink-900/92 p-3 text-[11px] ring-1 ring-white/10 backdrop-blur">
      <div className="mb-2 flex items-center justify-between">
        <span className="font-medium tracking-wide text-mist-300">描画診断</span>
        <button
          type="button"
          onClick={onClose}
          aria-label="診断パネルを閉じる"
          className="rounded p-1 text-mist-500 transition hover:bg-white/8 hover:text-mist-200"
        >
          <Icon name="close" size={13} />
        </button>
      </div>
      <dl className="space-y-1">
        {rows.map((r) => (
          <div key={r.label} className="flex items-baseline justify-between gap-3">
            <dt className="shrink-0 text-mist-500">{r.label}</dt>
            <dd
              className={`text-right tabular-nums ${r.warn ? 'text-amber-300' : 'text-mist-200'}`}
            >
              {r.value}
            </dd>
          </div>
        ))}
      </dl>
      {diag.healthSummary ? (
        <div className="mt-2 border-t border-white/8 pt-2">
          <p className="mb-1 font-medium text-amber-300">検出された問題</p>
          <p className="mb-1.5 text-mist-400">{diag.healthSummary}</p>
          <ul className="space-y-0.5">
            {diag.recentIssues.map((e, i) => (
              <li key={`${e.at}-${i}`} className="flex gap-1.5 text-mist-500">
                <span className="shrink-0 tabular-nums">
                  {new Date(e.at).toLocaleTimeString('ja-JP', {
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                  })}
                </span>
                <span className="min-w-0">
                  <span className="text-mist-400">{issueLabels[e.kind] ?? e.kind}</span>
                  {e.detail && <span className="block break-words">{e.detail}</span>}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="mt-2 border-t border-white/8 pt-2 leading-relaxed text-mist-600">
          問題は検出されていません。3D タイル使用量が目安を大きく超えるか、
          JS ヒープが上限に近づくと自動的に負荷を下げます。
        </p>
      )}
    </div>
  );
}
