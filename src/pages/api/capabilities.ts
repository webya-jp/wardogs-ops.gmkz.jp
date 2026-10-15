// GET /api/capabilities?server=<id> → CapabilitiesResponse(取れなくても 200 で source: "unavailable"。docs/API.md 3 章)
// キャッシュはサーバーごと。?refresh=1 でキャッシュを無視(サーバーごとに 1 分に 1 回まで。超過時はキャッシュを返す)
import { jsonError, jsonOk } from '../../lib/http';
import { getCapabilities } from '../../lib/rcon/capabilities';
import { apiHandler, methodNotAllowedRoute, resolveReadTarget } from '../../lib/runtime';

export const GET = apiHandler(async (api, context) => {
  const target = await resolveReadTarget(api, context.request);
  if (!target.ok) return jsonError(target.code, target.opts);
  const refresh = new URL(context.request.url).searchParams.get('refresh') === '1';
  return jsonOk(await getCapabilities({ serverId: target.data.id, rcon: target.data.rcon }, { refresh }));
});

export const ALL = methodNotAllowedRoute;
