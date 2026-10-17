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
 * - スコア記録とキルフィード(2026-10-17。docs/ARCHITECTURE.md 第 17 章、docs/API.md 8〜10 章): 記録の開始・停止は
 *   prepare / execute の二段階(RecordingAction)、試合と推移は /api/matches、受信は POST /api/ingest/events(トークン認証のみ)
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
  // スコア記録・キルフィード(docs/ARCHITECTURE.md 第 17 章)
  /** POST /api/ingest/events のトークンが無い・形式不正・一致しない・取り消し済み(401。WWW-Authenticate: Bearer 付き) */
  'FEED_TOKEN_INVALID',
  /** record_start: そのサーバーは既に記録中 */
  'RECORDING_ALREADY_ACTIVE',
  /** record_stop: 指定した記録が記録中でない(既に終了・存在しない・別サーバー) */
  'RECORDING_NOT_ACTIVE',
  /** record_start: 同時に記録できるサーバー数(MAX_ACTIVE_RECORDINGS)に達した */
  'RECORDING_LIMIT_REACHED',
  /** /api/matches/:id/samples: 試合が無い(削除済み・別サーバー) */
  'MATCH_NOT_FOUND',
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
  FEED_TOKEN_INVALID: 401,
  RECORDING_ALREADY_ACTIVE: 409,
  RECORDING_NOT_ACTIVE: 409,
  RECORDING_LIMIT_REACHED: 409,
  MATCH_NOT_FOUND: 404,
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
  /**
   * RCON /v1/status の `scoreCap`(陣営スコアの上限)。ビルドによって無い(docs/research/wardogs-rcon.md 2.1。要確認 R-21)。
   * 正の数でなければ null。スコア記録の自動終了に使う(docs/ARCHITECTURE.md 17.5)。2026-10-17 追加。backend の実装後に `?` を外す
   */
  scoreCap?: number | null;
  /** RCON /v1/status の `matchSeconds`(試合の経過秒と見られるが意味は未検証。R-21)。ビルドによって無い。0 以上の数でなければ null。同上 */
  matchSeconds?: number | null;
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
  // スコア記録(docs/ARCHITECTURE.md 17.2。audit_log の event CHECK に足せないためこちらに記録する。要確認 U-19)
  /** 記録の開始(二段階の execute。params: { recordingId, map }) */
  'record_start',
  /** 記録の停止(二段階の execute。params: { recordingId }) */
  'record_stop',
  /** 記録の自動終了(Cron、またはこのパネルの map / match_end。operator / session_tag は NULL。params: { recordingId, reason: MatchEndReason }) */
  'record_end',
  // キルフィード(docs/ARCHITECTURE.md 17.6。トークンの値・ハッシュは params に入れない)
  /** 受信用トークンの発行・再発行(params: { reissued: boolean }) */
  'feed_token_issue',
  /** 受信用トークンの取り消し(params: {}) */
  'feed_token_revoke',
  /** 受信の保存の有効・無効の切り替え(params: { enabled }) */
  'feed_settings_update',
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
 * パネル内の操作で、RCON の書き込みを伴わないが確認ダイアログ(prepare / execute)と記録を通すもの(docs/ARCHITECTURE.md 17.2)。
 * WriteAction とは別の系列にする(capabilities の write・audit_log の event CHECK の対象外のため)。
 * 記録先は settings_audit_log(event = record_start / record_stop。要確認 U-19)
 */
export const RECORDING_ACTIONS = ['record_start', 'record_stop'] as const;
export type RecordingAction = (typeof RECORDING_ACTIONS)[number];
/** prepare / execute が受け付ける操作の全体 */
export type ConfirmableAction = WriteAction | RecordingAction;

/** record_start: params は空(対象は `server`) */
export type RecordStartParams = Record<string, never>;
/** record_stop: 止める記録(画面に表示している記録中の試合)。別の記録を止めないよう id で指定する */
export interface RecordStopParams {
  recordingId: MatchId;
}
export interface RecordingParamsMap {
  record_start: RecordStartParams;
  record_stop: RecordStopParams;
}
export type RecordingActionRequest = {
  [A in RecordingAction]: { action: A; params: RecordingParamsMap[A] };
}[RecordingAction];

/**
 * POST /api/actions/prepare の本文。`server` は対象サーバー(docs/API.md 4 章)。
 * 必須(未指定は 400 VALIDATION_FAILED、fields.server = required)
 */
export type PrepareRequest = (ActionRequest | RecordingActionRequest) & { server: ServerId };

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

/**
 * POST /api/actions/prepare の応答(RecordingAction のとき)。docs/API.md 4.1。
 * record_start の prepare は RCON GET /v1/status を 1 回呼び、現在のマップと上限を確認ダイアログ用に返す
 */
