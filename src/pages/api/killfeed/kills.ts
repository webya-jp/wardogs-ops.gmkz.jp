// GET /api/killfeed/kills?server=<id>&match=<id|unrecorded>&after=<cursor> → KillfeedKillsResponse(docs/API.md 11.1)。ログイン必須。
// RCON は呼ばない(D1 だけ)。Steam ID・プレイヤー名を含む(画面はテキストとして表示する)。集計はブラウザで行う(17.10.6)
import type { KillfeedKillsResponse } from '../../../types/api';
import { utcDay } from '../../../lib/feed';
import { jsonError, jsonOk } from '../../../lib/http';
import { listKills, parseKillsQuery } from '../../../lib/killfeed/store';
import { apiHandler, methodNotAllowedRoute } from '../../../lib/runtime';

export const GET = apiHandler(async (api, context) => {
  const q = parseKillsQuery(new URL(context.request.url));
  if (!q.ok) return jsonError('VALIDATION_FAILED', { fields: q.fields });
  const r = await listKills(api.db, q, utcDay(Date.now()));
  return r === 'not_found' ? jsonError('MATCH_NOT_FOUND') : jsonOk<KillfeedKillsResponse>(r);
});

export const ALL = methodNotAllowedRoute;
