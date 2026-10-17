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
 * - Worker Secrets は使わない(2026-10-16。docs/ARCHITECTURE.md 第 5 章): 管理パスワードは /setup で登録し
 *   D1 admins に PBKDF2 のハッシュで保存、鍵は D1 settings の instance_key から HKDF で派生する
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
  /** D1 が無い・マイグレーション未適用(docs/ARCHITECTURE.md 7.4) */
  'NOT_CONFIGURED',
  /** 管理者が未登録(/setup で管理パスワードを登録する前) */
  'SETUP_REQUIRED',
  // サーバー(複数サーバー対応。docs/ARCHITECTURE.md 第 15 章)
  'SERVER_NOT_FOUND',
  'SERVER_DISABLED',
  'SERVER_NEEDS_PASSWORD',
  'SERVER_LIMIT_REACHED',
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
  SETUP_REQUIRED: 503,
  SERVER_NOT_FOUND: 404,
  SERVER_DISABLED: 409,
  SERVER_NEEDS_PASSWORD: 409,
  SERVER_LIMIT_REACHED: 409,
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
  /** RCON パスワードが管理パスワード(D1 admins に登録したもの)と同じ */
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

// ---- 管理パスワード(docs/ARCHITECTURE.md 5.2。/setup の画面でも使う) ----
/** 管理パスワードの長さの下限(文字数、コードポイント単位)。README.md と同期 */
export const ADMIN_PASSWORD_MIN_LENGTH = 16;
/** 管理パスワードの長さの上限(文字数)。ログインではこれを超えた分を評価しない */
export const ADMIN_PASSWORD_MAX_LENGTH = 256;

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
/** ServerId の形式: servers.id の 10 進(先頭 0 なし)。既定サーバー('default')は 2026-10-16 に廃止 */
export const SERVER_ID_PATTERN = /^[1-9][0-9]{0,9}$/;

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

/**
 * 機能の可否(docs/ARCHITECTURE.md 7.4)。D1 必須化(2026-10-16)により、ログインできている間は通常すべて true。
 * 将来、機能単位で止める場合のために形を残す
 */
export interface Features {
  /** D1 に書けて操作ログが残せる */
  audit: boolean;
  /** 人数スナップショットを記録できる(audit と同じ D1 に依存) */
  snapshots: boolean;
  /** 書き込み操作を受け付ける */
  writes: boolean;
}

/**
 * /setup・画面上部に出す設定の警告(値は含めない)。
 * D1_MISSING / D1_NOT_MIGRATED はログイン前の /setup だけに出る(この状態ではログインできない)。
 * Secrets 関連の警告は Worker Secrets の廃止(2026-10-16)で削除した
 */
export type SetupWarning =
  | 'D1_MISSING'
  | 'D1_NOT_MIGRATED'
  /** 全体のログイン失敗が直近 1 時間で 50 回を超えた(ログインは止めない。docs/ARCHITECTURE.md 5.6) */
  | 'LOGIN_FAILURES_HIGH'
  /**
   * 登録サーバーのうち、保存済みの RCON パスワードを復号できないものがある。通常は起きない
   * (D1 settings の instance_key を手で消した・書き換えた場合や、データの破損。docs/ARCHITECTURE.md 15.3)。ログインは止めない
   */
  | 'SERVER_PASSWORDS_UNREADABLE';

// ============================================================
// 初期設定(/setup。docs/ARCHITECTURE.md 5.1、docs/API.md 2 章)
// ============================================================

/**
 * POST /setup(フォーム)が失敗したときの理由。画面はカタログ `setup.error.<code>` で文言を引く。
 * /setup はページ(フォーム POST)なので ApiErrorCode とは別の系列にする
 */
export const SETUP_FORM_ERRORS = [
  /** フォームを読み取れない */
  'BAD_REQUEST',
  /** ADMIN_PASSWORD_MIN_LENGTH 未満(空を含む) */
  'PASSWORD_TOO_SHORT',
  /** ADMIN_PASSWORD_MAX_LENGTH 超 */
  'PASSWORD_TOO_LONG',
  /** 確認入力が一致しない */
  'PASSWORD_MISMATCH',
  /** 登録済みサーバーの RCON パスワードと同じ(管理者を消して登録し直す場合に起き得る) */
  'PASSWORD_SAME_AS_RCON',
  /** 既に管理者が登録されている(先に誰かが登録した・二重送信) */
  'SETUP_ALREADY_DONE',
] as const;
export type SetupFormError = (typeof SETUP_FORM_ERRORS)[number];

