// 書き込み操作の二段階(prepare → execute)。docs/ARCHITECTURE.md 4.3・7 章、docs/API.md 4 章。
// env・D1・fetch は引数で受け取る(cloudflare:workers に依存させない)。
import type {
  ActionRequest,
  ApiErrorCode,
  CapabilityState,
  ExecuteResponse,
  PrepareResponse,
  ValidationIssue,
} from '../types/api';
import { finishAudit, insertPending, lastKnownName, logWithoutAudit } from './audit';
import type { RconConfig } from './config';
import { claimNonceInMemory, issueConfirmToken, verifyConfirmToken } from './confirm';
import { isPlainObject } from './http';
import type { ErrorOptions } from './http';
import type { DerivedKeys } from './keys';
import { rconRequest, READ_TIMEOUT_MS, WRITE_TIMEOUT_MS } from './rcon/client';
import type { ClientDeps, RconResult } from './rcon/client';
import { getCapabilities, invalidateCapabilities } from './rcon/capabilities';
import { normalizeMaps, normalizePlayers } from './rcon/normalize';
import { buildWriteRequest, READ_ROUTES, routeKey } from './rcon/routes';
import type { SessionData } from './session';
import { isDestructive, targetSteamIdOf, validateActionRequest } from './validate';

export type ActionOutcome<T> = { ok: true; data: T } | { ok: false; code: ApiErrorCode; opts?: ErrorOptions };

export interface ActionContext {
  keys: DerivedKeys;
  rcon: RconConfig;
  session: SessionData;
  /** D1 が使えるときだけ非 null */
  db: D1Database | null;
  /** features.writes */
  writesEnabled: boolean;
  ipHash: string | null;
  deps?: ClientDeps;
  now?: number;
}

function fromRcon(r: Extract<RconResult, { ok: false }>): ActionOutcome<never> {
  const opts: ErrorOptions = {};
  if (r.retryAfterSec !== undefined) opts.retryAfterSec = r.retryAfterSec;
  if (r.rconMessage !== undefined) opts.rconMessage = r.rconMessage;
  if (r.code === 'RCON_ROUTE_NOT_FOUND') invalidateCapabilities();
  return { ok: false, code: r.code, opts };
}

function invalid(fields: Record<string, ValidationIssue>): ActionOutcome<never> {
  return { ok: false, code: 'VALIDATION_FAILED', opts: { fields } };
}

export async function prepareAction(ctx: ActionContext, body: unknown): Promise<ActionOutcome<PrepareResponse>> {
  if (!ctx.writesEnabled) return { ok: false, code: 'WRITES_DISABLED' };
  const v = validateActionRequest(body);
  if (!v.ok) return invalid(v.fields);
  const req = v.request;

  const caps = await getCapabilities(ctx.rcon, ctx.deps);
  const capability: CapabilityState = caps.write[req.action];
  if (capability === 'missing') return { ok: false, code: 'CAPABILITY_MISSING' };

  // 対象の名前解決
  let targetName: string | null = null;
  const sid = targetSteamIdOf(req);
  if (req.action === 'kick' || req.action === 'ban' || req.action === 'message') {
    const r = await rconRequest(ctx.rcon, { route: READ_ROUTES.players, path: READ_ROUTES.players.template, timeoutMs: READ_TIMEOUT_MS }, ctx.deps);
    if (!r.ok) return fromRcon(r);
    const players = normalizePlayers(r.data, Date.now());
    if (!players) return { ok: false, code: 'RCON_BAD_RESPONSE' };
    const found = players.players.find((p) => p.steamId === sid);
    if (!found) return invalid({ steamId: 'not_online' });
    targetName = found.name || null;
  } else if (req.action === 'unban' && sid && ctx.db) {
    targetName = await lastKnownName(ctx.db, sid).catch(() => null);
  } else if (req.action === 'map') {
    // catalog が取れた場合だけ、その id に含まれることを確かめる
    const r = await rconRequest(ctx.rcon, { route: READ_ROUTES.maps, path: READ_ROUTES.maps.template, timeoutMs: READ_TIMEOUT_MS }, ctx.deps);
    const maps = r.ok ? normalizeMaps(r.data, Date.now()) : null;
    if (maps && maps.maps.length > 0 && !maps.maps.some((m) => m.id === req.params.map)) return invalid({ map: 'unknown_map' });
  }

  const { token, expiresAt } = await issueConfirmToken(ctx.keys.confirm, {
    action: req.action,
    params: req.params,
    sid: ctx.session.sid,
    targetName,
    now: ctx.now,
  });
  return {
    ok: true,
    data: {
      confirmToken: token,
      action: req.action,
      params: req.params,
      targetName,
      destructive: isDestructive(req.action),
      capability,
      expiresAt,
    },
  };
}