export interface RecordingPrepareResponse {
  confirmToken: string;
  action: RecordingAction;
  params: RecordingParamsMap[RecordingAction];
  /** 常に false(ゲームサーバーには何も書き込まない) */
  destructive: false;
  expiresAt: number;
  server: ServerId;
  /** record_start: 現在のマップ(RCON の生データ)。record_stop: 止める試合の開始時のマップ。不明なら null */
  map: string | null;
  /** record_start: この記録で使う上限と出所。record_stop: 止める試合の値 */
  scoreCap: number;
  scoreCapSource: ScoreCapSource;
  /** record_stop: 止める試合(record_start は null) */
  match: MatchSummary | null;
}
/** prepare の応答の全体(action で判別する) */
export type AnyPrepareResponse = PrepareResponse | RecordingPrepareResponse;

/** POST /api/actions/execute の本文。action・params・server は prepare と同一であること(server は確認トークンで照合) */
export type ExecuteRequest = (ActionRequest | RecordingActionRequest) & { confirmToken: string; server: ServerId };

/** POST /api/actions/execute の応答(WriteAction のとき) */
export interface ExecuteResponse {
  /** 監査ログの id(D1 必須化により常に値がある) */
  auditId: number;
  /** auditId の系列(operations = audit_log)。省略時は operations。2026-10-17 追加 */
  auditKind?: AuditKind;
  action: WriteAction;
  executedAt: number;
  /** 実行したサーバー */
  server: ServerId;
}

/** POST /api/actions/execute の応答(RecordingAction のとき。記録先は settings_audit_log) */
export interface RecordingExecuteResponse {
  /** settings_audit_log の id */
  auditId: number;
  auditKind: 'settings';
  action: RecordingAction;
  executedAt: number;
  server: ServerId;
  /** 開始した・停止した試合(停止後は status = ended、endReason = manual) */
  match: MatchSummary;
}
/** execute の応答の全体(action で判別する) */
export type AnyExecuteResponse = ExecuteResponse | RecordingExecuteResponse;

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
  /**
   * スコア記録の上限の設定値(D1 servers.score_cap)。null = 既定(SCORE_CAP_DEFAULT)。
   * RCON の status.scoreCap があればそちらを優先する(docs/ARCHITECTURE.md 17.5)。2026-10-17 追加。backend の実装後に `?` を外す
   */
  scoreCap?: number | null;
  /** キルフィードの受信用トークンを発行済みか(値は返さない)。同上 */
  feedConfigured?: boolean;
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
  /**
   * スコア記録の上限(整数 SCORE_CAP_MIN〜SCORE_CAP_MAX。整数でなければ invalid_format、範囲外は out_of_range)。
   * null で既定(SCORE_CAP_DEFAULT)に戻す。変えても接続テストはしない。記録中の試合には次のサンプルから効く(docs/ARCHITECTURE.md 17.5)
   */
  scoreCap?: number | null;
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

// ============================================================
// スコア記録(docs/ARCHITECTURE.md 第 17 章、docs/API.md 8 章)
// ============================================================

/** 試合(記録)の識別子。D1 match_recordings.id の 10 進文字列 */
export type MatchId = string;
/** MatchId の形式(SERVER_ID_PATTERN と同じ規則) */
export const MATCH_ID_PATTERN = /^[1-9][0-9]{0,9}$/;

/** スコア上限の既定値(status.scoreCap が無く、サーバーの設定値も無いとき) */
export const SCORE_CAP_DEFAULT = 100;
export const SCORE_CAP_MIN = 1;
export const SCORE_CAP_MAX = 100_000;
/** 上限の出所。status = RCON /v1/status の scoreCap、setting = サーバーの設定値(servers.score_cap)、default = SCORE_CAP_DEFAULT */
export type ScoreCapSource = 'status' | 'setting' | 'default';

/** Cron のサンプル間隔(秒)。wrangler.jsonc の triggers.crons(1 分ごと)と一致させる */
export const RECORDING_SAMPLE_INTERVAL_SEC = 60;
/** 開始からこの時間が経ったら自動終了(max_duration) */
export const RECORDING_MAX_DURATION_MS = 3 * 60 * 60 * 1000;
/** 人数 0 がこの時間続いたら自動終了(empty) */
export const RECORDING_EMPTY_END_MS = 10 * 60 * 1000;
/** サーバーごとに残す終了済みの試合の数(これより古いものは試合とサンプルを削除) */
export const RECORDING_KEEP_ENDED = 5;
/** 終了済みの試合をこの日数より長く残さない(RECORDING_KEEP_ENDED 以内でも削除) */
export const RECORDING_RETENTION_DAYS = 30;
/** 同時に記録できるサーバー数(Cron 1 回の D1 クエリ 50・サブリクエスト 50 の上限から決めた値。docs/ARCHITECTURE.md 17.3) */
export const MAX_ACTIVE_RECORDINGS = 8;
/** 1 サンプルに残す陣営の数の上限(スコア・人数・cash それぞれ) */
export const MATCH_FACTIONS_MAX = 8;
/** /api/matches/:id/samples が返すサンプルの上限(3 時間 = 180 + 開始時の 1 + 余裕) */
export const MATCH_SAMPLES_MAX = 200;

