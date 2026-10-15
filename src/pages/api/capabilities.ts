// GET /api/capabilities → CapabilitiesResponse(取れなくても 200 で source: "unavailable"。docs/API.md 3 章)
// ?refresh=1 でキャッシュを無視(1 分に 1 回まで。超過時はキャッシュを返す)
import { jsonOk } from '../../lib/http';
import { getCapabilities } from '../../lib/rcon/capabilities';
import { apiHandler, methodNotAllowedRoute } from '../../lib/runtime';

export const GET = apiHandler(async (api, context) => {
  const refresh = new URL(context.request.url).searchParams.get('refresh') === '1';
  return jsonOk(await getCapabilities(api.rcon, { refresh }));
});

export const ALL = methodNotAllowedRoute;
