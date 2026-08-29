'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * iOS のシート（Apple Maps などで下から出てくるパネル）を再現する。
 *
 * ネイティブに近づけるために押さえている点:
 *  - 指の動きに 1:1 で追従する（アニメーションで遅れて追いかけない）
 *  - 離した瞬間の速度を見て、行き先のスナップ位置を決める（フリックが効く）
 *  - 端を超えて引っ張ったときは抵抗をかける（ゴムバンド）
 *  - シートが一番上でないときは中身をスクロールさせず、シート自体を動かす
 *  - 中身が一番上までスクロールされている状態で下へ引くと、シートが下がる
 */

/** 画面の高さに対する比率で表したスナップ位置 */
export type Detent = number;

export interface BottomSheetProps {
  /** 小さい順に並べたスナップ位置（画面高さに対する比率） */
  detents?: Detent[];
  /** 現在のスナップ位置の添字 */
  index: number;
  onIndexChange: (index: number) => void;
  /** つまみの右側に置く要素（閉じるボタンなど） */
  accessory?: ReactNode;
  children: ReactNode;
}

const DEFAULT_DETENTS: Detent[] = [0.16, 0.52, 0.92];
/** これ以上の速度でフリックしたら、距離に関係なく隣のスナップ位置へ送る (px/ms) */
const FLICK_VELOCITY = 0.45;
/** 端を超えて引っ張ったときの追従率 */
const RUBBER_BAND = 0.35;
/** これ以上動いたらドラッグとみなす。タップとの取り違えを防ぐ */
const DRAG_THRESHOLD_PX = 6;

