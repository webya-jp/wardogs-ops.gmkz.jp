/**
 * Worker 内部 API(/api/*)の契約。docs/API.md と同期(変更は architect 経由)。
 * - 応答はすべて ApiResponse<T>(JSON、UTF-8、Cache-Control: no-store)
 * - 時刻は UTC epoch ミリ秒の number。画面では JST に変換して表示する
 * - RCON の応答は Worker で正規化してから返す(生の応答は返さない)
 * - RCON の仕様は非公式資料ベース(docs/research/wardogs-rcon.md)。確度は docs/API.md 第 6 章
 * - 多言語化(docs/ARCHITECTURE.md 第 13 章): API は表示用の文言を返さない。エラーは機械可読な
 *   コード(ApiErrorCode / ValidationIssue)で返し、画面は src/i18n のカタログで文言を引く
 * - 複数サーバー(docs/ARCHITECTURE.md 第 15 章、docs/API.md 7 章): RCON を呼ぶ API は対象サーバーを
 *   `server`(ServerId。GET はクエリ、POST は本文)で受け取る。RCON パスワードはどの応答にも含めない
 *
 * 移行中の注記: 複数サーバー対応で既存の型に足した項目のうち、現行の実装がまだ値を入れていないものは
 * optional(`?`)にしてある(「実装後に必須化」と書いたもの)。backend / frontend の実装が揃ったら architect が `?` を外す。
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
  // サーバー(複数サーバー対応。docs/ARCHITECTURE.md 第 15 章)
  'SERVER_NOT_FOUND',
  'SERVER_DISABLED',
  'SERVER_NEEDS_PASSWORD',
  'SERVER_READ_ONLY',
  'SERVER_LIMIT_REACHED',
  'SERVERS_UNAVAILABLE',
  'NO_SERVERS',
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
  SERVER_NOT_FOUND: 404,
  SERVER_DISABLED: 409,
  SERVER_NEEDS_PASSWORD: 409,
  SERVER_READ_ONLY: 409,
  SERVER_LIMIT_REACHED: 409,
  SERVERS_UNAVAILABLE: 503,
  NO_SERVERS: 409,
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
  // サーバーの追加・変更・削除(docs/API.md 7 章)
  /** ポート番号が 1〜65535 の整数でない */
  'out_of_range',
  /** ホスト名に IP アドレスが指定された(Workers の fetch は IP 直指定不可) */
  'ip_address',
  /** 同じ表示名、または同じホスト名とポートのサーバーが既にある */
  'duplicate',
  /** RCON パスワードが ADMIN_PASSWORD と同じ */
  'same_as_admin_password',
  /** 削除の確認で入力した表示名が一致しない */
  'mismatch',
  /** ホスト名かポートを変えるときは RCON パスワードの再入力が必要(保存済みのパスワードを別の宛先に送らないため) */
  'reenter_required',
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

// ---- 複数サーバー(docs/ARCHITECTURE.md 第 15 章) ----
/** 画面から追加できるサーバーの上限(既定サーバーは数えない) */
export const MAX_SERVERS = 20;
/** サーバーの表示名の上限(文字数、コードポイント単位) */
export const SERVER_NAME_MAX_LENGTH = 32;
/** ホスト名の上限(DNS 名の上限) */
export const SERVER_HOST_MAX_LENGTH = 253;
/** 画面から入力する RCON パスワードの上限(文字数) */
export const SERVER_PASSWORD_MAX_LENGTH = 256;
/** 同じサーバーへの接続テスト(POST /api/servers/:id/test)の最短間隔(秒。isolate 内で判定) */
export const SERVER_TEST_MIN_INTERVAL_SEC = 5;
/** Secrets(RCON_URL / RCON_PASSWORD)による既定サーバーの id */
export const DEFAULT_SERVER_ID = 'default';
/** ServerId の形式: 'default' または servers.id の 10 進(先頭 0 なし) */
export const SERVER_ID_PATTERN = /^(?:default|[1-9][0-9]{0,9})$/;

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
  /**
   * 画面からサーバーを追加・変更・削除できる(D1 が使え、マイグレーション 0002 まで適用済み = audit と同じ判定)。
   * false のときは既定サーバー(Secrets)だけが使える。実装後に必須化
   */
  servers?: boolean;
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
  | 'LOGIN_FAILURES_HIGH'
  /**
   * 画面から追加したサーバーのうち、保存済みの RCON パスワードを復号できないものがある
   * (ADMIN_PASSWORD または SESSION_SECRET を変えた後に起きる。docs/ARCHITECTURE.md 15.3)。ログインは止めない
   */
  | 'SERVER_PASSWORDS_UNREADABLE';

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
  /** 応答に含めた種類(クエリ kind。既定 operations)。実装後に必須化 */
  kind?: AuditKind;
  entries: AuditEntry[];
  /** 次のページを取るときの before に渡す id。無ければ null */
  nextBefore: number | null;
}

