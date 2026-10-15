/**
 * Worker 内部 API(/api/*)の契約。docs/API.md と同期(変更は architect 経由)。
 * - 応答はすべて ApiResponse<T>(JSON、UTF-8、Cache-Control: no-store)
 * - 時刻は UTC epoch ミリ秒の number。画面では JST に変換して表示する
 * - RCON の応答は Worker で正規化してから返す(生の応答は返さない)
 * - RCON の仕様は非公式資料ベース(docs/research/wardogs-rcon.md)。確度は docs/API.md 第 6 章
 * - 多言語化(docs/ARCHITECTURE.md 第 13 章): API は表示用の文言を返さない。エラーは機械可読な
 *   コード(ApiErrorCode / ValidationIssue)で返し、画面は src/i18n のカタログで文言を引く
 */

// ============================================================
// 共通
// ============================================================

export type ApiSuccess<T> = { ok: true; data: T };
export type ApiFailure = {
  ok: false;
  error: {
    code: ApiErrorCode;
    /**
     * 開発者向けの英語固定の短い説明(例 "RCON request timed out")。画面には出さない(画面は code でカタログを引く)。
     * Secrets・接続先・内部例外の文字列・入力値を含めない
     */
    message?: string;
    /** VALIDATION_FAILED のときの項目別の理由コード(キーは params の項目名) */
    fields?: Record<string, ValidationIssue>;
    /** RATE_LIMITED / RCON_RATE_LIMITED のとき、再試行までの秒数 */
    retryAfterSec?: number;
    /** RCON_REJECTED のとき、RCON が返したエラー文(200 文字に切り詰め、制御文字を除去)。RCON の生データなので翻訳しない */
    rconMessage?: string;
  };
};
export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;

export const API_ERROR_CODES = [
  // リクエスト・認証
  'BAD_REQUEST',
  'VALIDATION_FAILED',
  'UNAUTHENTICATED',
  'FORBIDDEN_ORIGIN',
  'NOT_FOUND',
  'METHOD_NOT_ALLOWED',
  'PAYLOAD_TOO_LARGE',
  'UNSUPPORTED_MEDIA_TYPE',
  'RATE_LIMITED',
  // 確認トークン
  'CONFIRM_INVALID',
  'CONFIRM_EXPIRED',
  'ALREADY_EXECUTED',
  // 機能の可否
  'CAPABILITY_MISSING',
  'WRITES_DISABLED',
  'NOT_CONFIGURED',
  // RCON
  'RCON_UNREACHABLE',
  'RCON_TIMEOUT',
  'RCON_AUTH_FAILED',
  'RCON_RATE_LIMITED',
  'RCON_ROUTE_NOT_FOUND',
  'RCON_REJECTED',
  'RCON_BAD_RESPONSE',
  'RCON_ERROR',
  // その他
  'INTERNAL_ERROR',
] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export const API_ERROR_STATUS: Record<ApiErrorCode, number> = {
  BAD_REQUEST: 400,
  VALIDATION_FAILED: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN_ORIGIN: 403,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  RATE_LIMITED: 429,
  CONFIRM_INVALID: 400,
  CONFIRM_EXPIRED: 409,
  ALREADY_EXECUTED: 409,
  CAPABILITY_MISSING: 409,
  WRITES_DISABLED: 503,
  NOT_CONFIGURED: 503,
  RCON_UNREACHABLE: 502,
  RCON_TIMEOUT: 504,
  RCON_AUTH_FAILED: 502,
  RCON_RATE_LIMITED: 503,
  RCON_ROUTE_NOT_FOUND: 502,
  RCON_REJECTED: 422,
  RCON_BAD_RESPONSE: 502,
  RCON_ERROR: 502,
  INTERNAL_ERROR: 500,
};

/** VALIDATION_FAILED の項目別の理由。表示文言は src/i18n の `validation.<code>` で引く */
export const VALIDATION_ISSUES = [
  'required',
  'too_long',
  'invalid_format',
  'invalid_characters',
  'not_online',
  'unknown_map',
] as const;
export type ValidationIssue = (typeof VALIDATION_ISSUES)[number];

/** /api/* のリクエスト本文の上限(バイト) */
export const MAX_REQUEST_BYTES = 8 * 1024;

// ============================================================
// 定数(入力の上限など)
// ============================================================

/**
 * Steam ID の形式。SteamID64(10 進 17 桁)を前提にする。
 * RCON がこの形式で返すかは未検証(docs/ARCHITECTURE.md 要確認 R-9)。違った場合はここだけを直す
 */