/** POST /setup の失敗時の HTTP ステータス(フォームを再表示する) */
export const SETUP_FORM_ERROR_STATUS: Record<SetupFormError, number> = {
  BAD_REQUEST: 400,
  PASSWORD_TOO_SHORT: 400,
  PASSWORD_TOO_LONG: 400,
  PASSWORD_MISMATCH: 400,
  PASSWORD_SAME_AS_RCON: 400,
  SETUP_ALREADY_DONE: 409,
};

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

/**
 * GET /api/status(RCON GET /v1/status を正規化。次のマップは GET /v1/rotation から補う)。
 * サイドバーのサーバーカードと状態タブ(Overview)が同じ応答を共有する(docs/ARCHITECTURE.md 9.3)
 */
export interface StatusResponse {
  serverName: string | null;
  map: string | null;
  players: { current: number | null; max: number | null };
  factionScores: FactionScore[];
  rotation: StatusRotation;
  /**
   * RCON /v1/status の `experiences[]`(RCON の生データ。翻訳しない)。文字列の要素だけを先頭から
   * STATUS_EXPERIENCES_MAX 件、各 STATUS_EXPERIENCE_MAX_LENGTH 文字まで。取れなければ空配列。
   * 画面はこれを「ゲームモード」として表示するが、実際にモードを表すかは未検証(要確認 R-19)。
   * 2026-10-17 追加。backend の実装後に `?` を外す
   */
  experiences?: string[];
  fetchedAt: number;
}

/** ローテーション位置と次のマップ(docs/ARCHITECTURE.md 9.3、docs/API.md 3 章) */
export interface StatusRotation {
  nowIndex: number | null;
  nextIndex: number | null;
  /**
   * ローテーションの件数(RCON GET /v1/rotation の `entries.length`)。取れなければ null。
   * 2026-10-17 追加。backend の実装後に `?` を外す
   */
  count?: number | null;
  /**
   * 次のマップの id(`entries[nextIndex]` のマップ。RCON の生データ)。/v1/rotation が無い・取れない・
   * 範囲外・ローテーションが無効なら null。2026-10-17 追加。backend の実装後に `?` を外す
   */
  nextMap?: string | null;
  /** 次のマップの表示名(`entries[nextIndex]` に表示名があれば。/v1/catalog/maps は引かない。無ければ null)。同上 */
  nextMapName?: string | null;
}

/** StatusResponse.experiences の最大件数 */
export const STATUS_EXPERIENCES_MAX = 8;
/** StatusResponse.experiences の 1 要素の最大文字数 */
export const STATUS_EXPERIENCE_MAX_LENGTH = 64;
/** /v1/rotation の結果を isolate 内に保持する時間(秒。サーバーごと。map / match_end の成功で破棄) */
export const ROTATION_CACHE_SEC = 300;
/** サイドバーに出す陣営スコアの数(それ以上は「ほか n 陣営」) */
export const SIDEBAR_FACTION_LIMIT = 3;

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
  /** D1 が使えない場合は false(entries は空)。D1 必須化により通常は常に true */
  available: boolean;
  /** 応答に含めた種類(クエリ kind。既定 operations) */
  kind: AuditKind;
  entries: AuditEntry[];
  /** 次のページを取るときの before に渡す id。無ければ null */
  nextBefore: number | null;
}

/**
 * パネル設定の変更イベント(D1 settings_audit_log。audit_log の event CHECK には足せないため別テーブル)。docs/ARCHITECTURE.md 8.6・15.2
 * - server_add / server_update / server_delete: サーバーの変更(常に status = succeeded)
 * - server_update_rejected: ホスト名・ポートの変更を RCON パスワードの再入力なしで拒否した(params.reason = 'reenter_required')
 * - server_delete_rejected: 削除の確認の表示名が一致せず拒否した(params.reason = 'mismatch')
 *   (拒否の 2 つは status = failed、errorCode = VALIDATION_FAILED。QA M-2: 保存済みパスワードの持ち出し・誤削除の試行を残す)
 * - server_test: 接続テスト(保存済みのパスワードを外へ送る操作のため記録する)。params.result が 'ok' なら succeeded、
 *   それ以外(RCON_* のコード)なら failed で errorCode = params.result
 * - admin_register: /setup での管理パスワードの登録(乗っ取りの調査用に接続元ハッシュを残す)
 * 管理パスワードの変更画面を作るときに 'admin_password_change' を足す
 */
