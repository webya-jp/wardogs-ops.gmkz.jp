// PUT /api/servers/:id → ServerMutationResponse、DELETE /api/servers/:id → DeleteServerResponse(docs/API.md 7 章)
// :id の形式不正(default を含む)は 400。DELETE は本文 { confirmName } 必須
import { jsonError, jsonOk, readJsonBody } from '../../../lib/http';
import { apiHandler, methodNotAllowedRoute } from '../../../lib/runtime';
import { deleteServer, updateServer } from '../../../lib/servers';
import { mutationContext } from '../../../lib/server-api';

export const PUT = apiHandler(async (api, context) => {
  const body = await readJsonBody(context.request);
  if (!body.ok) return body.response;
  const r = await updateServer(await mutationContext(api, context.request), context.params.id, body.body);
  return r.ok ? jsonOk(r.data) : jsonError(r.code, r.opts);
});

export const DELETE = apiHandler(async (api, context) => {
  const body = await readJsonBody(context.request);
  if (!body.ok) return body.response;
  const r = await deleteServer(await mutationContext(api, context.request), context.params.id, body.body);
  return r.ok ? jsonOk(r.data) : jsonError(r.code, r.opts);
});

export const ALL = methodNotAllowedRoute;
