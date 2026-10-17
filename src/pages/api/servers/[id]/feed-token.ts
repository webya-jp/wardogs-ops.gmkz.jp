// POST /api/servers/:id/feed-token({})→ FeedTokenResponse(token はこの応答でだけ返す)、
// DELETE /api/servers/:id/feed-token({})→ ServerFeedStatus(未発行でも 200)。docs/API.md 7.3
import { issueFeedToken, revokeFeedToken } from '../../../../lib/feed';
import { jsonError, jsonOk, readJsonBody } from '../../../../lib/http';
import { apiHandler, methodNotAllowedRoute } from '../../../../lib/runtime';
import { mutationContext } from '../../../../lib/server-api';

export const POST = apiHandler(async (api, context) => {
  const body = await readJsonBody(context.request);
  if (!body.ok) return body.response;
  const m = await mutationContext(api, context.request);
  const r = await issueFeedToken({ db: api.db, actor: m.actor }, context.params.id);
  return r.ok ? jsonOk(r.data) : jsonError(r.code, r.opts);
});

export const DELETE = apiHandler(async (api, context) => {
  const body = await readJsonBody(context.request);
  if (!body.ok) return body.response;
  const m = await mutationContext(api, context.request);
  const r = await revokeFeedToken({ db: api.db, actor: m.actor }, context.params.id);
  return r.ok ? jsonOk(r.data) : jsonError(r.code, r.opts);
});

export const ALL = methodNotAllowedRoute;