export const STEAM_ID_PATTERN = /^[0-9]{17}$/;
/** broadcast / message の上限(文字数、コードポイント単位)。256 は未検証(要確認 R-6) */
export const MESSAGE_MAX_LENGTH = 256;
/** kick / ban の理由の上限(文字数)。RCON 側の上限は不明のため Worker 側で絞る */
export const REASON_MAX_LENGTH = 200;
/** ログイン時に任意入力する操作者名(監査ログ用、自己申告)の上限 */
export const OPERATOR_NAME_MAX_LENGTH = 32;
/** 確認トークンの有効期間(ミリ秒) */
export const CONFIRM_TTL_MS = 120_000;
/** セッションの有効期間(ミリ秒)。延長しない(絶対期限) */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
/** 画面の自動更新の最短間隔(秒)。これより短くしない(docs/ARCHITECTURE.md 11 章) */
export const POLL_MIN_INTERVAL_SEC = 30;
/** /api/audit の 1 回の最大件数 */
export const AUDIT_PAGE_MAX = 100;

// ============================================================
// セッション・機能の可否
// ============================================================

export interface SessionInfo {
  /** セッション ID の先頭 8 文字(監査ログ・画面表示用。全体は出さない) */
  sessionTag: string;
  /** ログイン時に入力した操作者名(自己申告。空なら null) */
  operator: string | null;
  issuedAt: number;
  expiresAt: number;
}

/** 段階的有効化の状態(docs/ARCHITECTURE.md 7.4) */
export interface Features {
  /** D1 に書けて操作ログが残せる */
  audit: boolean;
  /** 人数スナップショットを記録できる(audit と同じ D1 に依存) */
  snapshots: boolean;
  /** 書き込み操作を受け付ける(audit が true、または AUDIT_REQUIRED="false") */
  writes: boolean;
}

/** /setup・画面上部に出す設定の警告(値は含めない) */
export type SetupWarning =
  | 'ADMIN_PASSWORD_MISSING'
  | 'ADMIN_PASSWORD_TOO_SHORT'
  | 'ADMIN_PASSWORD_EQUALS_RCON_PASSWORD'
  | 'RCON_URL_MISSING'
  | 'RCON_URL_INVALID'
  | 'RCON_URL_IS_IP_ADDRESS'
  | 'RCON_URL_HAS_CREDENTIALS'
  | 'RCON_PASSWORD_MISSING'
  | 'RCON_PASSWORD_SHORT'
  | 'SESSION_SECRET_TOO_SHORT'
  | 'D1_MISSING'
  | 'D1_NOT_MIGRATED'
  | 'AUDIT_DISABLED_WRITES_ALLOWED'
  /** 全体のログイン失敗が直近 1 時間で 50 回を超えた(ログインは止めない。docs/ARCHITECTURE.md 5.6) */
  | 'LOGIN_FAILURES_HIGH';

/** GET /api/session */
export interface SessionResponse {
  session: SessionInfo;
  features: Features;
  warnings: SetupWarning[];
}

// ============================================================
// capabilities(RCON の実在ルート)
// ============================================================

/** 本パネルが扱う書き込み操作 */
export const WRITE_ACTIONS = ['kick', 'ban', 'unban', 'broadcast', 'message', 'map', 'match_end'] as const;
export type WriteAction = (typeof WRITE_ACTIONS)[number];

/** 本パネルが扱う読み取り */
export const READ_KINDS = ['status', 'players', 'bans', 'maps'] as const;
export type ReadKind = (typeof READ_KINDS)[number];

/**
 * - available: capabilities の routes に該当ルートがある
 * - missing: capabilities は取れたが該当ルートが無い(ボタンを無効化する)
 * - unknown: capabilities 自体が取れない・形式を解釈できない(ボタンは有効のまま「未確認」と表示し、実行時のエラーで判断)
 */
export type CapabilityState = 'available' | 'missing' | 'unknown';

/** GET /api/capabilities */
export interface CapabilitiesResponse {
  /** capabilities を取得・解釈できたか */
  source: 'rcon' | 'unavailable';
  apiVersion: string | null;
  build: string | null;
  read: Record<ReadKind, CapabilityState>;
  write: Record<WriteAction, CapabilityState>;
  /** RCON が返したルート一覧("METHOD /path" に正規化)。解釈できなかったら空 */
  routes: string[];
  fetchedAt: number;
}

// ============================================================
// 読み取り
// ============================================================

/** GET /api/status(RCON GET /v1/status を正規化) */
export interface StatusResponse {
  serverName: string | null;
  map: string | null;
  players: { current: number | null; max: number | null };
  factionScores: FactionScore[];
  rotation: { nowIndex: number | null; nextIndex: number | null };
  fetchedAt: number;
}

/** 形式は未検証(要確認 R-8)。解釈できない要素は null にする */
export interface FactionScore {
  faction: string | null;
  score: number | null;
}