export const MATCH_STATUSES = ['recording', 'ended'] as const;
export type MatchStatus = (typeof MATCH_STATUSES)[number];

/**
 * 記録の終了理由(D1 match_recordings.end_reason。CHECK は付けずコードで検証)。画面はカタログ `match.endReason.<reason>` で引く。
 * - score_cap: いずれかの陣営スコアが上限に達した
 * - manual: 「記録を停止」(record_stop)
 * - map_changed: Cron が status.map の変化を検出した(ゲーム内・他のツールでのマップ変更・試合終了を含む)
 * - match_action: このパネルの map / match_end の execute が成功した
 * - empty: 人数 0 が RECORDING_EMPTY_END_MS 続いた
 * - max_duration: 開始から RECORDING_MAX_DURATION_MS が経った
 * - server_unavailable: サーバーが削除・無効化された、またはパスワードを読み出せない
 */
export const MATCH_END_REASONS = [
  'score_cap',
  'manual',
  'map_changed',
  'match_action',
  'empty',
  'max_duration',
  'server_unavailable',
] as const;
export type MatchEndReason = (typeof MATCH_END_REASONS)[number];

/** 試合の一覧の 1 行 */
export interface MatchSummary {
  id: MatchId;
  serverId: ServerId;
  /** 開始時点のサーバーの表示名 */
  serverName: string | null;
  status: MatchStatus;
  startedAt: number;
  /** 記録中は null */
  endedAt: number | null;
  /** 記録中は null */
  endReason: MatchEndReason | null;
  /** 開始時点のマップ(RCON の生データ。翻訳しない)。不明なら null */
  map: string | null;
  /** 判定に使う(使った)上限と出所 */
  scoreCap: number;
  scoreCapSource: ScoreCapSource;
  sampleCount: number;
  /** 最後のサンプルの時刻。サンプルが無ければ null */
  lastSampleAt: number | null;
  /** 最後のサンプルの陣営スコア(一覧で結果を見せる用。陣営名は RCON の生データ) */
  lastScores: FactionScore[];
}

/** GET /api/matches?server= */
export interface MatchesResponse {
  server: ServerId;
  /** 記録中の試合(あれば先頭)→ 終了済みの新しい順(最大 RECORDING_KEEP_ENDED 件) */
  matches: MatchSummary[];
  /** 同時に記録できるサーバー数(MAX_ACTIVE_RECORDINGS) */
  activeLimit: number;
  /** いま記録中のサーバー数(全サーバー) */
  activeCount: number;
}

/**
 * 陣営ごとの人数と cash の合計(GET /v1/players の players[].faction で集計。陣営名は RCON の生データ)。
 * status.factionScores[].faction と同じ表記かは未検証(要確認 R-22)
 */
export interface FactionStat {
  /** players[].faction(文字列でなければ null = 不明の陣営) */
  faction: string | null;
  players: number;
  /** その陣営の players[].cash の合計。数値の cash を持つプレイヤーが 1 人もいなければ null */
  cash: number | null;
}

/** 試合の 1 分ごとのサンプル */
export interface MatchSample {
  /** 取得時刻(Cron は scheduledTime、開始時は実行時刻) */
  at: number;
  map: string | null;
  players: { current: number | null; max: number | null };
  /** status.factionScores(最大 MATCH_FACTIONS_MAX 件) */
  factionScores: FactionScore[];
  /** players[].cash の全員の合計(cash の意味は未検証 R-22)。/v1/players が取れない・cash が無ければ null */
  cashTotal: number | null;
  /** 陣営ごとの人数と cash(最大 MATCH_FACTIONS_MAX 件)。/v1/players が取れなければ空 */
  factions: FactionStat[];
}

/** GET /api/matches/:id/samples */
export interface MatchSamplesResponse {
  match: MatchSummary;
  /** 古い順。最大 MATCH_SAMPLES_MAX 件 */
  samples: MatchSample[];
}

// ============================================================
// キルフィード 第 1 段階: 観測モード(docs/ARCHITECTURE.md 17.6、docs/API.md 9・10 章)
// ============================================================

