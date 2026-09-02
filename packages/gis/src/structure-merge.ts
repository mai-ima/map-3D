/**
 * OSM の way を、実際に建っている 1 本の構造物にまとめる。
 *
 * OSM は線路を 1 本ずつ別の way にしている。浜松の実測（2026-08）では
 * 東海道新幹線が 15 本、東海道本線が 8 本の way に分かれていて、
 * 上下線の間隔は 3.8〜4.3m しかない。
 * これを 1 本ずつ橋にすると床版が重なり、積み上がって見える
 * （実測で 110 組が重なっていた）。
 *
 * まとめ方は 2 段階:
 *
 *   縦につなぐ … 端点が一致する way を 1 本の線につなぐ。
 *                 区間ごとに別々の縦断勾配を引くと接続部が段差になる
 *   横にまとめる … 平行に近接して走る way を 1 つの高架にまとめ、
 *                 床版の幅を実際の軌道の広がりから決める
 *
 * どちらも「実在する線形」は OSM のまま使い、
 * 束ね方と幅の決め方だけをこちらで補っている。
 */

import type { ElevatedStructure, LatLng, StructureKind } from '@ijm/shared';

/** 端点が同じとみなす距離 (m) */
const STITCH_TOLERANCE_M = 2.5;

/**
 * 平行とみなす中心線間隔 (m)。
 *
 * 線路の間隔は 3.8〜4.3m なので、隣り合う軌道は必ずまとまる。
 * 一方、浜松では東海道本線と東海道新幹線の高架が 13.2m 離れている。
 * これらは別々の構造物なので、まとめてはいけない。
 */
const PARALLEL_GAP_M: Record<StructureKind, number> = {
  'rail-elevated': 6,
  'rail-bridge': 6,
  'road-elevated': 5,
  'road-bridge': 4,
  footbridge: 3,
};

/** まとめた結果の床版がこれ以上広がったら、まとめすぎと判断する (m) */
const MAX_MERGED_WIDTH: Record<StructureKind, number> = {
  'rail-elevated': 26,
  'rail-bridge': 26,
  'road-elevated': 24,
  'road-bridge': 22,
  footbridge: 10,
};

/** 平行とみなす向きの差 (rad)。約 22 度 */
const PARALLEL_ANGLE = 0.38;

/** 路面の高さがこれ以上違えば別の構造物 (m) */
const SAME_LEVEL_M = 1.5;

/** 軌道の中心から床版の縁までの余裕 (m) */
const TRACK_MARGIN_M = 2.2;

/**
 * 床版の幅を決めるのに使う、基準の中心線に対する長さの割合。
 *
 * 駅構内の短い側線まで幅の計算に入れると、そこから何 km も続く高架が
 * まるごと駅の幅になってしまう（浜松では 1.4km の新幹線高架が
 * 20m 幅になっていた）。長く続いているものだけで幅を決める。
 */
const SIGNIFICANT_LENGTH_RATIO = 0.4;

/**
 * まとめてよい組み合わせか。
 *
 * 道路橋に併設された歩道は、OSM では別の way だが実物では同じ床版の上にある。
 * 浜松の実測では、残っていた重なりの大半がこの形だった。
 */
function compatible(a: ElevatedStructure, b: ElevatedStructure): boolean {
  if (a.layer !== b.layer) return false;
  if (Math.abs(a.deckHeight - b.deckHeight) > SAME_LEVEL_M) return false;
  if (a.kind === b.kind) return true;
  const road = (k: StructureKind) => k === 'road-bridge' || k === 'road-elevated';
  return (
    (a.kind === 'footbridge' && road(b.kind)) || (b.kind === 'footbridge' && road(a.kind))
  );
}

/** 中心線がこれだけ近ければ同じ構造物とみなす (m) */
function gapLimit(a: ElevatedStructure, b: ElevatedStructure): number {
  // 種別が違う（＝道路橋と併設歩道）なら、床版どうしが触れる距離まで
  if (a.kind !== b.kind) return (a.width + b.width) / 2;
  return PARALLEL_GAP_M[a.kind];
}

const M_PER_DEG = 111_320;

interface Point {
  x: number;
  y: number;
}

