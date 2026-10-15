// GET /api/audit?limit=50&before=<id> → AuditResponse(D1 が使えなければ 200 で available: false。RCON は呼ばない)
import { AUDIT_PAGE_MAX } from '../../types/api';
import type { AuditResponse } from '../../types/api';
import { listAudit } from '../../lib/audit';
import { jsonError, jsonOk } from '../../lib/http';
import { apiHandler, methodNotAllowedRoute } from '../../lib/runtime';
import { parseAuditQuery } from '../../lib/validate';

export const GET = apiHandler(async (api, context) => {
  const q = parseAuditQuery(new URL(context.request.url), AUDIT_PAGE_MAX);
  if (!q.ok) return jsonError('VALIDATION_FAILED', { fields: q.fields });
  const db = api.state.db;
  if (!db) return jsonOk<AuditResponse>({ available: false, entries: [], nextBefore: null });
  const page = await listAudit(db, { limit: q.limit, before: q.before });
  return jsonOk<AuditResponse>({ available: true, ...page });
});

export const ALL = methodNotAllowedRoute;
