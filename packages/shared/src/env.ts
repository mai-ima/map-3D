/**
 * 環境変数の読み取りユーティリティ。
 *
 * ホスティング環境（Vercel など）では「変数名だけ登録されて値が空」という状態が
 * 起こりうる。素朴に `env.FOO ?? DEFAULT` と書くと、空文字は null/undefined ではないため
 * 既定値にフォールバックせず、`''` がそのまま使われてしまう。
 * その結果 `fetch('' + '/search?...')` のような相対 URL になり、
 * サーバ側 fetch が "Failed to parse URL" で落ちる。
 *
 * ここでは「空白のみの値は未設定と同じ」「URL は絶対 URL でなければ既定値を使う」
 * という規則を一箇所に集約し、全パッケージから同じ挙動で使えるようにする。
 */

/** 空文字・空白のみを「未設定」として扱う */
export function envString(raw: string | undefined | null): string | undefined {
  if (raw == null) return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** 最初に「実際に値が入っている」ものを返す */
export function envFirst(...values: (string | undefined | null)[]): string | undefined {
  for (const value of values) {
    const resolved = envString(value);
    if (resolved !== undefined) return resolved;
  }
  return undefined;
}

/** 絶対 URL(http/https) かどうか */
export function isAbsoluteHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * エンドポイント URL を解決する。
 * 未設定・空・相対 URL の場合は既定値にフォールバックする（末尾の `/` は落とす）。
 */
export function envUrl(raw: string | undefined | null, fallback: string): string {
  const value = envString(raw);
  if (value !== undefined && isAbsoluteHttpUrl(value)) return stripTrailingSlash(value);
  return stripTrailingSlash(fallback);
}

/** 任意のエンドポイント（既定値なし）。不正な値は undefined 扱いにする。 */
export function envOptionalUrl(raw: string | undefined | null): string | undefined {
  const value = envString(raw);
  if (value !== undefined && isAbsoluteHttpUrl(value)) return stripTrailingSlash(value);
  return undefined;
}

/** カンマ区切りの URL 一覧。有効な絶対 URL が 1 つも無ければ既定値を使う。 */
export function envUrlList(raw: string | undefined | null, fallback: string[]): string[] {
  const list = (envString(raw) ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && isAbsoluteHttpUrl(s))
    .map(stripTrailingSlash);
  return list.length > 0 ? list : fallback.map(stripTrailingSlash);
}

/** 数値。空・非数値なら既定値。 */
export function envNumber(raw: string | undefined | null, fallback: number): number {
  const value = envString(raw);
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function stripTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.replace(/\/+$/, '') : value;
}
