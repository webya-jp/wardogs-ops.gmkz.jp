// POST /api/actions/prepare → PrepareResponse(docs/API.md 4 章。本文の server は必須)
import { prepareAction } from '../../../lib/actions';
import { hashClientIp } from '../../../lib/keys';
import { clientIp, jsonError, jsonOk, readJsonBody } from '../../../lib/http';
import { apiHandler, methodNotAllowedRoute } from '../../../lib/runtime';

export const POST = apiHandler(async (api, context) => {
  const body = await readJsonBody(context.request);
  if (!body.ok) return body.response;
  if (!api.state.features.writes) return jsonError('WRITES_DISABLED');
  const r = await prepareAction(
    {
      keys: api.keys,
      servers: api.servers,
      session: api.session,
      db: api.state.db,
      writesEnabled: api.state.features.writes,
      ipHash: await hashClientIp(api.keys, clientIp(context.request)),
    },
    body.body,
  );
  return r.ok ? jsonOk(r.data) : jsonError(r.code, r.opts);
});

export const ALL = methodNotAllowedRoute;
