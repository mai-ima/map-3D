'use client';

import { useEffect, useState } from 'react';

/**
 * ネイティブ風の UI に切り替えるかどうかの判定。
 *
 * 画面幅だけで判定すると、デスクトップのウィンドウを狭めたときにも
 * ボトムシートになってしまう。逆にユーザーエージェントだけで判定すると
 * iPad の横向きなど広い画面でもシートになる。
 * 「タッチ操作が主で、かつ画面が狭い」ときだけ切り替える。
 */
export function useIsMobile(breakpoint = 768): boolean {
  // サーバー描画時は false 固定にして、ハイドレーションのずれを避ける
  const [mobile, setMobile] = useState(false);

  useEffect(() => {
    const query = window.matchMedia(`(max-width: ${breakpoint - 1}px), (pointer: coarse)`);

    const update = (): void => {
      const coarse = window.matchMedia('(pointer: coarse)').matches;
      const narrow = window.innerWidth < breakpoint;
      setMobile(coarse && narrow);
    };

    update();
    query.addEventListener('change', update);
    window.addEventListener('resize', update);
    return () => {
      query.removeEventListener('change', update);
      window.removeEventListener('resize', update);
    };
  }, [breakpoint]);

  return mobile;
}