/** 緯度経度をローカルの平面直交座標へ（範囲が小さいので平面近似で足りる） */
function projector(origin: LatLng) {
  const cos = Math.cos((origin.lat * Math.PI) / 180) || 1;
  return {
    to: (p: LatLng): Point => ({
      x: (p.lng - origin.lng) * M_PER_DEG * cos,
      y: (p.lat - origin.lat) * M_PER_DEG,
    }),
    from: (p: Point): LatLng => ({
      lat: origin.lat + p.y / M_PER_DEG,
      lng: origin.lng + p.x / (M_PER_DEG * cos),
    }),
  };
}

function distance(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/** 点と線分の距離 */
function pointToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return distance(p, a);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** 点と折れ線の距離、および最も近い線分の向き */
function pointToPolyline(p: Point, line: Point[]): { distance: number; index: number } {
  let best = Infinity;
  let index = 0;
  for (let i = 1; i < line.length; i += 1) {
    const d = pointToSegment(p, line[i - 1], line[i]);
    if (d < best) {
      best = d;
      index = i - 1;
    }
  }
  return { distance: best, index };
}

function polylineLength(line: Point[]): number {
  let total = 0;
  for (let i = 1; i < line.length; i += 1) total += distance(line[i - 1], line[i]);
  return total;
}

/** 折れ線全体のおおよその向き (rad)。始点と終点を結んだ方向 */
function bearing(line: Point[]): number {
  const a = line[0];
  const b = line[line.length - 1];
  return Math.atan2(b.y - a.y, b.x - a.x);
}

/** 向きの差（0〜π/2）。逆向きは同じ向きとして扱う */
function angleBetween(a: number, b: number): number {
  let d = Math.abs(a - b) % Math.PI;
  if (d > Math.PI / 2) d = Math.PI - d;
  return d;
}

// ---- 縦につなぐ -------------------------------------------------------

/** つなげてよい相手か。造りが違うものをつなぐと形が破綻する */
function sameLine(a: ElevatedStructure, b: ElevatedStructure): boolean {
  return (
    a.kind === b.kind &&
    a.layer === b.layer &&
    Math.abs(a.width - b.width) < 0.5 &&
    (a.name ?? '') === (b.name ?? '')
  );
}

/**
 * 端点が一致する way をつなぐ。
 *
 * 区間ごとに独立して縦断勾配を引くと、接続部で路面が食い違って
 * 段差になる。1 本の線にしてしまえばその余地が無くなる。
 */
export function stitchStructures(structures: ElevatedStructure[]): ElevatedStructure[] {
  const remaining = [...structures];
  const out: ElevatedStructure[] = [];

  while (remaining.length > 0) {
    const current = remaining.shift() as ElevatedStructure;
    const path = [...current.path];
    const sources = [...(current.sourceIds ?? [current.id])];

    let extended = true;
    while (extended) {
      extended = false;
      for (let i = 0; i < remaining.length; i += 1) {
        const other = remaining[i];
        if (!sameLine(current, other)) continue;

        const head = path[0];
        const tail = path[path.length - 1];
        const otherHead = other.path[0];
        const otherTail = other.path[other.path.length - 1];
        const near = (p: LatLng, q: LatLng): boolean => {
          const cos = Math.cos((p.lat * Math.PI) / 180) || 1;
          return (
            Math.hypot((q.lat - p.lat) * M_PER_DEG, (q.lng - p.lng) * M_PER_DEG * cos) <
            STITCH_TOLERANCE_M
          );
        };

        if (near(tail, otherHead)) path.push(...other.path.slice(1));
        else if (near(tail, otherTail)) path.push(...[...other.path].reverse().slice(1));
        else if (near(head, otherTail)) path.unshift(...other.path.slice(0, -1));
        else if (near(head, otherHead)) path.unshift(...[...other.path].reverse().slice(0, -1));
        else continue;

        sources.push(...(other.sourceIds ?? [other.id]));
        remaining.splice(i, 1);
        extended = true;
        break;
      }
    }

    out.push(sources.length > 1 ? { ...current, path, sourceIds: sources } : current);
  }
  return out;
}

// ---- 横にまとめる -----------------------------------------------------

/** A の頂点が B の中心線からどれだけ離れているか（中央値） */
function medianGap(a: Point[], b: Point[]): number {
  const gaps = a.map((p) => pointToPolyline(p, b).distance);
  gaps.sort((x, y) => x - y);
  return gaps[Math.floor(gaps.length / 2)];
}

/**
 * 中心線 spine から見た点の左右方向のずれ (m)。
 * spine の進行方向に対して左を正とする。
 */
function lateralOffset(p: Point, spine: Point[]): number {
  const { index } = pointToPolyline(p, spine);
  const a = spine[index];
  const b = spine[index + 1] ?? spine[index];
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) return 0;
  // 進行方向の左向き単位ベクトルは (-dy, dx) / len
  return ((p.x - a.x) * -dy + (p.y - a.y) * dx) / len;
}

