// GET /api/feed/raw?server=<id>&limit=20&before=<id> → FeedRawResponse(docs/API.md 9 章)。ログイン必須。
// 本文は受けた JSON 文字列のまま(Steam ID・プレイヤー名を含み得る。画面はテキストとして表示する)
import type { FeedRawResponse } from '../../../types/api';
import { listFeedRaw, parseFeedRawQuery } from '../../../lib/feed';
import { jsonError, jsonOk } from '../../../lib/http';
import { apiHandler, methodNotAllowedRoute } from '../../../lib/runtime';

export const GET = apiHandler(async (api, context) => {
  const q = parseFeedRawQuery(new URL(context.request.url));
  if (!q.ok) return jsonError('VALIDATION_FAILED', { fields: q.fields });
  return jsonOk<FeedRawResponse>(await listFeedRaw(api.db, q));
});

export const ALL = methodNotAllowedRoute;
