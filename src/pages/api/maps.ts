// GET /api/maps?server=<id> → MapsResponse(RCON GET /v1/catalog/maps)
import { jsonError, jsonOk } from '../../lib/http';
import { readFromRcon } from '../../lib/reads';
import { normalizeMaps } from '../../lib/rcon/normalize';
import { apiHandler, methodNotAllowedRoute, resolveReadTarget } from '../../lib/runtime';

export const GET = apiHandler(async (api, context) => {
  const target = await resolveReadTarget(api, context.request);
  if (!target.ok) return jsonError(target.code, target.opts);
  const r = await readFromRcon(target.data, 'maps', normalizeMaps);
  return r.ok ? jsonOk(r.data) : jsonError(r.code, r.opts);
});

export const ALL = methodNotAllowedRoute;