export const SETTINGS_EVENTS = [
  'server_add',
  'server_update',
  'server_delete',
  'server_update_rejected',
  'server_delete_rejected',
  'server_test',
  'admin_register',
] as const;
export type SettingsEvent = (typeof SETTINGS_EVENTS)[number];

export type AuditEventType = WriteAction | 'login' | 'logout' | SettingsEvent;

/**
 * GET /api/audit の `kind`。operations = audit_log(RCON 操作・ログイン)、settings = settings_audit_log(サーバーの追加・変更・削除、管理者の登録)。
 * 2 つは別テーブルで id の系列が違うため、1 回の応答には混ぜない(docs/API.md 3 章)
 */
export const AUDIT_KINDS = ['operations', 'settings'] as const;
export type AuditKind = (typeof AUDIT_KINDS)[number];
/**
 * pending のまま 1 分以上経った行は画面で「結果不明」と表示する。
 * `unknown` は API だけの値: RCON がタイムアウトし、実行されたかどうか不明(D1 上は failed + error_code = RCON_TIMEOUT。CHECK 制約は変えない)
 */
export type AuditStatus = 'pending' | 'succeeded' | 'failed' | 'unknown';

/**
 * 操作ログ・設定変更ログの 1 行(kind = operations / settings で共通の形)。
 * settings の行: status は succeeded / failed のみ(pending・unknown は出ない)、errorCode は SETTINGS_EVENTS の説明のとおり、
 * finishedAt は createdAt と同じ、targetSteamId / targetName / rconStatus は null
 */
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
   * 対象サーバー。login / logout と admin_register は null。D1 の server_id が NULL の書き込み操作の行
   * (複数サーバー対応前の行)も null(画面は「不明」と表示)。settings の行は対象サーバーの id(削除済みでも残る)
   */
  serverId: ServerId | null;
  /** 操作時点のサーバーの表示名。不明は null */
  serverName: string | null;
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
 * 必須(未指定は 400 VALIDATION_FAILED、fields.server = required)
 */
export type PrepareRequest = ActionRequest & { server: ServerId };

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
  /** 対象サーバー(確認トークンに署名済み。確認ダイアログにサーバー名を出すために使う) */
  server: ServerId;
}

/** POST /api/actions/execute の本文。action・params・server は prepare と同一であること(server は確認トークンで照合) */
export type ExecuteRequest = ActionRequest & { confirmToken: string; server: ServerId };

/** POST /api/actions/execute の応答 */
export interface ExecuteResponse {
  /** 監査ログの id(D1 必須化により常に値がある) */
  auditId: number;
  action: WriteAction;
  executedAt: number;
  /** 実行したサーバー */
  server: ServerId;
}

// ============================================================
// サーバー(複数サーバー対応。docs/ARCHITECTURE.md 第 15 章、docs/API.md 7 章)
// ============================================================

/**
 * サーバーの識別子。D1 servers.id の 10 進文字列(例 "3")。URL のクエリ・Cookie・セレクトの値にそのまま使えるよう文字列に統一する。
 * 形式は SERVER_ID_PATTERN。Secrets による既定サーバー('default')は 2026-10-16 に廃止
 */
export type ServerId = string;

/** 直近の接続テストの結果(D1 servers に保存した値) */
export interface ServerLastTest {
  at: number;
  /** 'ok' または失敗時の ApiErrorCode(RCON_*) */
  result: 'ok' | ApiErrorCode;
}

/** サーバー一覧の 1 行。**RCON パスワード・暗号文は含めない** */
export interface ServerSummary {
  id: ServerId;
  /** 表示名(運営者が付けた名前。翻訳しない) */
  name: string;
  /** ホスト名とポート(ログイン済みの運営者に編集用に見せる) */
  host: string;
  port: number;
  enabled: boolean;
  sortOrder: number;
  /**
   * 保存済みのパスワードを復号できない。通常は起きない(instance_key を手で消した・データ破損。docs/ARCHITECTURE.md 15.3)。
   * 再入力するまで操作できない
   */
  needsPassword: boolean;
  /** RCON パスワードが RCON_PASSWORD_WARN_LENGTH 未満(警告のみ。復号できない場合は false) */
  passwordShort: boolean;
  /** 操作・読み取りに使える(enabled かつ needsPassword でない) */
  usable: boolean;
  lastTest: ServerLastTest | null;
  createdAt: number;
  updatedAt: number;
}

/** GET /api/servers */
export interface ServersResponse {
  /** sort_order, id の順 */
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
  /** 1〜SERVER_PASSWORD_MAX_LENGTH 文字。管理パスワードと同じ値は不可(same_as_admin_password) */
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
