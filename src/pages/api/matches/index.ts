// GET /api/matches?server=<id> → MatchesResponse(docs/API.md 8 章)。RCON は呼ばない。server は必須。削除済みの id は 0 件
import type { MatchesResponse } from '../../../types/api';
import { jsonError, jsonOk } from '../../../lib/http';
import { listMatches } from '../../../lib/recordings';
import { apiHandler, methodNotAllowedRoute } from '../../../lib/runtime';
import { parseServerParam } from '../../../lib/servers';

export const GET = apiHandler(async (api, context) => {
  const sv = parseServerParam(new URL(context.request.url).searchParams.get('server'));
  if (!sv.ok) return jsonError('VALIDATION_FAILED', { fields: { server: sv.issue } });
  return jsonOk<MatchesResponse>(await listMatches(api.db, sv.id));
});

export const ALL = methodNotAllowedRoute;