export default function BottomSheet({
  detents = DEFAULT_DETENTS,
  index,
  onIndexChange,
  accessory,
  children,
}: BottomSheetProps) {
  const sheetRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [viewportH, setViewportH] = useState(0);
  const [dragging, setDragging] = useState(false);

  // ドラッグ中の状態。再描画を挟まずに読み書きしたいので ref に持つ
  const drag = useRef({
    active: false,
    fromScroll: false,
    /** 実際に動かし始めたか。閾値を超えるまでは false */
    moved: false,
    captured: false,
    pointerId: -1,
    startY: 0,
    startHeight: 0,
    lastY: 0,
    lastT: 0,
    velocity: 0,
  });
  const [dragHeight, setDragHeight] = useState<number | null>(null);

  useEffect(() => {
    const update = (): void => setViewportH(window.innerHeight);
    update();
    window.addEventListener('resize', update);
    // iOS はツールバーの出入りで高さが変わる
    window.visualViewport?.addEventListener('resize', update);
    return () => {
      window.removeEventListener('resize', update);
      window.visualViewport?.removeEventListener('resize', update);
    };
  }, []);

  const clampedIndex = Math.max(0, Math.min(index, detents.length - 1));
  const targetHeight = viewportH * detents[clampedIndex];
  const height = dragHeight ?? targetHeight;

  const isTop = clampedIndex === detents.length - 1;

  /** 高さから最も近いスナップ位置を選ぶ。速度が乗っていれば隣へ送る */
  const settle = useCallback(
    (currentHeight: number, velocity: number): number => {
      const ratio = currentHeight / Math.max(1, viewportH);

      // velocity は「下向きが正」。下へフリックしたら 1 段下、上なら 1 段上
      if (Math.abs(velocity) > FLICK_VELOCITY) {
        const dir = velocity > 0 ? -1 : 1;
        return Math.max(0, Math.min(detents.length - 1, clampedIndex + dir));
      }

      let best = 0;
      let bestDist = Infinity;
      detents.forEach((d, i) => {
        const dist = Math.abs(d - ratio);
        if (dist < bestDist) {
          bestDist = dist;
          best = i;
        }
      });
      return best;
    },
    [clampedIndex, detents, viewportH],
  );

  const onPointerDown = useCallback(
    (event: React.PointerEvent, fromScroll: boolean) => {
      // マルチタッチやペンの副ボタンは無視する
      if (!event.isPrimary) return;

      drag.current = {
        active: true,
        fromScroll,
        moved: false,
        captured: false,
        pointerId: event.pointerId,
        startY: event.clientY,
        startHeight: height,
        lastY: event.clientY,
        lastT: event.timeStamp,
        velocity: 0,
      };

      // つまみは掴んで動かすためだけの領域なので、押した時点で捕まえる。
      // 高さ 20px ほどしかなく、少し動かすだけで指が外に出てしまうため、
      // 捕まえておかないとドラッグが即座に途切れる。
      //
      // 一方、中身の領域で同じことをすると以降のイベントがこの要素に固定され、
      // 中のボタンで click が発火しなくなる（＝シート内が一切押せなくなる）。
      // そちらは実際に指が動き始めてから捕まえる。
      if (!fromScroll) {
        try {
          (event.currentTarget as Element).setPointerCapture(event.pointerId);
          drag.current.captured = true;
        } catch {
          /* 対応していない環境ではそのまま続行する */
        }
      }
    },
    [height],
  );

  const onPointerMove = useCallback(
    (event: React.PointerEvent) => {
      const d = drag.current;
      if (!d.active) return;

      const dy = event.clientY - d.startY;

      // 指のぶれをドラッグと見なさない。閾値を超えて初めてドラッグとして扱う
      if (!d.moved) {
        if (Math.abs(dy) < DRAG_THRESHOLD_PX) return;
        d.moved = true;
        // 中身の領域から始まった場合は、ここで初めて捕まえる（タップを妨げないため）
        if (!d.captured) {
          try {
            (event.currentTarget as Element).setPointerCapture(event.pointerId);
            d.captured = true;
          } catch {
            /* 対応していない環境ではそのまま続行する */
          }
        }
      }

      // 中身のスクロール領域から始まったドラッグは、
      // 「一番上まで戻っていて、さらに下へ引いた」ときだけシートを動かす。
      // そうしないと、リストをスクロールするたびにシートが動いてしまう。
      if (d.fromScroll) {
        const scrolled = scrollRef.current?.scrollTop ?? 0;
        if (scrolled > 0 || dy <= 0) return;
      }

      let next = d.startHeight - dy;

      // 端を超えたぶんは抵抗をかけて、行き止まり感を出す
      const max = viewportH * detents[detents.length - 1];
      const min = viewportH * detents[0];
      if (next > max) next = max + (next - max) * RUBBER_BAND;
      if (next < min) next = min - (min - next) * RUBBER_BAND;

      const dt = event.timeStamp - d.lastT;
      if (dt > 0) {
        // 下向きを正とする（指を下げる = シートを縮める）
        d.velocity = (event.clientY - d.lastY) / dt;
        d.lastY = event.clientY;
        d.lastT = event.timeStamp;
      }

      if (!dragging) setDragging(true);
      setDragHeight(next);
    },
    [detents, dragging, viewportH],
  );

  const endDrag = useCallback((event?: React.PointerEvent) => {
    const d = drag.current;
    if (!d.active) return;
    d.active = false;
    if (event && d.captured) {
      try {
        (event.currentTarget as Element).releasePointerCapture(event.pointerId);
      } catch {
        /* 既に解放されている場合は無視する */
      }
    }
    d.captured = false;

    const current = dragHeight;
    setDragging(false);
    setDragHeight(null);
    if (current === null) return;

    const next = settle(current, d.velocity);
    if (next !== clampedIndex) onIndexChange(next);
  }, [clampedIndex, dragHeight, onIndexChange, settle]);

  return (
    <div
      ref={sheetRef}
      className="pointer-events-auto absolute inset-x-0 bottom-0 z-20 flex flex-col rounded-t-[--sheet-radius] bg-ink-900/95 ring-1 ring-white/10 backdrop-blur-2xl"
      style={{
        height: `${height}px`,
        // 指に追従している間はアニメーションを挟まない（遅れて追いかけると鈍く感じる）
        transition: dragging ? 'none' : 'height 380ms cubic-bezier(0.32, 0.72, 0, 1)',
        // iOS のシートに近い角丸
        ['--sheet-radius' as string]: '1.25rem',
        boxShadow: '0 -12px 40px -12px rgb(0 0 0 / 0.7)',
      }}
    >
      {/* つまみ。ここを掴めばどこからでもシートを動かせる */}
      <div
        onPointerDown={(e) => onPointerDown(e, false)}
        onPointerMove={onPointerMove}
        onPointerUp={(e) => endDrag(e)}
        onPointerCancel={(e) => endDrag(e)}
        className="shrink-0 cursor-grab touch-none px-4 pt-2.5 pb-1 active:cursor-grabbing"
      >
        <div className="relative flex items-center justify-center">
          <span className="h-1 w-9 rounded-full bg-white/25" />
          {accessory && <div className="absolute right-0">{accessory}</div>}
        </div>
      </div>

      <div
        ref={scrollRef}
        onPointerDown={(e) => onPointerDown(e, true)}
        onPointerMove={onPointerMove}
        onPointerUp={(e) => endDrag(e)}
        onPointerCancel={(e) => endDrag(e)}
        className="min-h-0 flex-1 overscroll-contain px-4 pb-[max(1rem,env(safe-area-inset-bottom))]"
        style={{
          // 一番上まで開いていないときは中身をスクロールさせない。
          // シートを動かす操作とスクロールが競合して、どちらも中途半端になるため
          overflowY: isTop ? 'auto' : 'hidden',
          WebkitOverflowScrolling: 'touch',
        }}
      >
        {children}
      </div>
    </div>
  );
}
