// POST /api/servers/:id/test → ServerMutationResponse(docs/API.md 7 章)
// 本文 {}(JSON 必須)。保存済みの設定で接続テスト(RCON GET /v1/status、5 秒)。同じサーバーは 5 秒に 1 回まで(429)。
// RCON 側の失敗はエラー応答にせず 200 で test.ok: false
import { jsonError, jsonOk, readJsonBody } from '../../../../lib/http';
import { apiHandler, methodNotAllowedRoute } from '../../../../lib/runtime';
import { testServer } from '../../../../lib/servers';
import { mutationContext } from '../../../../lib/server-api';

export const POST = apiHandler(async (api, context) => {
  const body = await readJsonBody(context.request);
  if (!body.ok) return body.response;
  const r = await testServer(await mutationContext(api, context.request), context.params.id);
  return r.ok ? jsonOk(r.data) : jsonError(r.code, r.opts);
});

export const ALL = methodNotAllowedRoute;
