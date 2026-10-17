// GET /api/servers/:id/feed → ServerFeedStatus & KillfeedFeedStatusExtra、PUT /api/servers/:id/feed({ enabled, rawEnabled? })→ 同(docs/API.md 7.3・11.4)
// トークンの値・ハッシュは返さない。PUT はトークン未発行なら 404 NOT_FOUND
import { getFeedStatus, updateFeedSettings } from '../../../../lib/feed';
import { jsonError, jsonOk, readJsonBody } from '../../../../lib/http';
import { apiHandler, methodNotAllowedRoute } from '../../../../lib/runtime';
import { mutationContext } from '../../../../lib/server-api';

export const GET = apiHandler(async (api, context) => {
  const r = await getFeedStatus(api.db, context.params.id);
  return r.ok ? jsonOk(r.data) : jsonError(r.code, r.opts);
});

export const PUT = apiHandler(async (api, context) => {
  const body = await readJsonBody(context.request);
  if (!body.ok) return body.response;
  const m = await mutationContext(api, context.request);
  const r = await updateFeedSettings({ db: api.db, actor: m.actor }, context.params.id, body.body);
  return r.ok ? jsonOk(r.data) : jsonError(r.code, r.opts);
});

export const ALL = methodNotAllowedRoute;
