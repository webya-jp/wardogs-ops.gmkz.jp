// GET /api/servers → ServersResponse、POST /api/servers → 201 ServerMutationResponse(docs/API.md 7 章)
// - GET は RCON を呼ばない。SESSION_SECRET 設定後に古い鍵(k = a)の行を復号できたら、応答後に再暗号化する(15.3)
// - POST は検証 → 上限 → 暗号化して INSERT + 変更ログ(db.batch)→ 接続テスト(失敗しても保存は取り消さない)
import { MAX_SERVERS } from '../../../types/api';
import type { ServersResponse } from '../../../types/api';
import { getWaitUntil, jsonError, jsonOk, jsonResponse, readJsonBody } from '../../../lib/http';
import { apiHandler, methodNotAllowedRoute } from '../../../lib/runtime';
import { createServer, listServers, migratePasswords } from '../../../lib/servers';
import { mutationContext } from '../../../lib/server-api';

export const GET = apiHandler(async (api, context) => {
  const list = await listServers(api.servers);
  if (list.migrations.length > 0) getWaitUntil(context.locals)(migratePasswords(api.servers, list.migrations));
  return jsonOk<ServersResponse>({ manageable: api.servers.db !== null, servers: list.servers, limit: MAX_SERVERS });
});

export const POST = apiHandler(async (api, context) => {
  const body = await readJsonBody(context.request);
  if (!body.ok) return body.response;
  const r = await createServer(await mutationContext(api, context.request), body.body);
  return r.ok ? jsonResponse({ ok: true, data: r.data }, 201) : jsonError(r.code, r.opts);
});

export const ALL = methodNotAllowedRoute;
