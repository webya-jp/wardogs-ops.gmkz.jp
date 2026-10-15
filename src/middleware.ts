// 全リクエストの入口。docs/ARCHITECTURE.md 2 章・5.1.1・5.5・5.7。順序は「D1 の判定 → CSRF → 管理者の有無 → ログイン Cookie → ヘッダ」。
// 1. D1 の判定(D1 が無い・マイグレーション未適用 → ページは /setup へ 303〔/setup 自身は案内を出す〕、API は 503 NOT_CONFIGURED)
// 2. CSRF(GET / HEAD 以外は Origin / Sec-Fetch-Site 検査。/setup・/login・/logout・/api/* すべて。API は 403 JSON、ページは 403 の簡易 HTML)
// 3. 管理者の有無(毎リクエスト。キャッシュしない。Cookie があれば admins の読み取りで兼ねる)。
//    0 行 → ページは /setup へ 303(/setup 自身は登録フォーム)、API は 503 SETUP_REQUIRED
// 4. ログイン Cookie の検証(未ログイン → ページは /login へ 303、API は 401 UNAUTHENTICATED)
// 5. 応答にセキュリティヘッダと Cache-Control: no-store
// 例外: /login・/setup は未ログインで通す。/setup は D1 の不備・未登録でも通す(登録済みのときの誘導は setup.astro が行う)。
// 静的アセット(/_astro/*)は本来ここを通らない(念のため除外。それ以外は除外しない)。
// D1 の呼び出しが失敗したら 500(API は INTERNAL_ERROR)にし、D1 の判定のキャッシュを捨てる。
import { defineMiddleware } from 'astro:middleware';
import { getAdminById, hasAdmin } from './lib/admins';
import { getFeatures, invalidateD1Cache } from './lib/config';
import { checkSameOrigin } from './lib/csrf';
import { discardBody, errName, jsonError, redirect, simpleHtml, withSecurityHeaders } from './lib/http';
import { getKeys } from './lib/keys';
import { getEnv, IS_DEV } from './lib/runtime';
import { attachSession, cookieName, readCookie, toSessionInfo, verifySession } from './lib/session';
import type { SessionData } from './lib/session';
import { getTranslator, resolveLanguage } from './i18n';

const PUBLIC_PATHS = new Set(['/login', '/setup']);

function isAssetPath(pathname: string): boolean {
  return pathname.startsWith('/_astro/');
}

function normalizePathname(pathname: string): string {
  return pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
}

/** ログイン Cookie を検証し、管理者の有無も返す(Cookie が通れば管理者はいる) */
async function checkAuth(db: D1Database, request: Request): Promise<{ session: SessionData | null; hasAdmin: boolean }> {
  const value = readCookie(request, cookieName(IS_DEV));
  if (value) {
    const keys = await getKeys(db);
    const session = await verifySession(keys.session, value, (aid) => getAdminById(db, aid));
    if (session) return { session, hasAdmin: true };
  }
  return { session: null, hasAdmin: await hasAdmin(db) };
}

export const onRequest = defineMiddleware(async (context, next) => {
  const url = new URL(context.request.url);
  const pathname = normalizePathname(url.pathname);
  if (isAssetPath(pathname)) return next();

  const env = getEnv();
  const isApi = pathname === '/api' || pathname.startsWith('/api/');
  const isSetup = pathname === '/setup';
  const language = resolveLanguage(env.LANGUAGE, context.request.headers.get('Accept-Language'));
  context.locals.session = null;

  const fail500 = async (err: unknown): Promise<Response> => {
    invalidateD1Cache();
    console.error(JSON.stringify({ kind: 'middleware-error', path: pathname, error: errName(err) }));
    await discardBody(context.request);
    if (isApi) return withSecurityHeaders(jsonError('INTERNAL_ERROR'));
    const t = getTranslator(language);
    return simpleHtml(500, language, t('app.name'), t('error.INTERNAL_ERROR'));
  };

  // 1. D1 の判定
  let db: D1Database | null;
  try {
    db = (await getFeatures(env)).db;
  } catch (err) {
    return fail500(err);
  }
  if (!db && !isSetup) {
    await discardBody(context.request);
    return withSecurityHeaders(isApi ? jsonError('NOT_CONFIGURED') : redirect('/setup'));
  }

  // 2. CSRF
  if (!checkSameOrigin(context.request)) {
    await discardBody(context.request);
    if (isApi) return withSecurityHeaders(jsonError('FORBIDDEN_ORIGIN'));
    const t = getTranslator(language);
    return simpleHtml(403, language, t('app.name'), t('login.forbidden'));
  }

  if (db) {
    // 3. 管理者の有無 + 4. ログイン Cookie
    let auth: { session: SessionData | null; hasAdmin: boolean };
    try {
      auth = await checkAuth(db, context.request);
    } catch (err) {
      return fail500(err);
    }
    if (!auth.hasAdmin && !isSetup) {
      await discardBody(context.request);
      return withSecurityHeaders(isApi ? jsonError('SETUP_REQUIRED') : redirect('/setup'));
    }
    if (auth.session) {
      context.locals.session = toSessionInfo(auth.session);
      attachSession(context.locals, auth.session);
    }
  }
  if (!context.locals.session && !PUBLIC_PATHS.has(pathname)) {
    await discardBody(context.request);
    return withSecurityHeaders(isApi ? jsonError('UNAUTHENTICATED') : redirect('/login'));
  }

  // 5. ヘッダ
  return withSecurityHeaders(await next());
});