/** GET /api/players(RCON GET /v1/players を正規化) */
export interface PlayersResponse {
  players: Player[];
  count: number;
  fetchedAt: number;
}

export interface Player {
  /** STEAM_ID_PATTERN に合わない ID の行は操作ボタンを無効にする(画面側で判定) */
  steamId: string;
  name: string;
  faction: string | null;
  kills: number | null;
  deaths: number | null;
  pingMs: number | null;
}

/** GET /api/bans(RCON GET /v1/bans を正規化) */
export interface BansResponse {
  bans: Ban[];
  count: number;
  fetchedAt: number;
}

export interface Ban {
  steamId: string;
  /** RCON の bannedAtUtc を epoch ミリ秒に変換。解釈できなければ null */
  bannedAt: number | null;
  bannedBy: string | null;
  reason: string | null;
  /** このパネルの監査ログに BAN 時の名前が残っていれば補完する(D1 が無ければ null) */
  knownName: string | null;
}

/** GET /api/maps(RCON GET /v1/catalog/maps を正規化) */
export interface MapsResponse {
  maps: { id: string; displayName: string | null }[];
  fetchedAt: number;
}

/** GET /api/audit?limit=&before= */
export interface AuditResponse {
  /** D1 が使えない場合は false(entries は空) */
  available: boolean;
  entries: AuditEntry[];
  /** 次のページを取るときの before に渡す id。無ければ null */
  nextBefore: number | null;
}

export type AuditEventType = WriteAction | 'login' | 'logout';
/**
 * pending のまま 1 分以上経った行は画面で「結果不明」と表示する。
 * `unknown` は API だけの値: RCON がタイムアウトし、実行されたかどうか不明(D1 上は failed + error_code = RCON_TIMEOUT。CHECK 制約は変えない)
 */
export type AuditStatus = 'pending' | 'succeeded' | 'failed' | 'unknown';

export interface AuditEntry {
  id: number;
  createdAt: number;
  finishedAt: number | null;
  event: AuditEventType;
  status: AuditStatus;
  operator: string | null;
  sessionTag: string | null;
  targetSteamId: string | null;
  targetName: string | null;
  /** 操作のパラメータ(検証済みの値のみ)。画面は event + params + targetName からカタログで文言を組み立てる */
  params: Record<string, unknown>;
  /** RCON の HTTP ステータス(呼んでいない・届かなかった場合は null) */
  rconStatus: number | null;
  errorCode: ApiErrorCode | null;
}

// ============================================================
// 書き込み(二段階: prepare → execute)
// ============================================================

export interface KickParams {
  steamId: string;
  reason?: string;
}
export interface BanParams {
  steamId: string;
  reason?: string;
}
export interface UnbanParams {
  steamId: string;
}
export interface BroadcastParams {
  message: string;
}
export interface MessageParams {
  steamId: string;
  message: string;
}
export interface MapParams {
  /** GET /api/maps の id */
  map: string;
}
export type MatchEndParams = Record<string, never>;

export interface ActionParamsMap {
  kick: KickParams;
  ban: BanParams;
  unban: UnbanParams;
  broadcast: BroadcastParams;
  message: MessageParams;
  map: MapParams;
  match_end: MatchEndParams;
}

export type ActionRequest = {
  [A in WriteAction]: { action: A; params: ActionParamsMap[A] };
}[WriteAction];

/** POST /api/actions/prepare の本文 */
export type PrepareRequest = ActionRequest;

/** POST /api/actions/prepare の応答 */
export interface PrepareResponse {
  /** 確認トークン(execute に渡す。1 回限り、CONFIRM_TTL_MS で失効) */
  confirmToken: string;
  /** 確認ダイアログの文言は画面がカタログ(`confirm.<action>`)で組み立てる。Worker は文言を返さない */
  action: WriteAction;
  /** 正規化・検証済みのパラメータ(画面はこれを確認ダイアログに表示する。execute にはこの値を送る) */
  params: ActionParamsMap[WriteAction];
  /** 対象プレイヤーの名前(RCON の一覧または監査ログから引けた場合。RCON の生データなので翻訳しない) */
  targetName: string | null;
  /** 影響の大きい操作か(ban・map・match_end は true)。画面は強調表示する */
  destructive: boolean;
  capability: CapabilityState;
  expiresAt: number;
}

/** POST /api/actions/execute の本文。action・params は prepare と同一であること */
export type ExecuteRequest = ActionRequest & { confirmToken: string };

/** POST /api/actions/execute の応答 */
export interface ExecuteResponse {
  /** 監査ログの id(D1 が無く AUDIT_REQUIRED="false" で実行した場合は null) */
  auditId: number | null;
  action: WriteAction;
  executedAt: number;
}
