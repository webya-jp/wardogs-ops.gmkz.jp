// GET /api/maps → MapsResponse(RCON GET /v1/catalog/maps)
import { jsonError, jsonOk } from '../../lib/http';
import { readFromRcon } from '../../lib/reads';
import { normalizeMaps } from '../../lib/rcon/normalize';
import { apiHandler, methodNotAllowedRoute } from '../../lib/runtime';

export const GET = apiHandler(async (api) => {
  const r = await readFromRcon(api.rcon, 'maps', normalizeMaps);
  return r.ok ? jsonOk(r.data) : jsonError(r.code, r.opts);
});

export const ALL = methodNotAllowedRoute;