/** ゲームサーバー(WDServerFeed)が POST する先のパス。ゲームが Url の後ろに付ける(要確認 K-1) */
export const FEED_INGEST_PATH = '/api/ingest/events';
/** 受信する本文の上限(バイト)。超えたら 413 */
export const FEED_MAX_BODY_BYTES = 64 * 1024;
/** 1 サーバーあたり 1 分の受信回数の上限(isolate 内で判定。約 2 秒ごと = 30 回/分の 3 倍)。超えたら 429 */
export const FEED_RATE_PER_MIN = 90;
/** 1 サーバーあたり 1 日(UTC)に保存する空でないバッチの上限。超えたら 204 で受けて捨てる */
export const FEED_DAILY_MAX_BATCHES = 1000;
/** 1 サーバーあたり 1 日に保存する本文の合計の上限(バイト) */
export const FEED_DAILY_MAX_BYTES = 4 * 1024 * 1024;
/** 全サーバー合計の 1 日の上限(D1 の書き込み 10 万行/日・1 データベース 500 MB の保護) */
export const FEED_GLOBAL_DAILY_MAX_BATCHES = 4000;
export const FEED_GLOBAL_DAILY_MAX_BYTES = 16 * 1024 * 1024;
/** 受信した生データの保持日数 */
export const FEED_RETENTION_DAYS = 7;
/** GET /api/feed/raw の既定件数と上限 */
export const FEED_RAW_PAGE_DEFAULT = 20;
export const FEED_RAW_PAGE_MAX = 50;
/** トークンの検証結果を isolate 内に保持する秒数(再発行・取り消しが他の isolate に効くまでの最大の遅れ) */
export const FEED_TOKEN_CACHE_SEC = 60;
/**
 * 受信用トークンの形式: `wof1.<ServerId>.<32 バイトの乱数の base64url(43 文字)>`。
 * D1 には SHA-256 のハッシュだけを保存し、平文は発行時の応答で 1 回だけ返す(docs/ARCHITECTURE.md 17.6)
 */
export const FEED_TOKEN_PREFIX = 'wof1';
export const FEED_TOKEN_PATTERN = /^wof1\.([1-9][0-9]{0,9})\.([A-Za-z0-9_-]{43})$/;

/** 受信を拒否した理由(4xx を返したもの。server_feeds.last_rejected_reason)。画面はカタログ `feed.reject.<reason>` */
export const FEED_REJECT_REASONS = ['token_invalid', 'content_type', 'too_large', 'bad_json', 'rate_limited'] as const;
export type FeedRejectReason = (typeof FEED_REJECT_REASONS)[number];
/** 受けて保存しなかった理由(204 を返したもの。server_feeds.last_dropped_reason)。画面はカタログ `feed.drop.<reason>` */
export const FEED_DROP_REASONS = ['disabled', 'server_unusable', 'daily_limit', 'global_limit'] as const;
export type FeedDropReason = (typeof FEED_DROP_REASONS)[number];

/** GET /api/servers/:id/feed(受信の状況。トークンの値・ハッシュは返さない) */
export interface ServerFeedStatus {
  server: ServerId;
  /** トークンを発行済み */
  configured: boolean;
  /** 受信したものを保存する(false でも 204 で受けて捨てる。ゲーム側の送信は止まらない) */
  enabled: boolean;
  /** トークンの末尾 4 文字(どのトークンを設定したかの見分け用)。未発行は null */
  tokenHint: string | null;
  tokenCreatedAt: number | null;
  /** 最後に受信した時刻(空のバッチを含む。D1 への反映は 1 分に 1 回まで) */
  lastReceivedAt: number | null;
  /** 最後に保存した時刻 */
  lastStoredAt: number | null;
  lastRejectedAt: number | null;
  lastRejectedReason: FeedRejectReason | null;
  lastDroppedAt: number | null;
  lastDroppedReason: FeedDropReason | null;
  /** 今日(UTC)保存した件数と本文の合計 */
  today: { batches: number; bytes: number };
  limits: {
    dailyBatches: number;
    dailyBytes: number;
    globalDailyBatches: number;
    globalDailyBytes: number;
    retentionDays: number;
    maxBodyBytes: number;
    ratePerMin: number;
  };
  /** FEED_INGEST_PATH(ゲームが Url の後ろに自分で付けるため、画面は Url にパネルの URL だけを書かせる。参考表示用) */
  ingestPath: string;
}

/** PUT /api/servers/:id/feed の本文 */
export interface UpdateFeedRequest {
  enabled: boolean;
}