/** 中心線に沿った累積距離 */
function cumulative(line: Point[]): number[] {
  const out = [0];
  for (let i = 1; i < line.length; i += 1) out.push(out[i - 1] + distance(line[i - 1], line[i]));
  return out;
}

/** 累積距離 d の位置の点。頂点の間は線形補間する */
function pointAtDistance(line: Point[], cum: number[], d: number): Point {
  if (d <= 0) return line[0];
  const last = line.length - 1;
  if (d >= cum[last]) return line[last];
  for (let i = 1; i <= last; i += 1) {
    if (d <= cum[i]) {
      const span = cum[i] - cum[i - 1];
      const t = span > 0 ? (d - cum[i - 1]) / span : 0;
      return {
        x: line[i - 1].x + (line[i].x - line[i - 1].x) * t,
        y: line[i - 1].y + (line[i].y - line[i - 1].y) * t,
      };
    }
  }
  return line[last];
}

/** 累積距離 [from, to] の区間を切り出す（端は補間して足す） */
function sliceLine(line: Point[], cum: number[], from: number, to: number): Point[] {
  const out: Point[] = [pointAtDistance(line, cum, from)];
  for (let i = 0; i < line.length; i += 1) {
    if (cum[i] > from && cum[i] < to) out.push(line[i]);
  }
  out.push(pointAtDistance(line, cum, to));
  return out;
}

/**
 * 基準線上のある地点を、その線がまたいでいるか。
 *
 * またいでいれば左右のずれ (m) を、端より外なら null を返す。
 * 端点が最寄りになる場合は「その線はもう終わっている」とみなす。
 */
function offsetIfCovered(p: Point, line: Point[]): number | null {
  let best = Infinity;
  let bestIndex = -1;
  let bestT = 0;
  for (let i = 1; i < line.length; i += 1) {
    const a = line[i - 1];
    const b = line[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) continue;
    const raw = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
    const t = Math.max(0, Math.min(1, raw));
    const d = Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
    if (d < best) {
      best = d;
      bestIndex = i - 1;
      bestT = raw;
    }
  }
  if (bestIndex < 0) return null;
  // 最寄りが線の外側（始点より手前・終点より先）なら、この地点は範囲外
  if (bestIndex === 0 && bestT < 0) return null;
  if (bestIndex === line.length - 2 && bestT > 1) return null;
  // lateralOffset(p, line) は「line から見た p のずれ」。
  // ほしいのは逆向きの「p（基準線上の地点）から見た line のずれ」
  return -lateralOffset(p, line);
}

/** 幅を測る間隔 (m)。細かすぎると区間が増え、粗いと駅の広がりを取り逃す */
const WIDTH_STATION_M = 60;
/** 幅がこれ以上変われば区間を分ける (m) */
const WIDTH_STEP_M = 5;
/** これより短い区間は隣とまとめる (m)。細切れにすると接続部が増えて粗が出る */
const MIN_SEGMENT_M = 150;

interface WidthSegment {
  path: Point[];
  width: number;
  members: number[];
}

/**
 * 基準線の周りに集まっている線だけを、上限の幅に収まる範囲で選ぶ。
 *
 * 駅構内では軌道が扇状に広がり、端から端まで 40m を超えることがある。
 * すべてを 1 枚の床版にすると実在しない巨大構造になるので、
 * 基準線を含む固まりだけを採り、外れたものは別の構造物として残す。
 */
