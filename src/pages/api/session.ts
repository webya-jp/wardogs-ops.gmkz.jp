// GET /api/session → SessionResponse(RCON は呼ばない。docs/API.md 3 章)
import type { SessionResponse } from '../../types/api';
import { jsonOk } from '../../lib/http';
import { apiHandler, methodNotAllowedRoute } from '../../lib/runtime';
import { toSessionInfo } from '../../lib/session';

export const GET = apiHandler(async (api) => {
  const data: SessionResponse = { session: toSessionInfo(api.session), features: api.state.features, warnings: api.warnings };
  return jsonOk(data);
});

export const ALL = methodNotAllowedRoute;
