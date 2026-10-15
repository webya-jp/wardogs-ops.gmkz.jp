// GET /api/bans → BansResponse(RCON GET /v1/bans。D1 があれば knownName を監査ログから補完)
import { knownBanNames } from '../../lib/audit';
import { jsonError, jsonOk } from '../../lib/http';
import { readFromRcon } from '../../lib/reads';
import { normalizeBans } from '../../lib/rcon/normalize';
import { apiHandler, methodNotAllowedRoute } from '../../lib/runtime';

export const GET = apiHandler(async (api) => {
  const r = await readFromRcon(api.rcon, 'bans', normalizeBans);
  if (!r.ok) return jsonError(r.code, r.opts);
  const db = api.state.db;
  if (db && r.data.bans.length > 0) {
    const names = await knownBanNames(db, r.data.bans.map((b) => b.steamId)).catch(() => new Map<string, string>());
    for (const b of r.data.bans) b.knownName = names.get(b.steamId) ?? null;
  }
  return jsonOk(r.data);
});

export const ALL = methodNotAllowedRoute;
