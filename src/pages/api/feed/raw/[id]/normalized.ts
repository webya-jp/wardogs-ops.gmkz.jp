// GET /api/feed/raw/:id/normalized?server=<id> → FeedNormalizePreviewResponse(docs/API.md 11.2)。ログイン必須。
// 保存済みの生データ 1 件に、今の対応表(src/lib/killfeed/fields.ts)で正規化を試す。**何も保存しない**。
// 正規化の値は Steam ID・プレイヤー名を含む(生データと同じ扱い)
import type { FeedNormalizePreviewResponse, ValidationIssue } from '../../../../../types/api';
import { jsonError, jsonOk } from '../../../../../lib/http';
import { previewRawNormalized } from '../../../../../lib/killfeed/store';
import { apiHandler, methodNotAllowedRoute } from '../../../../../lib/runtime';
import { parseServerParam } from '../../../../../lib/servers';

export const GET = apiHandler(async (api, context) => {
  const id = context.params.id;
  const fields: Record<string, ValidationIssue> = {};
  if (typeof id !== 'string' || !/^[1-9][0-9]{0,15}$/.test(id) || !Number.isSafeInteger(Number(id))) fields.id = 'invalid_format';
  const sv = parseServerParam(new URL(context.request.url).searchParams.get('server'));
  if (!sv.ok) fields.server = sv.issue;
  if (Object.keys(fields).length > 0 || !sv.ok) return jsonError('VALIDATION_FAILED', { fields });
  const r = await previewRawNormalized(api.db, sv.id, Number(id));
  return r ? jsonOk<FeedNormalizePreviewResponse>(r) : jsonError('NOT_FOUND');
});

export const ALL = methodNotAllowedRoute;
