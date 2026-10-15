// CSRF 対策: Origin / Sec-Fetch-Site 検査。docs/ARCHITECTURE.md 5.5。
// GET / HEAD 以外のすべてで検査する。許可オリジンは設定で持たず、リクエスト自身のオリジンと比べる。

const SAFE_METHODS = new Set(['GET', 'HEAD']);

export function isSafeMethod(method: string): boolean {
  return SAFE_METHODS.has(method.toUpperCase());
}

/**
 * 1. Origin があれば new URL(request.url).origin と完全一致
 * 2. Origin が無ければ Sec-Fetch-Site: same-origin
 * 3. どちらも無ければ拒否
 */
export function checkSameOrigin(request: Request): boolean {
  if (isSafeMethod(request.method)) return true;
  const origin = request.headers.get('Origin');
  if (origin !== null) {
    let self: string;
    try {
      self = new URL(request.url).origin;
    } catch {
      return false;
    }
    return origin === self;
  }
  return (request.headers.get('Sec-Fetch-Site') ?? '').toLowerCase() === 'same-origin';
}
