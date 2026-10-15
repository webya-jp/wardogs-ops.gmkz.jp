// GET /api/status → StatusResponse(RCON GET /v1/status。成功時は人数スナップショットを応答後に記録。docs/ARCHITECTURE.md 4.2・4.4)
import { getWaitUntil, jsonError, jsonOk } from '../../lib/http';
import { readFromRcon } from '../../lib/reads';
import { normalizeStatus } from '../../lib/rcon/normalize';
import { apiHandler, methodNotAllowedRoute } from '../../lib/runtime';
import { recordSnapshot } from '../../lib/snapshots';

export const GET = apiHandler(async (api, context) => {
  const r = await readFromRcon(api.rcon, 'status', normalizeStatus);
  if (!r.ok) return jsonError(r.code, r.opts);
  const db = api.state.features.snapshots ? api.state.db : null;
  if (db) getWaitUntil(context.locals)(recordSnapshot(db, r.data));
  return jsonOk(r.data);
});

export const ALL = methodNotAllowedRoute;