function clusterAroundSpine(
  offsets: { index: number; offset: number }[],
  maxSpread: number,
  maxGap: number,
): { index: number; offset: number }[] {
  const sorted = [...offsets].sort((a, b) => a.offset - b.offset);
  const spine = sorted.findIndex((o) => o.offset === 0);
  const start = spine >= 0 ? spine : 0;
  let lo = start;
  let hi = start;
  // 基準線から左右へ、隣が近く、かつ全体の広がりが上限に収まるうちは取り込む。
  // 隣まで離れていたら止める。空白をまたいで取り込むと、隣の高架の軌道まで
  // 1 枚の床版に載せてしまい、浜松駅のように 2 本の高架が重なって見える
  for (;;) {
    const leftGap = lo > 0 ? sorted[lo].offset - sorted[lo - 1].offset : Infinity;
    const rightGap = hi < sorted.length - 1 ? sorted[hi + 1].offset - sorted[hi].offset : Infinity;
    const canLeft =
      leftGap <= maxGap && sorted[hi].offset - sorted[lo - 1]?.offset <= maxSpread;
    const canRight =
      rightGap <= maxGap && sorted[hi + 1]?.offset - sorted[lo].offset <= maxSpread;
    if (!canLeft && !canRight) break;
    // 近いほうから取り込む
    if (canLeft && (!canRight || leftGap <= rightGap)) lo -= 1;
    else hi += 1;
  }
  return sorted.slice(lo, hi + 1);
}

/**
 * 基準線に沿って幅を測り、幅が変わるところで区間に分ける。
 *
 * 駅では軌道が増えて床版が広がり、離れると細くなる。
 * 全長を 1 つの幅で表すと、どちらかが必ず実物と違う姿になる
 * （浜松では 1.4km の新幹線高架が端から端まで駅の幅になっていた）。
 *
 * 一度も採用されなかった線の番号を leftover として返す。
 * 呼び出し側はそれを元のまま出す。
 */
function segmentByWidth(
  spine: Point[],
  lines: Point[][],
  margin: number,
  maxWidth: number,
  maxGap: number,
): { segments: WidthSegment[]; leftover: number[] } {
  const cum = cumulative(spine);
  const total = cum[cum.length - 1];
  if (total <= 0) return { segments: [], leftover: lines.map((_, i) => i) };

  const maxSpread = Math.max(0, maxWidth - margin * 2);
  const steps = Math.max(1, Math.round(total / WIDTH_STATION_M));
  const used = new Set<number>();
  const samples: { d: number; min: number; max: number; members: number[] }[] = [];

  for (let k = 0; k <= steps; k += 1) {
    const d = (total * k) / steps;
    const p = pointAtDistance(spine, cum, d);
    const covering: { index: number; offset: number }[] = [];
    lines.forEach((line, i) => {
      const offset = offsetIfCovered(p, line);
      if (offset !== null) covering.push({ index: i, offset });
    });
    const cluster = clusterAroundSpine(covering, maxSpread, maxGap);
    for (const c of cluster) used.add(c.index);
    const offsets = cluster.map((c) => c.offset);
    samples.push({
      d,
      min: Math.min(0, ...offsets),
      max: Math.max(0, ...offsets),
      members: cluster.map((c) => c.index),
    });
  }

  // 幅が近い連続した区間をまとめる
  const widthOf = (s: (typeof samples)[number]) => s.max - s.min + margin * 2;
  const ranges: { from: number; to: number; slice: typeof samples }[] = [];
  let startIndex = 0;
  for (let k = 1; k <= samples.length; k += 1) {
    const done = k === samples.length;
    if (!done && Math.abs(widthOf(samples[k]) - widthOf(samples[startIndex])) <= WIDTH_STEP_M) {
      continue;
    }
    const slice = samples.slice(startIndex, done ? k : k + 1);
    ranges.push({ from: slice[0].d, to: slice[slice.length - 1].d, slice });
    startIndex = k;
  }

  // 短い区間は隣とまとめる。細切れにすると接続部が増え、
  // 幅の違う床版が数十メートルおきに現れて不自然になる
  for (let k = 0; k < ranges.length; ) {
    if (ranges.length === 1 || ranges[k].to - ranges[k].from >= MIN_SEGMENT_M) {
      k += 1;
      continue;
    }
    const prev = ranges[k - 1];
    const next = ranges[k + 1];
    // 幅の広いほうへ寄せる（狭くすると軌道が床版からはみ出す）
    const target =
      !prev ? next : !next ? prev
        : widthOf(prev.slice[0]) >= widthOf(next.slice[0]) ? prev : next;
    target.from = Math.min(target.from, ranges[k].from);
    target.to = Math.max(target.to, ranges[k].to);
    target.slice = [...target.slice, ...ranges[k].slice];
    ranges.splice(k, 1);
    k = 0;
  }

  const segments: WidthSegment[] = [];
  for (const range of ranges) {
    if (range.to <= range.from) continue;
    const min = Math.min(...range.slice.map((s) => s.min));
    const max = Math.max(...range.slice.map((s) => s.max));
    const memberSet = new Set<number>();
    for (const s of range.slice) for (const m of s.members) memberSet.add(m);
    segments.push({
      path: shiftLine(sliceLine(spine, cum, range.from, range.to), (min + max) / 2),
      width: max - min + margin * 2,
      members: [...memberSet],
    });
  }

  const leftover = lines.map((_, i) => i).filter((i) => !used.has(i));
  return { segments, leftover };
}

