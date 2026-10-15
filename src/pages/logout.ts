// POST /logout: ログイン Cookie とサーバーの選択 Cookie を消し、監査ログに logout を記録して /login へ 303
// (docs/ARCHITECTURE.md 5.4・15.5)。Origin 検査は middleware が行う。GET などは 405。
import type { APIRoute } from 'astro';
import { recordLogout } from '../lib/auth';
import { getFeatures } from '../lib/config';
import { clientIp, discardBody, getWaitUntil } from '../lib/http';
import { getKeys } from '../lib/keys';
import { getEnv, IS_DEV } from '../lib/runtime';
import { clearServerCookie } from '../lib/servers';
import { clearSessionCookie, getAttachedSession } from '../lib/session';

export const POST: APIRoute = async (context) => {
  await discardBody(context.request);
  const env = getEnv();
  const [keys, state] = await Promise.all([getKeys(env), getFeatures(env)]);
  getWaitUntil(context.locals)(
    recordLogout({ keys, db: state.db, session: getAttachedSession(context.locals), ip: clientIp(context.request) }),
  );
  const headers = new Headers({ Location: '/login', 'Cache-Control': 'no-store' });
  headers.append('Set-Cookie', clearSessionCookie(IS_DEV));
  headers.append('Set-Cookie', clearServerCookie(IS_DEV));
  return new Response(null, { status: 303, headers });
};

export const ALL: APIRoute = async (context) => {
  await discardBody(context.request);
  return new Response(null, { status: 405, headers: { Allow: 'POST' } });
};