/** POST /api/servers/:id/feed-token の応答。**token はこの応答でだけ返す**(再表示はできない。失くしたら再発行) */
export interface FeedTokenResponse {
  token: string;
  tokenHint: string;
  createdAt: number;
  /** 既存のトークンを置き換えた(古いトークンは最大 FEED_TOKEN_CACHE_SEC 秒以内に使えなくなる) */
  reissued: boolean;
  status: ServerFeedStatus;
}

/** 受信した生データの 1 件 */
export interface FeedRawEntry {
  id: number;
  receivedAt: number;
  /** 本文のバイト数 */
  bytes: number;
  /** 本文が配列ならその長さ、`events` 配列を持つオブジェクトならその長さ、それ以外は null */
  eventCount: number | null;
  /** 受信時に記録中だった試合(無ければ null。第 2 段階の試合ごとの集計に使う) */
  matchId: MatchId | null;
  /** 受信した本文(UTF-8 の JSON 文字列のまま。画面は**テキストとして**表示し、HTML として解釈しない) */
  body: string;
}

/** GET /api/feed/raw?server=&limit=&before= */
export interface FeedRawResponse {
  server: ServerId;
  /** トークンを発行済みか(未発行なら entries は空で、画面は設定タブへの案内を出す) */
  configured: boolean;
  /** 新しい順 */
  entries: FeedRawEntry[];
  nextBefore: number | null;
}

// ============================================================
// キルフィード 第 2 段階: 正規化・保存・画面(docs/ARCHITECTURE.md 17.10、docs/API.md 11 章。2026-10-17)
// 第 1 段階(上の節)の型・定数は変えない。ここは追加のみ。
// 届く本文の実際の項目名は未確認(要確認 K-1)。正規化の候補名の対応表は src/lib/killfeed/fields.ts の 1 か所に置く
// ============================================================

/** キルの一覧の対象: 試合(MatchId)か、スコア記録をしていない間のキル(記録外) */
export const KILLFEED_UNRECORDED = 'unrecorded';
export type KillfeedScope = MatchId | typeof KILLFEED_UNRECORDED;

/** 1 試合で返すキルの上限(超えたら truncated = true。古い順に先頭からこの件数) */
export const KILLFEED_MATCH_KILLS_MAX = 3000;
/** 記録外で返すキルの件数(新しい方からこの件数を、古い順に並べて返す) */
export const KILLFEED_UNRECORDED_MAX = 500;
/** 差分の取得(after 指定)で 1 回に返す上限。超えたら truncated = true で、画面は全件を取り直す */
export const KILLFEED_INCREMENT_MAX = 500;
/** 記録中の試合・記録外を表示している間の差分の取得の間隔(秒)。POLL_MIN_INTERVAL_SEC と同じ */
export const KILLFEED_POLL_SEC = 30;
/** 1 回の受信(1 バッチ)から保存するキルの上限(超えた分は捨てて droppedKills に数える) */
export const KILLFEED_MAX_KILLS_PER_BATCH = 100;
/** 1 サーバーあたり 1 日(UTC)に保存するキルの上限 */
export const KILLFEED_DAILY_MAX_KILLS = 3000;
/** 全サーバー合計の 1 日のキルの上限(D1 の書き込み 10 万行/日の保護。docs/ARCHITECTURE.md 17.10.8) */
export const KILLFEED_GLOBAL_DAILY_MAX_KILLS = 8000;
/** 記録外のキルの保持日数(試合に属するキルは試合と同じ保持。RECORDING_KEEP_ENDED・RECORDING_RETENTION_DAYS) */
export const KILLFEED_UNRECORDED_RETENTION_DAYS = 7;
/** 陣営の付与に使う「直近のプレイヤー一覧の観測」(match_samples.roster_json)の鮮度の上限。これより古ければ陣営は不明 */
export const KILLFEED_ROSTER_MAX_AGE_MS = 3 * 60_000;
/** match_samples.roster_json に残すプレイヤー数の上限 */
export const KILLFEED_ROSTER_MAX_PLAYERS = 128;
/** プレイヤー名・陣営名の最大文字数(超えたら切り詰め。制御文字は除去) */
export const KILLFEED_NAME_MAX_LENGTH = 64;
/** 武器・乗り物の id と表示名の最大文字数 */
export const KILLFEED_LABEL_MAX_LENGTH = 64;
/** 距離として受け付ける上限(m)。これを超える・負の値は不明(null)にする */
export const KILLFEED_DISTANCE_MAX_M = 100_000;

