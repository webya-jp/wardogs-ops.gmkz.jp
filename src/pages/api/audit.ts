// GET /api/audit?kind=operations|settings&server=all|<id>&limit=50&before=<id> → AuditResponse
// D1 必須化により available は常に true。RCON は呼ばない。存在しない server でもエラーにせず 0 件(docs/API.md 3 章)
import { AUDIT_PAGE_MAX } from '../../types/api';
import type { AuditResponse } from '../../types/api';
import { listAudit, listSettingsAudit } from '../../lib/audit';
import { jsonError, jsonOk } from '../../lib/http';
import { apiHandler, methodNotAllowedRoute } from '../../lib/runtime';
import { parseAuditQuery } from '../../lib/validate';

export const GET = apiHandler(async (api, context) => {
  const q = parseAuditQuery(new URL(context.request.url), AUDIT_PAGE_MAX);
  if (!q.ok) return jsonError('VALIDATION_FAILED', { fields: q.fields });
  const db = api.db;
  const query = { limit: q.limit, before: q.before, server: q.server };
  const page = q.kind === 'settings' ? await listSettingsAudit(db, query) : await listAudit(db, query);
  return jsonOk<AuditResponse>({ available: true, kind: q.kind, ...page });
});

export const ALL = methodNotAllowedRoute;
