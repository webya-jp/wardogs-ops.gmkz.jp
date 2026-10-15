// 書き込み操作の二段階(prepare → execute)。docs/ARCHITECTURE.md 4.3・7 章・15.6、docs/API.md 4 章。
// D1・鍵・fetch は引数で受け取る(cloudflare:workers に依存させない)。D1 は必須(監査ログを必ず通す。7.4)。
// 対象サーバーは本文の `server`(必須)。prepare・execute のそれぞれで D1 から解決し直す(isolate にキャッシュしない)。
// 書き込みを止めている(features.writes が false。D1 必須化で通常は起きない)場合の WRITES_DISABLED は API ページ側で返す。
import type {
  ActionRequest,
  ApiErrorCode,
  CapabilityState,
  ExecuteResponse,
  PrepareResponse,
  ServerId,
  ValidationIssue,
  WriteAction,
} from '../types/api';
import { finishAudit, insertPending, lastKnownName, recordRejected } from './audit';
import { confirmTokenBaseValid, issueConfirmToken, verifyConfirmToken } from './confirm';
import { isPlainObject } from './http';
import type { ErrorOptions } from './http';
import type { DerivedKeys } from './keys';
import { rconRequest, READ_TIMEOUT_MS, WRITE_TIMEOUT_MS } from './rcon/client';
import type { ClientDeps, RconResult } from './rcon/client';
import { getCapabilities, invalidateCapabilities } from './rcon/capabilities';
import { normalizeMaps, normalizePlayers } from './rcon/normalize';
import { buildWriteRequest, READ_ROUTES, routeKey } from './rcon/routes';
import { parseServerParam, resolveServer } from './servers';
import type { ResolvedServer, ServerContext } from './servers';
import type { SessionData } from './session';
import { isDestructive, isWriteAction, targetSteamIdOf, validateActionRequest } from './validate';

function actionOf(body: unknown): WriteAction | null {
  return isPlainObject(body) && isWriteAction(body.action) ? body.action : null;
}

export type ActionOutcome<T> = { ok: true; data: T } | { ok: false; code: ApiErrorCode; opts?: ErrorOptions };

export interface ActionContext {
  keys: DerivedKeys;
  /** 対象サーバーの解決に使う(D1・暗号鍵) */
  servers: ServerContext;
  session: SessionData;
  /** D1(監査ログ) */
  db: D1Database;
  ipHash: string | null;
  deps?: ClientDeps;
  now?: number;
}

function fromRcon(server: ResolvedServer, r: Extract<RconResult, { ok: false }>): ActionOutcome<never> {
  const opts: ErrorOptions = {};
  if (r.retryAfterSec !== undefined) opts.retryAfterSec = r.retryAfterSec;
  if (r.rconMessage !== undefined) opts.rconMessage = r.rconMessage;
  if (r.code === 'RCON_ROUTE_NOT_FOUND') invalidateCapabilities(server.id);
  return { ok: false, code: r.code, opts };
}

/** 監査ログに残す対象サーバー。解決できなかった場合も、指定された id は残す(名前は不明) */
interface RejectServer {
  serverId: number | null;
  serverName: string | null;
}

function rejectServerOf(server: ResolvedServer | ServerId | null): RejectServer {
  if (server === null) return { serverId: null, serverName: null };
  if (typeof server === 'string') return { serverId: Number(server), serverName: null };
  return { serverId: server.auditServerId, serverName: server.name };
}

/**
 * RCON を呼ぶ前の拒否を監査ログに 1 行残して返す(action が分からないものは event に入れられないので記録しない)。
 * 記録に失敗しても拒否の応答は変えない
 */
async function reject<T>(
  ctx: ActionContext,
  action: WriteAction | null,
  params: Record<string, unknown>,
  code: ApiErrorCode,
  server: ResolvedServer | ServerId | null = null,
): Promise<ActionOutcome<T>> {
  const sessionTag = ctx.session.sid.slice(0, 8);
  if (action) {
    const steamId = typeof params.steamId === 'string' ? params.steamId : null;
    await recordRejected(ctx.db, {
      now: ctx.now ?? Date.now(),
      event: action,
      operator: ctx.session.operator,
      sessionTag,
      ipHash: ctx.ipHash,
      targetSteamId: steamId,
      params,
      errorCode: code,
      ...rejectServerOf(server),
    }).catch(() => undefined);
  }
  return { ok: false, code };
}

function invalid(fields: Record<string, ValidationIssue>): ActionOutcome<never> {
  return { ok: false, code: 'VALIDATION_FAILED', opts: { fields } };
}

/** action / params と server をまとめて検証する(入力検証の失敗は記録しない) */
function validateWithServer(body: unknown):
  | { ok: true; request: ActionRequest; server: ServerId }
  | { ok: false; fields: Record<string, ValidationIssue> } {
  const v = validateActionRequest(body);
  const sv = parseServerParam(isPlainObject(body) ? body.server : undefined);
  const fields: Record<string, ValidationIssue> = v.ok ? {} : { ...v.fields };
  if (!sv.ok) fields.server = sv.issue;
  if (!v.ok || !sv.ok) return { ok: false, fields };
  return { ok: true, request: v.request, server: sv.id };
}