/** 中心線を左方向へ offset だけずらす */
function shiftLine(line: Point[], offset: number): Point[] {
  return line.map((p, i) => {
    const prev = line[Math.max(0, i - 1)];
    const next = line[Math.min(line.length - 1, i + 1)];
    const dx = next.x - prev.x;
    const dy = next.y - prev.y;
    const len = Math.hypot(dx, dy);
    if (len === 0) return p;
    return { x: p.x + (-dy / len) * offset, y: p.y + (dx / len) * offset };
  });
}

/**
 * 平行に近接して走る構造物を 1 本にまとめる。
 *
 * まとめた床版の幅は、実際の軌道・車線の広がり（中心線どうしのずれ）から求める。
 * 「複線だから 11m」と決め打ちするのではなく、OSM に入っている実際の
 * 線形の広がりを測って幅にしているので、3 線・4 線の区間も実物に沿う。
 */
export function mergeParallel(structures: ElevatedStructure[]): ElevatedStructure[] {
  if (structures.length < 2) return structures;

  const origin = structures[0].path[0];
  const { to, from } = projector(origin);
  const lines = structures.map((s) => s.path.map(to));
  const lengths = lines.map(polylineLength);
  const bearings = lines.map(bearing);

  // 併合先を指す配列（Union-Find）
  const parent = structures.map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const union = (i: number, j: number): void => {
    const a = find(i);
    const b = find(j);
    if (a !== b) parent[b] = a;
  };

  for (let i = 0; i < structures.length; i += 1) {
    for (let j = i + 1; j < structures.length; j += 1) {
      const a = structures[i];
      const b = structures[j];
      if (!compatible(a, b)) continue;
      if (angleBetween(bearings[i], bearings[j]) > PARALLEL_ANGLE) continue;
      // 短いほうが長いほうに沿っているかを見る
      const shorter = lengths[i] <= lengths[j] ? lines[i] : lines[j];
      const longer = lengths[i] <= lengths[j] ? lines[j] : lines[i];
      if (medianGap(shorter, longer) < gapLimit(a, b)) union(i, j);
    }
  }

  const groups = new Map<number, number[]>();
  structures.forEach((_, i) => {
    const root = find(i);
    const list = groups.get(root) ?? [];
    list.push(i);
    groups.set(root, list);
  });

  const out: ElevatedStructure[] = [];
  /** 基準線から離れていて束に入らなかったもの。あとでまとめ直す */
  const rejected: ElevatedStructure[] = [];

  for (const members of groups.values()) {
    if (members.length === 1) {
      out.push(structures[members[0]]);
      continue;
    }

    // 基準の中心線は、歩道でないもののうち最も長いものを選ぶ。
    // 併設歩道を基準にすると、道路橋が歩道の造りになってしまう
    const primary = members.filter((i) => structures[i].kind !== 'footbridge');
    const candidates = primary.length > 0 ? primary : members;
    const spineIndex = candidates.reduce(
      (best, i) => (lengths[i] > lengths[best] ? i : best),
      candidates[0],
    );
    const spine = lines[spineIndex];
    const base = structures[spineIndex];

    const margin = base.kind.startsWith('rail')
      ? TRACK_MARGIN_M
      : Math.max(...members.map((i) => structures[i].width)) / 2;

    // 幅は基準の中心線に沿って測り直す。
    // 全長ぶんの最大の広がりを 1 つの幅にすると、駅で広がっているだけの
    // 高架が端から端まで駅の幅になってしまう（浜松では 1.4km の
    // 新幹線高架が 20m 幅になっていた）。実物は駅で広がり、離れると細くなる。
    // 基準線が members の何番目かに合わせて並べ替える（0 番が基準線）
    const ordered = [spineIndex, ...members.filter((i) => i !== spineIndex)];
    const { segments, leftover } = segmentByWidth(
      spine,
      ordered.map((i) => lines[i]),
      margin,
      MAX_MERGED_WIDTH[base.kind],
      // 隣をまたぐ限界。併設歩道のように種別が違うものが混ざる束では、
      // その組み合わせで許される距離まで広げる
      Math.max(...members.map((i) => gapLimit(base, structures[i]))),
    );

    segments.forEach((segment, si) => {
      const indices = segment.members.map((m) => ordered[m]);
      out.push({
        ...base,
        // 幅が変わるところで区間に分けるので、1 本の高架から複数できる。
        // id をそのままコピーすると重複し、クリックしたときにどれを
        // 指しているのか決まらなくなる。区間ごとに連番を付ける。
        // 元の way は sourceIds から辿れる
        id: segments.length > 1 ? `${base.id}@${si}` : base.id,
        // 名前は付いているものを優先する（無名の側線に引きずられないように）
        name: indices.map((i) => structures[i].name).find(Boolean) ?? base.name,
        path: segment.path.map(from),
        width: segment.width,
        tracks: base.kind.startsWith('rail') ? Math.max(1, indices.length) : base.tracks,
        sourceIds: indices.flatMap((i) => structures[i].sourceIds ?? [structures[i].id]),
      });
    });
    // どの区間にも入らなかったものは、あとでもう一度まとめ直す。
    // 基準線から離れていて弾かれただけで、取りこぼし同士は
    // 隣り合っていることがある（浜松では 1.4km の新幹線 2 本がこれだった）
    for (const m of leftover) rejected.push(structures[ordered[m]]);
  }

  // 取りこぼしをもう一度まとめる。減らなくなったらそこで打ち切る
  if (rejected.length > 1 && rejected.length < structures.length) {
    out.push(...mergeParallel(rejected));
  } else {
    out.push(...rejected);
  }
  return out;
}