/** 距離の階級の境界(m)。<10 / 10–25 / 25–50 / 50–100 / 100–200 / 200+(下限を含み上限を含まない) */
export const KILL_DISTANCE_BIN_EDGES_M = [10, 25, 50, 100, 200] as const;
/** フィルタ「100 m 以上」の境界 */
export const KILL_LONG_DISTANCE_M = 100;
/** 時間帯別の棒の幅の候補(分)。棒の数が KILL_TIME_BUCKETS_MAX 以下になる最小のものを使う */
export const KILL_TIME_BUCKET_MINUTES = [1, 2, 5, 10, 15, 30, 60, 120, 360, 720, 1440] as const;
export const KILL_TIME_BUCKETS_MAX = 36;
/** 上位プレイヤー・武器の表示数 */
export const KILLFEED_TOP_PLAYERS = 10;
export const KILLFEED_TOP_WEAPONS = 10;
/** キルログを 1 回に表示する行数(「さらに表示」で増やす。データは全件をブラウザが持つ) */
export const KILLFEED_LOG_PAGE = 50;
/** 検索語の最大文字数 */
export const KILLFEED_SEARCH_MAX_LENGTH = 64;

/** キルの印。画面はカタログ `killfeed.flag.<KillFlag>` で引く */
export const KILL_FLAGS = ['headshot', 'penetration', 'roadkill', 'vehicleExplosion', 'suicide'] as const;
export type KillFlag = (typeof KILL_FLAGS)[number];

/**
 * キルログのフィルタ。画面はカタログ `killfeed.filter.<KillFilter>` で引く。
 * - kills: キラーがいて自殺でないもの / headshots: kills のうちヘッドショット / teamkills: teamkill === true
 * - suicides: flags.suicide / long: distanceM >= KILL_LONG_DISTANCE_M / vehicle: 乗り物あり・roadkill・vehicleExplosion
 * - penetration: flags.penetration
 */
export const KILL_FILTERS = ['all', 'kills', 'headshots', 'teamkills', 'suicides', 'long', 'vehicle', 'penetration'] as const;
export type KillFilter = (typeof KILL_FILTERS)[number];

/** 陣営をどこから得たか: event = イベント自体の項目、roster = 受信時の直近のプレイヤー一覧の観測 */
export const KILL_FACTION_SOURCES = ['event', 'roster'] as const;
export type KillFactionSource = (typeof KILL_FACTION_SOURCES)[number];

/** キルの当事者(キラー・被害者) */
export interface KillParty {
  /** プレイヤー名(生データ。翻訳しない)。不明なら null */
  name: string | null;
  /** STEAM_ID_PATTERN に合うものだけ。合わない・不明なら null */
  steamId: string | null;
  /** 陣営名(生データ)。不明なら null(画面は「?」) */
  faction: string | null;
  factionSource: KillFactionSource | null;
}

/** 武器・原因(表示名と内部 ID。どちらも無ければ両方 null = 不明) */
export interface KillWeapon {
  id: string | null;
  name: string | null;
}

/** 乗り物(乗り物の兵装によるキル、ロードキルなど) */
export interface KillVehicle {
  id: string | null;
  name: string | null;
}

/**
 * 正規化したキル 1 件(D1 feed_kills の 1 行)。届く本文の項目名は未確認のため、対応できなかった項目は null。
 * 時刻は UTC epoch ミリ秒
 */
export interface KillEvent {
  /** feed_kills.id(一意の番号。画面の key・詳細の表示用) */
  id: number;
  /** Worker が受信した時刻(時間帯別の集計・試合への割り当てはこれを使う) */
  receivedAt: number;
  /** イベント自体の時刻(本文にあり、受信時刻の前後 1 日以内のときだけ)。無ければ null */
  eventAt: number | null;
  /** ゲーム内時刻(試合開始からの経過秒。参考パネルの「GAME 52:31」に当たる)。無ければ null */
  gameTimeSec: number | null;
  /** キラー。環境による死亡・本文から読めないときは null */
  killer: KillParty | null;
  /** 被害者。読めないイベントは保存しないため通常は null にならない(名前・ID の一部が null はあり得る) */
  victim: KillParty | null;
  weapon: KillWeapon;
  /** 乗り物が無い・不明なら null */
  vehicle: KillVehicle | null;
  flags: Record<KillFlag, boolean>;
  /**
   * 同じ陣営どうしのキル。キラーと被害者の陣営が両方分かり、自殺でないときだけ true / false。どちらかが不明なら null。
   * 読み取り時に Worker が付ける(保存はしない)
   */
  teamkill: boolean | null;
  /** 距離(m)。不明なら null */
  distanceM: number | null;
}

/** 差分の取得の位置(`<receivedAt>-<id>`。画面は不透明な文字列として扱い、前回の応答の cursor をそのまま返す) */
export type KillCursor = string;
export const KILL_CURSOR_PATTERN = /^(0|[1-9][0-9]{0,15})-([1-9][0-9]{0,15})$/;

