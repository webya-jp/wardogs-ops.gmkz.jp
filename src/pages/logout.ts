// POST /logout: Cookie を消し、監査ログに logout を記録して /login へ 303(docs/ARCHITECTURE.md 5.4)。
// Origin 検査は middleware が行う。GET などは 405。
import type { APIRoute } from 'astro';
import { recordLogout } from '../lib/auth';
import { getFeatures } from '../lib/config';
import { clientIp, discardBody, getWaitUntil, redirect } from '../lib/http';
import { getKeys } from '../lib/keys';
import { getEnv, IS_DEV } from '../lib/runtime';
import { clearSessionCookie, getAttachedSession } from '../lib/session';

export const POST: APIRoute = async (context) => {
  await discardBody(context.request);
  const env = getEnv();
  const [keys, state] = await Promise.all([getKeys(env), getFeatures(env)]);
  getWaitUntil(context.locals)(
    recordLogout({ keys, db: state.db, session: getAttachedSession(context.locals), ip: clientIp(context.request) }),
  );
  return redirect('/login', 303, { 'Set-Cookie': clearSessionCookie(IS_DEV) });
};

export const ALL: APIRoute = async (context) => {
  await discardBody(context.request);
  return new Response(null, { status: 405, headers: { Allow: 'POST' } });
};
