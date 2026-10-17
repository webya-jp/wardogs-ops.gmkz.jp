// GET /api/status?server=<id> → StatusResponse(RCON GET /v1/status。次のマップ・件数は GET /v1/rotation〔300 秒キャッシュ〕から補う。成功時は人数スナップショットを応答後に記録。
// docs/ARCHITECTURE.md 4.2・4.4・15.6。対象サーバーは docs/API.md 1.2)
import { getWaitUntil, jsonError, jsonOk } from '../../lib/http';
import { readStatus } from '../../lib/reads';
import { apiHandler, methodNotAllowedRoute, resolveReadTarget } from '../../lib/runtime';
import { recordSnapshot } from '../../lib/snapshots';

export const GET = apiHandler(async (api, context) => {
  const target = await resolveReadTarget(api, context.request);
  if (!target.ok) return jsonError(target.code, target.opts);
  const r = await readStatus(target.data);
  if (!r.ok) return jsonError(r.code, r.opts);
  if (api.state.features.snapshots) getWaitUntil(context.locals)(recordSnapshot(api.db, target.data.id, r.data));
  return jsonOk(r.data);
});

export const ALL = methodNotAllowedRoute;
