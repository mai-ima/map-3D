'use client';

import { useEffect, useRef, useState } from 'react';
import type { City } from '@ijm/shared';
import type { MapEngine } from '@ijm/map-engine';
import type { NavigationTickResult } from '@ijm/navigation';

/** セーフモードでの開き直しを 1 回に制限するためのキー */
const SAFE_RETRY_KEY = 'ijm:safe-retry';

export interface MapCanvasProps {
  city: City;
  onReady: (engine: MapEngine) => void;
  onNavigationTick: (result: NavigationTickResult) => void;
  onCameraInteraction?: () => void;
  onError: (message: string) => void;
}

/**
 * Cesium を載せるキャンバス。
 *
 * Cesium は SSR 不可・巨大なので、この中で動的 import する。
 * CESIUM_BASE_URL は import より前に設定する必要がある（Workers/Assets の解決先）。
 */
export default function MapCanvas({
  city,
  onReady,
  onNavigationTick,
  onCameraInteraction,
  onError,
}: MapCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<MapEngine | null>(null);
  const [loading, setLoading] = useState(true);
  const [contextLost, setContextLost] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const container = containerRef.current;
    if (!container) return;

    /**
     * 一度だけセーフモードで開き直す。
     *
     * iOS 18.2 以降、描画コマンドを出しすぎると WebKit が WebGL コンテキストを破棄する。
     * その状態のまま置いておくと画面が固まったように見えるだけなので、
     * 軽い設定で自動的に開き直して「とりあえず表示できる」状態にする。
     * sessionStorage で 1 回に制限し、再読み込みの繰り返しを防ぐ。
     */
    const retryInSafeMode = (): boolean => {
      try {
        if (window.sessionStorage.getItem(SAFE_RETRY_KEY)) return false;
        window.sessionStorage.setItem(SAFE_RETRY_KEY, '1');
      } catch {
        // プライベートブラウズなどで sessionStorage が使えない場合は繰り返しを防げないので、
        // 自動での開き直しは行わない
        return false;
      }
      const url = new URL(window.location.href);
      url.searchParams.set('safe', '1');
      window.location.replace(url.toString());
      return true;
    };

    // ?safe=1 は最小構成で起動する。
    // 端末や GPU ドライバの相性でどうしても表示できないときの逃げ道。
    const safeMode = new URLSearchParams(window.location.search).get('safe') === '1';

    (async () => {
      try {
        // Cesium の静的アセット（Workers / Assets / Widgets）の配信元
        (window as unknown as { CESIUM_BASE_URL: string }).CESIUM_BASE_URL = '/cesium';
        await import('cesium/Build/Cesium/Widgets/widgets.css');
        const { MapEngine } = await import('@ijm/map-engine');
        if (cancelled) return;

        const engine = new MapEngine({
          container,
          city,
          qualityTier: safeMode ? 'low' : undefined,
          onNavigationTick,
          onCameraInteraction,
          // メモリが逼迫すると、放置した場合はタブごとクラッシュする。
          // エンジン側が自動で描画負荷を落とすので、ここでは起きたことだけ知らせる。
          onMemoryPressure: () => {
            setNotice('メモリ使用量が多いため、描画品質を自動で調整しました');
            window.setTimeout(() => setNotice(null), 6000);
          },
          onContextLost: () => {
            if (!retryInSafeMode()) setContextLost(true);
          },
          onContextRestored: () => setContextLost(false),
        });
        engineRef.current = engine;
        onReady(engine);
        setLoading(false);
      } catch (error) {
        console.error(error);
        if (cancelled) return;
        // 初期化そのものに失敗した場合も、軽い設定なら通ることがある
        if (!safeMode && retryInSafeMode()) return;
        onError(
          `3D エンジンの初期化に失敗しました: ${(error as Error).message ?? '不明なエラー'}`,
        );
        setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      engineRef.current?.destroy();
      engineRef.current = null;
    };
    // 都市の切り替えはエンジン側の API で行うため、初期化は 1 回だけ
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="absolute inset-0">
      <div ref={containerRef} className="h-full w-full" />
      {contextLost && (
        <div className="absolute inset-0 flex items-center justify-center bg-ink-950/90 px-6">
          <div className="max-w-sm text-center">
            <p className="text-[15px] font-medium text-white">3D 描画が停止しました</p>
            <p className="mt-2 text-[13px] leading-relaxed text-mist-500">
              端末の GPU メモリが不足したため、ブラウザが 3D の描画を中断しました。
              ページを再読み込みすると復帰します。
            </p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="mt-4 rounded-lg bg-signal-500 px-4 py-2 text-[13px] font-medium text-ink-950 transition hover:bg-signal-400"
            >
              再読み込み
            </button>
          </div>
        </div>
      )}
      {notice && (
        <div className="pointer-events-none absolute bottom-6 left-1/2 -translate-x-1/2 rounded-full bg-ink-900/90 px-4 py-2 text-[12px] text-mist-400 ring-1 ring-white/10">
          {notice}
        </div>
      )}
      {loading && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-ink-950">
          <div className="flex flex-col items-center gap-3">
            <span className="h-8 w-8 animate-spin rounded-full border-2 border-white/15 border-t-signal-400" />
            <p className="text-[13px] tracking-wide text-mist-500">3D 都市データを読み込み中…</p>
          </div>
        </div>
      )}
    </div>
  );
}
