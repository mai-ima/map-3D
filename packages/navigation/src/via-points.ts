/**
 * 経由地。
 *
 * 市販カーナビの標準機能で、「先に寄ってから目的地へ」を表す。
 * 経路エンジンには出発地と目的地の間に挟んで渡す（順序は保つ）。
 *
 * ここで扱うのは **「どこまで通過したか」の判定だけ**。
 * 描画エンジンにも通信にも依存しない純粋な計算なので、
 * Swift へもそのまま持っていける。
 *
 * **なぜ通過の判定が要るのか。**
 * 経路を外れて再検索するとき、通過済みの経由地まで渡してしまうと、
 * 一度通った場所へ引き返す経路が出る。実際にカーナビでこれをやると、
 * 経由地を通り過ぎた直後の再検索で U ターンを指示されることになる。
 */

import type { LatLng } from '@ijm/shared';
import { distanceMeters } from '@ijm/shared';

/**
 * 経由地に「着いた」とみなす距離 (m)。
 *
 * 経由地は目的地と違って、その建物に入る必要はない。
 * 前を通れば用が足りることが多く、道の反対側を通ることもある。
 * 片側 2 車線の道でも幅は 15m 前後、これに測位の誤差
 * （GPS は市街地で 10〜30m ずれる）を見込んで 60m とする。
 */
export const VIA_REACHED_M = 60;

/**
 * 通過済みの経由地の数を進める。
 *
 * 経由地は順に通るので、先頭から順に見る。
 * 次の経由地に近づいていれば 1 つ進め、続けて次も見る
 * （近い経由地が並んでいると、1 回の判定で 2 つ通過することがある）。
 *
 * @param passed これまでに通過した数
 * @returns 新しい通過数（減ることはない）
 */
export function advancePassedVia(
  via: LatLng[],
  passed: number,
  position: LatLng,
  reachedM = VIA_REACHED_M,
): number {
  if (!Array.isArray(via) || via.length === 0) return 0;
  if (!Number.isFinite(position?.lat) || !Number.isFinite(position?.lng)) {
    return Math.min(Math.max(0, passed), via.length);
  }

  let next = Math.min(Math.max(0, Math.floor(passed) || 0), via.length);
  while (next < via.length && distanceMeters(via[next], position) <= reachedM) {
    next += 1;
  }
  return next;
}

/** まだ通っていない経由地。再検索のときはこれだけを渡す */
export function remainingVia(via: LatLng[], passed: number): LatLng[] {
  if (!Array.isArray(via)) return [];
  const from = Math.min(Math.max(0, Math.floor(passed) || 0), via.length);
  return via.slice(from);
}