/** つながっているとみなす端点の距離 (m)。まとめた床版は横にずれるぶん緩めに取る */
const JOIN_TOLERANCE_M = 10;

/** 端点でつながり、かつ同じ向きに続いているか */
function joins(a: ElevatedStructure, b: ElevatedStructure): boolean {
  const family = (s: ElevatedStructure) => (s.kind.startsWith('rail') ? 'rail' : s.kind);
  if (family(a) !== family(b)) return false;

  const cos = Math.cos((a.path[0].lat * Math.PI) / 180) || 1;
  const gap = (p: LatLng, q: LatLng) =>
    Math.hypot((q.lat - p.lat) * M_PER_DEG, (q.lng - p.lng) * M_PER_DEG * cos);
  const ends = [a.path[0], a.path[a.path.length - 1]];
  const others = [b.path[0], b.path[b.path.length - 1]];
  return ends.some((p) => others.some((q) => gap(p, q) < JOIN_TOLERANCE_M));
}

/**
 * つながっている構造物の路面の高さを揃える。
 *
 * 同じ路線でも、川をまたぐ区間は橋、市街地はラーメン高架橋と構造が変わる。
 * 高さをそれぞれの造りだけで決めると、接続部で路面が段差になる
 * （鉄道では 7m を超える段ができうる）。実物では路面は連続していて、
 * 変わるのはその下の造りだけなので、つながっている側の高いほうに合わせる。
 */
export function alignDeckHeights(structures: ElevatedStructure[]): ElevatedStructure[] {
  const heights = structures.map((s) => s.deckHeight);
  // 端点の一致は推移する（A-B-C）ので、変化が無くなるまで繰り返す。
  // 構造物の数だけ回れば必ず収束する
  for (let pass = 0; pass < structures.length; pass += 1) {
    let changed = false;
    for (let i = 0; i < structures.length; i += 1) {
      for (let j = i + 1; j < structures.length; j += 1) {
        if (heights[i] === heights[j]) continue;
        if (!joins(structures[i], structures[j])) continue;
        const top = Math.max(heights[i], heights[j]);
        heights[i] = top;
        heights[j] = top;
        changed = true;
      }
    }
    if (!changed) break;
  }
  return structures.map((s, i) =>
    heights[i] === s.deckHeight ? s : { ...s, deckHeight: heights[i] },
  );
}

/** 縦につないで、横にまとめて、つながり先と高さを揃える */
export function consolidateStructures(structures: ElevatedStructure[]): ElevatedStructure[] {
  // 線にならないものは、つなぐことも横に並べることもできない。
  // 端点を読むところで落ちるので、先に外しておく
  const usable = structures.filter((s) => s.path.length >= 2);
  return alignDeckHeights(mergeParallel(stitchStructures(usable)));
}