export async function prepareAction(ctx: ActionContext, body: unknown): Promise<ActionOutcome<PrepareResponse>> {
  const v = validateWithServer(body);
  if (!v.ok) return invalid(v.fields);
  const req = v.request;

  const resolved = await resolveServer(ctx.servers, v.server);
  if (!resolved.ok) return resolved;
  const server = resolved.data;

  const caps = await getCapabilities({ serverId: server.id, rcon: server.rcon }, ctx.deps);
  const capability: CapabilityState = caps.write[req.action];
  if (capability === 'missing') {
    return reject(ctx, req.action, req.params as Record<string, unknown>, 'CAPABILITY_MISSING', server);
  }

  // 対象の名前解決
  let targetName: string | null = null;
  const sid = targetSteamIdOf(req);
  if (req.action === 'kick' || req.action === 'ban' || req.action === 'message') {
    const r = await rconRequest(server.rcon, { route: READ_ROUTES.players, path: READ_ROUTES.players.template, timeoutMs: READ_TIMEOUT_MS }, ctx.deps);
    if (!r.ok) return fromRcon(server, r);
    const players = normalizePlayers(r.data, Date.now());
    if (!players) return { ok: false, code: 'RCON_BAD_RESPONSE' };
    const found = players.players.find((p) => p.steamId === sid);
    if (!found) return invalid({ steamId: 'not_online' });
    targetName = found.name || null;
  } else if (req.action === 'unban' && sid) {
    // Steam ID は全サーバー共通なので、サーバーで絞らずに引く(15.6)
    targetName = await lastKnownName(ctx.db, sid).catch(() => null);
  } else if (req.action === 'map') {
    // catalog が取れた場合だけ、その id に含まれることを確かめる
    const r = await rconRequest(server.rcon, { route: READ_ROUTES.maps, path: READ_ROUTES.maps.template, timeoutMs: READ_TIMEOUT_MS }, ctx.deps);
    const maps = r.ok ? normalizeMaps(r.data, Date.now()) : null;
    if (maps && maps.maps.length > 0 && !maps.maps.some((m) => m.id === req.params.map)) return invalid({ map: 'unknown_map' });
  }

  const { token, expiresAt } = await issueConfirmToken(ctx.keys.confirm, {
    action: req.action,
    params: req.params,
    sid: ctx.session.sid,
    targetName,
    server: server.id,
    baseUrl: server.rcon.baseUrl,
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
      server: server.id,
    },
  };
}

export async function executeAction(ctx: ActionContext, body: unknown): Promise<ActionOutcome<ExecuteResponse>> {
  // server は必須(入力検証の失敗として扱い、記録しない)
  const sv = parseServerParam(isPlainObject(body) ? body.server : undefined);
  if (!sv.ok) return invalid({ server: sv.issue });
  const v = validateActionRequest(isPlainObject(body) ? { action: body.action, params: body.params } : null);
  // prepare で検証済みの params と一致するはずなので、検証に通らないものはトークン不一致として扱う。
  // action が分からないもの(event に入れられない)は記録しない
  if (!isPlainObject(body) || typeof body.confirmToken !== 'string' || !v.ok) {
    return reject(ctx, actionOf(body), v.ok ? (v.request.params as Record<string, unknown>) : {}, 'CONFIRM_INVALID', sv.id);
  }
  const req: ActionRequest = v.request;
  const params = req.params as Record<string, unknown>;
  const now = ctx.now ?? Date.now();
  const base = { action: req.action, params: req.params, sid: ctx.session.sid };

  // 3' の前提: 対象サーバーを解決し直す。失敗したら(1〜3 が通っていれば)SERVER_* で拒否して記録する
  const resolved = await resolveServer(ctx.servers, sv.id);
  if (!resolved.ok) {
    const code = (await confirmTokenBaseValid(ctx.keys.confirm, body.confirmToken, base)) ? resolved.code : 'CONFIRM_INVALID';
    return reject(ctx, req.action, params, code, sv.id);
  }
  const server = resolved.data;

  const tk = await verifyConfirmToken(ctx.keys.confirm, body.confirmToken, {
    ...base,
    server: server.id,
    baseUrl: server.rcon.baseUrl,
    now,
  });
  if (!tk.ok) return reject(ctx, req.action, params, tk.code, server);

  const built = buildWriteRequest(req.action, req.params);
  const route = routeKey(built.route);
  const sessionTag = ctx.session.sid.slice(0, 8);

  // 実行前に pending で記録する(nonce の UNIQUE で 1 回限り)
  let auditId: number;
  try {
    const inserted = await insertPending(ctx.db, {
      now,
      event: req.action,
      operator: ctx.session.operator,
      sessionTag,
      ipHash: ctx.ipHash,
      targetSteamId: targetSteamIdOf(req),
      targetName: tk.targetName,
      params,
      rconRoute: route,
      nonce: tk.nonce,
      serverId: server.auditServerId,
      serverName: server.name,
    });
    if (inserted === 'duplicate') return { ok: false, code: 'ALREADY_EXECUTED' };
    auditId = inserted;
  } catch {
    // 記録できないなら実行しない(監査ログを必ず通す)
    return { ok: false, code: 'INTERNAL_ERROR' };
  }

  // RCON を 1 回だけ呼ぶ(再試行しない)
  const r = await rconRequest(
    server.rcon,
    { route: built.route, path: built.path, body: built.body, timeoutMs: WRITE_TIMEOUT_MS, allowNonJson: true },
    ctx.deps,
  );
  const finishedAt = Date.now();
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
  if (!r.ok) return fromRcon(server, r);
  return { ok: true, data: { auditId, action: req.action, executedAt: finishedAt, server: server.id } };
}
