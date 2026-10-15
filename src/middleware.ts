// 全リクエストの入口。docs/ARCHITECTURE.md 2 章・5 章。
// 1. 設定チェック(必須 Secrets の不足・不正 → ページは /setup へ 303、API は 503 NOT_CONFIGURED)
// 2. CSRF(GET / HEAD 以外は Origin / Sec-Fetch-Site 検査。API は 403 JSON、ページは 403 の簡易 HTML)
// 3. ログイン Cookie の検証(未ログイン → ページは /login へ 303、API は 401 UNAUTHENTICATED)
// 4. 応答にセキュリティヘッダと Cache-Control: no-store
// 例外: /login・/setup は未ログインで通す。/setup は設定不足でも通す。静的アセット(/_astro/*)はここを通らない(念のため除外)。
import { defineMiddleware } from 'astro:middleware';
import { checkConfig } from './lib/config';
import { checkSameOrigin } from './lib/csrf';
import { discardBody, jsonError, redirect, simpleHtml, withSecurityHeaders } from './lib/http';
import { getKeys } from './lib/keys';
import { getEnv, IS_DEV } from './lib/runtime';
import { attachSession, cookieName, readCookie, toSessionInfo, verifySession } from './lib/session';
import { getTranslator, resolveLanguage } from './i18n';

const PUBLIC_PATHS = new Set(['/login', '/setup']);

function isAssetPath(pathname: string): boolean {
  return pathname.startsWith('/_astro/') || pathname.startsWith('/_image') || pathname === '/favicon.ico' || pathname === '/favicon.svg';
}

function normalizePathname(pathname: string): string {
  return pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
}

export const onRequest = defineMiddleware(async (context, next) => {
  const url = new URL(context.request.url);
  const pathname = normalizePathname(url.pathname);
  if (isAssetPath(pathname)) return next();

  const env = getEnv();
  const isApi = pathname === '/api' || pathname.startsWith('/api/');
  const language = resolveLanguage(env.LANGUAGE, context.request.headers.get('Accept-Language'));
  context.locals.session = null;

  // 1. 設定チェック
  const config = checkConfig(env);
  if (!config.ok && pathname !== '/setup') {
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

  // 3. ログイン Cookie
  if (config.ok) {
    const value = readCookie(context.request, cookieName(IS_DEV));
    if (value) {
      const keys = await getKeys(env);
      const data = await verifySession(keys.session, value);
      if (data) {
        context.locals.session = toSessionInfo(data);
        attachSession(context.locals, data);
      }
    }
  }
  if (!context.locals.session && !PUBLIC_PATHS.has(pathname)) {
    await discardBody(context.request);
    return withSecurityHeaders(isApi ? jsonError('UNAUTHENTICATED') : redirect('/login'));
  }

  // 4. ヘッダ
  return withSecurityHeaders(await next());
});