/** 受信の正規化の件数(1 日〔UTC〕・サーバーごと。D1 feed_daily の 0004 の列) */
export interface KillfeedIngestCounts {
  /** 保存したキル */
  kills: number;
  /** killed 以外の種類のイベント(キルログには出さない) */
  otherEvents: number;
  /** killed だが被害者もキラーも読めなかったイベント(保存しない。対応表の見直しが必要な印) */
  incomplete: number;
  /** 上限(1 バッチ・1 日・全体)で捨てたキル */
  droppedKills: number;
}

/** GET /api/killfeed/kills?server=&match=&after= */
export interface KillfeedKillsResponse {
  server: ServerId;
  scope: KillfeedScope;
  /** 試合を指定したときの要約(記録外は null) */
  match: MatchSummary | null;
  /** 陣営の表示順(試合の最後のサンプルの factionScores の順 → キルに現れた順。陣営名は生データ)。陣営の印の配色に使う */
  factions: string[];
  /** 古い順。after 指定時は、それより後のものだけ */
  kills: KillEvent[];
  /** 次の差分の取得に渡す位置(キルが 1 件も無ければ after をそのまま返す。after も無ければ null) */
  cursor: KillCursor | null;
  /** after を指定した差分の応答か */
  incremental: boolean;
  /** 上限(KILLFEED_MATCH_KILLS_MAX / KILLFEED_UNRECORDED_MAX / KILLFEED_INCREMENT_MAX)で打ち切った */
  truncated: boolean;
  /** 今日(UTC)の受信の正規化の件数(このサーバー) */
  today: KillfeedIngestCounts;
  /** 受信用トークンを発行済みか(未発行なら画面は設定タブへの案内を出す) */
  configured: boolean;
}

/** 統計カード(ブラウザで KillEvent[] から計算する。src/components/lib/killstats.ts) */
export interface KillfeedTotals {
  /** キラーがいて自殺でないキル(チームキルを含む) */
  kills: number;
  /** 被害者がいるイベント(自殺・環境による死亡を含む) */
  deaths: number;
  suicides: number;
  /** kills のうちヘッドショット */
  headshots: number;
  /** teamkill === true */
  teamkills: number;
  /** kills のうち陣営が不明で teamkill を判定できなかったもの */
  teamkillUnknown: number;
  /** キラー・被害者のユニークな Steam ID の数(Steam ID が無い当事者は数えない) */
  playersInvolved: number;
  /** kills のうち距離が分かるもの */
  withDistance: number;
}

export interface KillTimeBucket {
  /** 棒の始まり(UTC epoch ミリ秒)。起点(試合の開始時刻、記録外は最初のキルの受信時刻を分に切り捨てたもの)から bucketMinutes 刻み。キルの無い棒も含める */
  start: number;
  kills: number;
  headshots: number;
}

export interface KillPlayerStat {
  /** steamId、無ければ `name:<名前>` */
  key: string;
  name: string | null;
  steamId: string | null;
  /** 最後に観測した陣営 */
  faction: string | null;
  kills: number;
  deaths: number;
  /** kills / deaths(deaths = 0 なら kills) */
  kd: number;
}

export interface KillWeaponStat {
  /** 乗り物と武器の id(無ければ名前)を連結したもの */
  key: string;
  weapon: KillWeapon;
  vehicle: KillVehicle | null;
  kills: number;
  headshots: number;
}

export interface KillDistanceBin {
  /** 下限(m。含む) */
  minM: number;
  /** 上限(m。含まない)。最後の階級は null */
  maxM: number | null;
  kills: number;
}

/** 集計の結果(画面と JSON 出力で共通) */
export interface KillfeedSummary {
  totals: KillfeedTotals;
  /** headshots / kills(kills = 0 なら null) */
  headshotRate: number | null;
  /** 距離が分かる kills のうち最長(同じ距離なら先のもの)。無ければ null */
  longest: KillEvent | null;
  /** 距離が分かる kills の平均(m)。無ければ null */
  averageDistanceM: number | null;
  timeline: { bucketMinutes: number; buckets: KillTimeBucket[] };
  /** キル数の多い順(同数はデス数の少ない順)に KILLFEED_TOP_PLAYERS 件 */
  topPlayers: KillPlayerStat[];
  /** キル数の多い順に KILLFEED_TOP_WEAPONS 件 */
  weapons: KillWeaponStat[];
  /** KILL_DISTANCE_BIN_EDGES_M による 6 階級(距離不明は含めない) */
  distance: KillDistanceBin[];
}

