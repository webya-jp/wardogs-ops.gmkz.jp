// GET /api/matches/:id/samples?server=<id> → MatchSamplesResponse(docs/API.md 8 章)。RCON は呼ばない。
// :id の形式不正は 400(fields.id)、無い・server と違う → 404 MATCH_NOT_FOUND
import { MATCH_ID_PATTERN } from '../../../../types/api';
import type { MatchSamplesResponse } from '../../../../types/api';
import { jsonError, jsonOk } from '../../../../lib/http';
import { getMatchSamples } from '../../../../lib/recordings';
import { apiHandler, methodNotAllowedRoute } from '../../../../lib/runtime';
import { parseServerParam } from '../../../../lib/servers';

export const GET = apiHandler(async (api, context) => {
  const id = context.params.id;
  const q = new URL(context.request.url).searchParams.get('server');
  const fields: Record<string, 'invalid_format'> = {};
  if (typeof id !== 'string' || !MATCH_ID_PATTERN.test(id)) fields.id = 'invalid_format';
  let server: string | null = null;
  if (q !== null && q !== '') {
    const sv = parseServerParam(q);
    if (sv.ok) server = sv.id;
    else fields.server = 'invalid_format';
  }
  if (Object.keys(fields).length > 0 || typeof id !== 'string') return jsonError('VALIDATION_FAILED', { fields });
  const r = await getMatchSamples(api.db, id, server);
  return r ? jsonOk<MatchSamplesResponse>(r) : jsonError('MATCH_NOT_FOUND');
});

export const ALL = methodNotAllowedRoute;
