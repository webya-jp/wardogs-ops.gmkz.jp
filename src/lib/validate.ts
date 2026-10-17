// 書き込み操作の入力検証と正規化。docs/ARCHITECTURE.md 7.2、docs/API.md 4 章。
// 接続中かどうか(not_online)・マップ一覧にあるか(unknown_map)は RCON の結果が要るため actions 側で判定する。
import {
  AUDIT_KINDS,
  MATCH_ID_PATTERN,
  MESSAGE_MAX_LENGTH,
  REASON_MAX_LENGTH,
  RECORDING_ACTIONS,
  SERVER_ID_PATTERN,
  STEAM_ID_PATTERN,
  WRITE_ACTIONS,
} from '../types/api';
import type {
  ActionParamsMap,
  ActionRequest,
  AuditKind,
  ConfirmableAction,
  RecordingAction,
  RecordingActionRequest,
  ServerId,
  ValidationIssue,
  WriteAction,
} from '../types/api';
import { isPlainObject } from './http';

export const MAP_ID_PATTERN = /^[A-Za-z0-9_./-]{1,128}$/;

/** 改行(\n \r)を含む制御文字と、行区切り・段落区切り */
const CONTROL_RE = /[\p{Cc}\u2028\u2029]/u;

export function isWriteAction(v: unknown): v is WriteAction {
  return typeof v === 'string' && (WRITE_ACTIONS as readonly string[]).includes(v);
}

/** スコア記録の開始・停止(docs/ARCHITECTURE.md 17.2。WriteAction とは別系列) */
export function isRecordingAction(v: unknown): v is RecordingAction {
  return typeof v === 'string' && (RECORDING_ACTIONS as readonly string[]).includes(v);
}

/** prepare / execute が受け付ける操作(確認トークンの `a`) */
export function isConfirmableAction(v: unknown): v is ConfirmableAction {
  return isWriteAction(v) || isRecordingAction(v);
}

export function isSteamId(v: unknown): v is string {
  return typeof v === 'string' && STEAM_ID_PATTERN.test(v);
}

function cpLength(s: string): number {
  return Array.from(s).length;
}

type FieldResult<T> = { ok: true; value: T } | { ok: false; issue: ValidationIssue };

export function validateSteamId(v: unknown): FieldResult<string> {
  if (v === undefined || v === null || v === '') return { ok: false, issue: 'required' };
  if (typeof v !== 'string') return { ok: false, issue: 'invalid_format' };
  const s = v.trim();
  return STEAM_ID_PATTERN.test(s) ? { ok: true, value: s } : { ok: false, issue: 'invalid_format' };
}

/** broadcast / message の本文: 前後の空白を除いて 1〜256 文字、改行・制御文字不可 */
export function validateMessage(v: unknown): FieldResult<string> {
  if (v === undefined || v === null) return { ok: false, issue: 'required' };
  if (typeof v !== 'string') return { ok: false, issue: 'invalid_format' };
  if (CONTROL_RE.test(v)) return { ok: false, issue: 'invalid_characters' };
  const s = v.trim();
  if (s === '') return { ok: false, issue: 'required' };
  if (cpLength(s) > MESSAGE_MAX_LENGTH) return { ok: false, issue: 'too_long' };
  return { ok: true, value: s };
}

/** kick / ban の理由(任意): 200 文字まで、改行・制御文字不可。空なら undefined */
export function validateReason(v: unknown): FieldResult<string | undefined> {
  if (v === undefined || v === null) return { ok: true, value: undefined };
  if (typeof v !== 'string') return { ok: false, issue: 'invalid_format' };
  if (CONTROL_RE.test(v)) return { ok: false, issue: 'invalid_characters' };
  const s = v.trim();
  if (s === '') return { ok: true, value: undefined };
  if (cpLength(s) > REASON_MAX_LENGTH) return { ok: false, issue: 'too_long' };
  return { ok: true, value: s };
}

export function validateMapId(v: unknown): FieldResult<string> {
  if (v === undefined || v === null || v === '') return { ok: false, issue: 'required' };
  if (typeof v !== 'string') return { ok: false, issue: 'invalid_format' };
  const s = v.trim();
  return MAP_ID_PATTERN.test(s) ? { ok: true, value: s } : { ok: false, issue: 'invalid_format' };
}

export type ActionValidation =
  | { ok: true; request: ActionRequest }
  | { ok: false; fields: Record<string, ValidationIssue> };

