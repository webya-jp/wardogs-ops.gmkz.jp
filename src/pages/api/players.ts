// GET /api/players → PlayersResponse(RCON GET /v1/players。cash 等は返さない)
import { jsonError, jsonOk } from '../../lib/http';
import { readFromRcon } from '../../lib/reads';
import { normalizePlayers } from '../../lib/rcon/normalize';
import { apiHandler, methodNotAllowedRoute } from '../../lib/runtime';

export const GET = apiHandler(async (api) => {
  const r = await readFromRcon(api.rcon, 'players', normalizePlayers);
  return r.ok ? jsonOk(r.data) : jsonError(r.code, r.opts);
});

export const ALL = methodNotAllowedRoute;
