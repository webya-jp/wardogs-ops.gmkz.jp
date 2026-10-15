// /api/servers/* のハンドラの共通部分(操作者の情報を変更ログ用にまとめる)。
import { clientIp } from './http';
import { hashClientIp } from './keys';
import type { ApiContext } from './runtime';
import type { MutationContext } from './servers';

export async function mutationContext(api: ApiContext, request: Request): Promise<MutationContext> {
  return {
    sctx: api.servers,
    actor: {
      operator: api.session.operator,
      sessionTag: api.session.sid.slice(0, 8),
      ipHash: await hashClientIp(api.keys, clientIp(request)),
    },
  };
}
