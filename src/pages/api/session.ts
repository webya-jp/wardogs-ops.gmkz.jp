// GET /api/session → SessionResponse(RCON は呼ばない。docs/API.md 3 章)
// warnings には全体のログイン失敗が直近 1 時間で 50 回を超えたとき LOGIN_FAILURES_HIGH を足す
import type { SessionResponse } from '../../types/api';
import { jsonOk } from '../../lib/http';
import { apiHandler, methodNotAllowedRoute } from '../../lib/runtime';
import { toSessionInfo } from '../../lib/session';
import { LoginThrottle, withLoginAlert } from '../../lib/throttle';

export const GET = apiHandler(async (api) => {
  const warnings = await withLoginAlert(api.warnings, new LoginThrottle({ db: api.state.db }));
  const data: SessionResponse = { session: toSessionInfo(api.session), features: api.state.features, warnings };
  return jsonOk(data);
});

export const ALL = methodNotAllowedRoute;