export async function executeAction(ctx: ActionContext, body: unknown): Promise<ActionOutcome<ExecuteResponse>> {
  if (!ctx.writesEnabled) return { ok: false, code: 'WRITES_DISABLED' };
  if (!isPlainObject(body) || typeof body.confirmToken !== 'string') return { ok: false, code: 'CONFIRM_INVALID' };
  const v = validateActionRequest({ action: body.action, params: body.params });
  // prepare で検証済みの params と一致するはずなので、検証に通らないものはトークン不一致として扱う
  if (!v.ok) return { ok: false, code: 'CONFIRM_INVALID' };
  const req: ActionRequest = v.request;

  const now = ctx.now ?? Date.now();
  const tk = await verifyConfirmToken(ctx.keys.confirm, body.confirmToken, {
    action: req.action,
    params: req.params,
    sid: ctx.session.sid,
    now,
  });
  if (!tk.ok) return { ok: false, code: tk.code };

  const built = buildWriteRequest(req.action, req.params);
  const route = routeKey(built.route);
  const sessionTag = ctx.session.sid.slice(0, 8);

  // 実行前に pending で記録する(nonce の UNIQUE で 1 回限り)
  let auditId: number | null = null;
  if (ctx.db) {
    let inserted: number | 'duplicate';
    try {
      inserted = await insertPending(ctx.db, {
        now,
        event: req.action,
        operator: ctx.session.operator,
        sessionTag,
        ipHash: ctx.ipHash,
        targetSteamId: targetSteamIdOf(req),
        targetName: tk.targetName,
        params: req.params as Record<string, unknown>,
        rconRoute: route,
        nonce: tk.nonce,
      });
    } catch {
      // 記録できないなら実行しない(監査ログを必ず通す)
      return { ok: false, code: 'INTERNAL_ERROR' };
    }
    if (inserted === 'duplicate') return { ok: false, code: 'ALREADY_EXECUTED' };
    auditId = inserted;
  } else if (!claimNonceInMemory(tk.nonce, tk.expiresAt, now)) {
    return { ok: false, code: 'ALREADY_EXECUTED' };
  }

  // RCON を 1 回だけ呼ぶ(再試行しない)
  const r = await rconRequest(
    ctx.rcon,
    { route: built.route, path: built.path, body: built.body, timeoutMs: WRITE_TIMEOUT_MS, allowNonJson: true },
    ctx.deps,
  );
  const finishedAt = Date.now();
  if (ctx.db && auditId !== null) {
    try {
      await finishAudit(ctx.db, auditId, {
        status: r.ok ? 'succeeded' : 'failed',
        now: finishedAt,
        rconStatus: r.status,
        errorCode: r.ok ? null : r.code,
      });
    } catch {
      // UPDATE に失敗しても pending の行は残る(画面は 1 分以上の pending を「結果不明」と表示する)
    }
  } else {
    logWithoutAudit(req.action, r.ok ? 'OK' : r.code, sessionTag);
  }
  if (!r.ok) return fromRcon(r);
  return { ok: true, data: { auditId, action: req.action, executedAt: finishedAt } };
}

