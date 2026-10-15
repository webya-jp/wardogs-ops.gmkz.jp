// GET /api/players?server=<id> → PlayersResponse(RCON GET /v1/players。cash 等は返さない)
import { jsonError, jsonOk } from '../../lib/http';
import { readFromRcon } from '../../lib/reads';
import { normalizePlayers } from '../../lib/rcon/normalize';
import { apiHandler, methodNotAllowedRoute, resolveReadTarget } from '../../lib/runtime';

export const GET = apiHandler(async (api, context) => {
  const target = await resolveReadTarget(api, context.request);
  if (!target.ok) return jsonError(target.code, target.opts);
  const r = await readFromRcon(target.data, 'players', normalizePlayers);
  return r.ok ? jsonOk(r.data) : jsonError(r.code, r.opts);
});

export const ALL = methodNotAllowedRoute;