/** パネル設定の変更イベント(D1 settings_audit_log。audit_log の event CHECK には足せないため別テーブル) */
export const SETTINGS_EVENTS = ['server_add', 'server_update', 'server_delete'] as const;
export type SettingsEvent = (typeof SETTINGS_EVENTS)[number];

export type AuditEventType = WriteAction | 'login' | 'logout' | SettingsEvent;

/**
 * GET /api/audit の `kind`。operations = audit_log(RCON 操作・ログイン)、settings = settings_audit_log(サーバーの追加・変更・削除)。
 * 2 つは別テーブルで id の系列が違うため、1 回の応答には混ぜない(docs/API.md 3 章)
 */
export const AUDIT_KINDS = ['operations', 'settings'] as const;
export type AuditKind = (typeof AUDIT_KINDS)[number];
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
  /**
   * 対象サーバー。書き込み操作で D1 の server_id が NULL の行(0002 以前の行を含む)は 'default'。
   * login / logout は null。settings の行は対象サーバーの id(削除済みでも残る)。実装後に必須化
   */
  serverId?: ServerId | null;
  /** 操作時点のサーバーの表示名。既定サーバー・不明は null(画面はカタログ `server.defaultName` 等で補う)。実装後に必須化 */
  serverName?: string | null;
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

/**
 * POST /api/actions/prepare の本文。`server` は対象サーバー(docs/API.md 4 章)。
 * 実装後は必須(未指定は 400 VALIDATION_FAILED、fields.server = required)。型は移行中のため optional
 */
export type PrepareRequest = ActionRequest & { server?: ServerId };

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
  /** 対象サーバー(確認トークンに署名済み。確認ダイアログにサーバー名を出すために使う)。実装後に必須化 */
  server?: ServerId;
}

/** POST /api/actions/execute の本文。action・params・server は prepare と同一であること(server は確認トークンで照合) */
export type ExecuteRequest = ActionRequest & { confirmToken: string; server?: ServerId };

/** POST /api/actions/execute の応答 */
export interface ExecuteResponse {
  /** 監査ログの id(D1 が無く AUDIT_REQUIRED="false" で実行した場合は null) */
  auditId: number | null;
  action: WriteAction;
  executedAt: number;
  /** 実行したサーバー。実装後に必須化 */
  server?: ServerId;
}

// ============================================================
// サーバー(複数サーバー対応。docs/ARCHITECTURE.md 第 15 章、docs/API.md 7 章)
// ============================================================

/**
 * サーバーの識別子。'default'(Secrets の RCON_URL / RCON_PASSWORD による既定サーバー)または
 * D1 servers.id の 10 進文字列(例 "3")。URL のクエリ・Cookie・セレクトの値にそのまま使えるよう文字列に統一する。
 * 形式は SERVER_ID_PATTERN
 */
export type ServerId = string;

/** secrets = 既定サーバー(画面からは編集・削除できない)、db = 画面から追加したサーバー */
export type ServerSource = 'secrets' | 'db';

/** 直近の接続テストの結果(db は D1 に保存した値。既定サーバーは isolate 内の値のみで、無ければ null) */
export interface ServerLastTest {
  at: number;
  /** 'ok' または失敗時の ApiErrorCode(RCON_*) */
  result: 'ok' | ApiErrorCode;
}