/** { action, params } を検証し、正規化した params(余分な項目は捨てる)を返す */
export function validateActionRequest(body: unknown): ActionValidation {
  if (!isPlainObject(body)) return { ok: false, fields: { action: 'required' } };
  const action = body.action;
  if (!isWriteAction(action)) {
    return { ok: false, fields: { action: action === undefined ? 'required' : 'invalid_format' } };
  }
  const p = body.params === undefined ? {} : body.params;
  if (!isPlainObject(p)) return { ok: false, fields: { params: 'invalid_format' } };

  const fields: Record<string, ValidationIssue> = {};
  const take = <T>(name: string, r: FieldResult<T>): T | undefined => {
    if (r.ok) return r.value;
    fields[name] = r.issue;
    return undefined;
  };

  let params: ActionParamsMap[WriteAction] | undefined;
  switch (action) {
    case 'kick':
    case 'ban': {
      const steamId = take('steamId', validateSteamId(p.steamId));
      const reason = take('reason', validateReason(p.reason));
      if (steamId !== undefined) params = reason === undefined ? { steamId } : { steamId, reason };
      break;
    }
    case 'unban': {
      const steamId = take('steamId', validateSteamId(p.steamId));
      if (steamId !== undefined) params = { steamId };
      break;
    }
    case 'broadcast': {
      const message = take('message', validateMessage(p.message));
      if (message !== undefined) params = { message };
      break;
    }
    case 'message': {
      const steamId = take('steamId', validateSteamId(p.steamId));
      const message = take('message', validateMessage(p.message));
      if (steamId !== undefined && message !== undefined) params = { steamId, message };
      break;
    }
    case 'map': {
      const map = take('map', validateMapId(p.map));
      if (map !== undefined) params = { map };
      break;
    }
    case 'match_end':
      params = {};
      break;
  }
  if (Object.keys(fields).length > 0 || params === undefined) {
    return { ok: false, fields: Object.keys(fields).length > 0 ? fields : { params: 'invalid_format' } };
  }
  return { ok: true, request: { action, params } as ActionRequest };
}

export type RecordingValidation =
  | { ok: true; request: RecordingActionRequest }
  | { ok: false; fields: Record<string, ValidationIssue> };

/**
 * { action: record_start | record_stop, params } を検証する(docs/API.md 4.1)。
 * record_start の params は空に正規化する(余分な項目は捨てる)。record_stop は recordingId(MATCH_ID_PATTERN)が必須
 */
export function validateRecordingRequest(body: unknown): RecordingValidation {
  if (!isPlainObject(body)) return { ok: false, fields: { action: 'required' } };
  const action = body.action;
  if (!isRecordingAction(action)) {
    return { ok: false, fields: { action: action === undefined ? 'required' : 'invalid_format' } };
  }
  const p = body.params === undefined ? {} : body.params;
  if (!isPlainObject(p)) return { ok: false, fields: { params: 'invalid_format' } };
  if (action === 'record_start') return { ok: true, request: { action, params: {} } };
  const id = p.recordingId;
  if (id === undefined || id === null || id === '') return { ok: false, fields: { recordingId: 'required' } };
  if (typeof id !== 'string' || !MATCH_ID_PATTERN.test(id)) return { ok: false, fields: { recordingId: 'invalid_format' } };
  return { ok: true, request: { action, params: { recordingId: id } } };
}

/** 対象プレイヤーがいる操作か */
export function targetSteamIdOf(req: ActionRequest): string | null {
  return 'steamId' in req.params && typeof req.params.steamId === 'string' ? req.params.steamId : null;
}

/** 影響の大きい操作(docs/ARCHITECTURE.md 7.3) */
export function isDestructive(action: WriteAction): boolean {
  return action === 'ban' || action === 'map' || action === 'match_end';
}

/** /api/audit の kind / server / limit / before(docs/API.md 3 章) */
export function parseAuditQuery(url: URL, max: number):
  | { ok: true; kind: AuditKind; server: 'all' | ServerId; limit: number; before: number | null }
  | { ok: false; fields: Record<string, ValidationIssue> } {
  const fields: Record<string, ValidationIssue> = {};
  const ls = url.searchParams.get('limit');
  const bs = url.searchParams.get('before');
  const ks = url.searchParams.get('kind');
  const ss = url.searchParams.get('server');
  let limit = 50;
  let before: number | null = null;
  let kind: AuditKind = 'operations';
  let server: 'all' | ServerId = 'all';
  if (ls !== null && ls !== '') {
    if (!/^\d{1,4}$/.test(ls) || Number(ls) < 1 || Number(ls) > max) fields.limit = 'invalid_format';
    else limit = Number(ls);
  }
  if (bs !== null && bs !== '') {
    if (!/^\d{1,15}$/.test(bs)) fields.before = 'invalid_format';
    else before = Number(bs);
  }
  if (ks !== null && ks !== '') {
    if ((AUDIT_KINDS as readonly string[]).includes(ks)) kind = ks as AuditKind;
    else fields.kind = 'invalid_format';
  }
  if (ss !== null && ss !== '') {
    if (ss === 'all' || SERVER_ID_PATTERN.test(ss)) server = ss;
    else fields.server = 'invalid_format';
  }
  return Object.keys(fields).length > 0 ? { ok: false, fields } : { ok: true, kind, server, limit, before };
}
