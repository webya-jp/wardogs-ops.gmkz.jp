// GET /api/bans?server=<id> → BansResponse(RCON GET /v1/bans。knownName を監査ログから補完。
// 名前の補完はサーバーで絞らない: Steam ID は全サーバー共通のため。docs/ARCHITECTURE.md 15.6)
import { knownBanNames } from '../../lib/audit';
import { jsonError, jsonOk } from '../../lib/http';
import { readFromRcon } from '../../lib/reads';
import { normalizeBans } from '../../lib/rcon/normalize';
import { apiHandler, methodNotAllowedRoute, resolveReadTarget } from '../../lib/runtime';

export const GET = apiHandler(async (api, context) => {
  const target = await resolveReadTarget(api, context.request);
  if (!target.ok) return jsonError(target.code, target.opts);
  const r = await readFromRcon(target.data, 'bans', normalizeBans);
  if (!r.ok) return jsonError(r.code, r.opts);
  if (r.data.bans.length > 0) {
    const names = await knownBanNames(api.db, r.data.bans.map((b) => b.steamId)).catch(() => new Map<string, string>());
    for (const b of r.data.bans) b.knownName = names.get(b.steamId) ?? null;
  }
  return jsonOk(r.data);
});

export const ALL = methodNotAllowedRoute;