/** サーバー一覧の 1 行。**RCON パスワード・暗号文は含めない** */
export interface ServerSummary {
  id: ServerId;
  source: ServerSource;
  /** 表示名。既定サーバーは null(画面はカタログ `server.defaultName` で表示) */
  name: string | null;
  /**
   * ホスト名とポート(db のみ。ログイン済みの運営者に編集用に見せる)。
   * 既定サーバーは null(RCON_URL は Secret のまま画面に出さない。docs/ARCHITECTURE.md 2 章)
   */
  host: string | null;
  port: number | null;
  enabled: boolean;
  sortOrder: number;
  /** 保存済みのパスワードを復号できない(ADMIN_PASSWORD / SESSION_SECRET を変えた後など)。再入力するまで操作できない */
  needsPassword: boolean;
  /** RCON パスワードが RCON_PASSWORD_WARN_LENGTH 未満(警告のみ。復号できない場合は false) */
  passwordShort: boolean;
  /**
   * 既定サーバーの Secrets の不備(RCON_URL_MISSING / RCON_URL_INVALID / RCON_URL_IS_IP_ADDRESS /
   * RCON_URL_HAS_CREDENTIALS / RCON_PASSWORD_MISSING)。db のサーバーは常に null
   */
  secretsIssue: SetupWarning | null;
  /** 操作・読み取りに使える(enabled かつ needsPassword でなく secretsIssue が無い) */
  usable: boolean;
  lastTest: ServerLastTest | null;
  /** db のみ。既定サーバーは null */
  createdAt: number | null;
  updatedAt: number | null;
}

/** GET /api/servers */
export interface ServersResponse {
  /** 画面からの追加・変更・削除ができる(features.servers と同じ)。false でも既定サーバーは servers に入る */
  manageable: boolean;
  /** 既定サーバー(あれば先頭)→ db のサーバーを sort_order, id の順 */
  servers: ServerSummary[];
  /** 追加できる上限(MAX_SERVERS) */
  limit: number;
}

/** POST /api/servers の本文(フォームの 4 項目) */
export interface CreateServerRequest {
  /** 1〜SERVER_NAME_MAX_LENGTH 文字。改行・制御文字不可。前後の空白は除く */
  name: string;
  /** ホスト名のみ(`http://`・ポート・パスを含めない)。IP アドレス不可。小文字に正規化して保存 */
  host: string;
  /** 1〜65535 の整数 */
  port: number;
  /** 1〜SERVER_PASSWORD_MAX_LENGTH 文字。ADMIN_PASSWORD と同じ値は不可 */
  password: string;
}

/**
 * PUT /api/servers/:id の本文。省略した項目は変えない。
 * - `password` が省略または空文字なら据え置き
 * - `host` か `port` を変えるときは `password` が必須(無ければ 400、fields.password = reenter_required)
 */
export interface UpdateServerRequest {
  name?: string;
  host?: string;
  port?: number;
  password?: string;
  enabled?: boolean;
  /** 並び順(整数 -1000〜1000。範囲外は out_of_range) */
  sortOrder?: number;
}

/** DELETE /api/servers/:id の本文。誤削除防止のため、現在の表示名を入力させて送る */
export interface DeleteServerRequest {
  confirmName: string;
}

/** 接続テスト(RCON GET /v1/status)の結果。失敗しても API としては 200 で返す */
export interface ServerTestResult {
  ok: boolean;
  /** 失敗時の ApiErrorCode(RCON_*)。成功時は null */
  code: ApiErrorCode | null;
  /** RCON_REJECTED のときの RCON のエラー文(ApiFailure の rconMessage と同じ扱い) */
  rconMessage?: string;
  /** RCON_RATE_LIMITED のとき */
  retryAfterSec?: number;
  testedAt: number;
  /** 成功時、RCON が返したサーバー名(RCON の生データ。翻訳しない)。失敗時は null */
  serverName: string | null;
  /** 成功時の人数。失敗時は両方 null */
  players: { current: number | null; max: number | null };
}

/** POST /api/servers・PUT /api/servers/:id・POST /api/servers/:id/test の応答 */
export interface ServerMutationResponse {
  server: ServerSummary;
  /** 接続テストの結果。PUT で接続に関わる項目(host / port / password、または enabled を true に)を変えなかった場合は null */
  test: ServerTestResult | null;
}

/** DELETE /api/servers/:id の応答 */
export interface DeleteServerResponse {
  deletedId: ServerId;
}
