// GET /api/maps?server=<id> → MapsResponse(RCON GET /v1/catalog/maps)
// カタログのルートが無い・応答が読めない・空のときは、既知のマップ一覧(source: 'builtin')で代替する。
// 認証失敗や接続不能などサーバー自体に届かない失敗はそのままエラーにする(状態画面と同じ案内を出すため)。
import { jsonError, jsonOk } from '../../lib/http';
import { readFromRcon } from '../../lib/reads';
import { builtinMaps, withMapsFallback } from '../../lib/rcon/known-maps';
import { normalizeMaps } from '../../lib/rcon/normalize';
import { apiHandler, methodNotAllowedRoute, resolveReadTarget } from '../../lib/runtime';

const FALLBACK_CODES = new Set(['RCON_ROUTE_NOT_FOUND', 'RCON_BAD_RESPONSE']);

export const GET = apiHandler(async (api, context) => {
  const target = await resolveReadTarget(api, context.request);
  if (!target.ok) return jsonError(target.code, target.opts);
  const r = await readFromRcon(target.data, 'maps', normalizeMaps);
  if (r.ok) return jsonOk(withMapsFallback(r.data, r.data.fetchedAt));
  if (FALLBACK_CODES.has(r.code)) return jsonOk(builtinMaps(Date.now()));
  return jsonError(r.code, r.opts);
});

export const ALL = methodNotAllowedRoute;