/** 「JSON で書き出す」の形(ブラウザで組み立ててダウンロードする。Worker の API は無い。docs/API.md 11.3) */
export interface KillfeedExport {
  format: 'wardogs-ops.killfeed';
  version: 1;
  exportedAt: number;
  /** 画面の表示に使ったタイムゾーン(値の時刻はすべて UTC epoch ミリ秒) */
  timeZone: string;
  server: { id: ServerId; name: string | null };
  scope: KillfeedScope;
  match: MatchSummary | null;
  /** 試合のサンプル(スコアの推移)。記録外・未取得なら空 */
  samples: MatchSample[];
  summary: KillfeedSummary;
  /** フィルタ・検索をかける前の全件(古い順) */
  kills: KillEvent[];
  truncated: boolean;
}

/** 正規化の対応表の項目(src/lib/killfeed/fields.ts の KILL_FIELD_CANDIDATES のキー) */
export const KILL_FIELD_NAMES = [
  'type',
  'eventAt',
  'gameTimeSec',
  'killerName',
  'killerSteamId',
  'killerFaction',
  'victimName',
  'victimSteamId',
  'victimFaction',
  'weaponId',
  'weaponName',
  'vehicleId',
  'vehicleName',
  'distanceM',
  'headshot',
  'penetration',
  'roadkill',
  'vehicleExplosion',
  'suicide',
  'flagList',
] as const;
export type KillFieldName = (typeof KILL_FIELD_NAMES)[number];

/** 正規化の結果の種類: kill = 保存する / other = killed 以外 / incomplete = killed だが当事者を読めない / invalid = オブジェクトでない */
export const FEED_NORMALIZE_RESULTS = ['kill', 'other', 'incomplete', 'invalid'] as const;
export type FeedNormalizeResult = (typeof FEED_NORMALIZE_RESULTS)[number];

/** 本文の外側の形: 配列 / events 配列を持つオブジェクト / 単独のイベント / それ以外 */
export const FEED_ENVELOPES = ['array', 'events', 'single', 'unknown'] as const;
export type FeedEnvelope = (typeof FEED_ENVELOPES)[number];

/** 正規化の試行の 1 イベント分(GET /api/feed/raw/:id/normalized) */
export interface FeedNormalizedEvent {
  /** バッチ内の位置(0 始まり) */
  index: number;
  /** 種類の項目の値(生データ。64 文字まで)。無ければ null */
  type: string | null;
  result: FeedNormalizeResult;
  /** result = kill のときの正規化の結果(id・teamkill は保存時・読み取り時に決まるため含めない。陣営は本文にあった場合だけ) */
  kill: Omit<KillEvent, 'id' | 'teamkill'> | null;
  /** 項目ごとに、対応表のどの候補名(パス)で値が取れたか。取れなかった項目は含めない */
  matched: Partial<Record<KillFieldName, string>>;
  /** どの候補にも使われなかった最上位のキー(対応表の見直し用。値は含めない。最大 32 件) */
  unmappedKeys: string[];
}

/** 正規化の試行で返すイベントの上限 */
export const FEED_NORMALIZE_PREVIEW_MAX = 50;

/** GET /api/feed/raw/:id/normalized?server= — 保存済みの生データ 1 件に、今の対応表で正規化を試した結果(保存はしない) */
export interface FeedNormalizePreviewResponse {
  server: ServerId;
  entryId: number;
  receivedAt: number;
  envelope: FeedEnvelope;
  /** 先頭から最大 FEED_NORMALIZE_PREVIEW_MAX 件 */
  events: FeedNormalizedEvent[];
  /** バッチ全体の件数 */
  counts: Record<FeedNormalizeResult, number>;
  /** 引用符の無い 16 桁以上の整数(Steam ID の可能性)を文字列として読んだ数(JSON の数値の精度落ちを避けた印。17.10.2) */
  bigIntegersQuoted: number;
}

/**
 * 第 2 段階で ServerFeedStatus(GET /api/servers/:id/feed)に足す項目。第 1 段階の型は変えず、backend は
 * `ServerFeedStatus & KillfeedFeedStatusExtra` を返す(画面は項目が無ければ第 1 段階の表示のまま)
 */
export interface KillfeedFeedStatusExtra {
  /** 生データ(feed_raw_events)も保存する。false でもキルの正規化・保存は続ける(server_feeds.raw_enabled) */
  rawEnabled: boolean;
  /** 今日(UTC)の正規化の件数 */
  killsToday: KillfeedIngestCounts;
  killLimits: { dailyKills: number; globalDailyKills: number; perBatch: number; unrecordedRetentionDays: number };
}

/** 第 2 段階で PUT /api/servers/:id/feed の本文に足す項目(enabled は第 1 段階どおり必須。rawEnabled は省略時に変えない) */
export interface KillfeedUpdateFeedExtra {
  rawEnabled?: boolean;
}
