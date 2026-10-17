/**
 * Worker のバインディング・vars の型と、D1 に保存する認証情報の形式。docs/ARCHITECTURE.md 第 5・10 章と同期(変更は architect 経由)。
 * 値はここに書かない。Astro からは `import { env } from 'cloudflare:workers'` で参照する。
 *
 * **Worker Secrets は使わない**(2026-10-16 ユーザー決定)。管理パスワードは初期設定画面(/setup)で登録して
 * D1 `admins` に PBKDF2 のハッシュで保存し、鍵は D1 `settings` の `instance_key` から HKDF で派生する
 * (docs/ARCHITECTURE.md 5.1〜5.3)。RCON の接続先とパスワードは D1 `servers`(第 15 章)。
 * 旧 Secrets(ADMIN_PASSWORD / RCON_URL / RCON_PASSWORD / SESSION_SECRET)は設定されていても読まない。
 */
export interface OpsEnv {
  // ---- bindings ----
  /**
   * D1(管理者・鍵・登録サーバー・操作ログ・人数スナップショット・ログイン失敗の記録)。**必須**。
   * 自動プロビジョニングで作られる前提。利用者が wrangler.jsonc から外した場合だけ undefined になり、
   * そのときは /setup で D1_MISSING を案内して他の画面を止める(docs/ARCHITECTURE.md 7.4)
   */
  DB?: D1Database;
  /** 静的アセット(@astrojs/cloudflare が使う) */
  ASSETS: Fetcher;

  // ---- vars(wrangler.jsonc。将来は画面の「設定」〔D1 settings〕に移す予定。docs/ARCHITECTURE.md 10.1) ----
  /**
   * @deprecated D1 必須化(2026-10-16)で効果が無くなった(D1 が無いとログインできないため、
   * 「ログ無しで書き込む」状態が存在しない)。値は読まない。削除はユーザー確認後(docs/ARCHITECTURE.md 14 章 U-12)
   */
  AUDIT_REQUIRED?: string;
  /**
   * 表示言語の言語コード(`ja` / `en` など)。既定 "ja"。対応言語(src/i18n の SUPPORTED_LANGUAGES)ならそれに固定、
   * "auto" なら Accept-Language から選ぶ。未設定・未対応は "ja"(docs/ARCHITECTURE.md 13.2)。
   * Intl に渡す locale(`ja-JP` など)への対応はコード側(src/i18n/index.ts の LANGUAGE_TO_LOCALE)で持つ
   */
  LANGUAGE?: string;
  /** 日時表示のタイムゾーン(IANA 名)。既定 "Asia/Tokyo"。Intl が受け付けない値は既定に戻す */
  TIMEZONE?: string;
}

// ============================================================
// D1 に保存する認証情報の形式(docs/ARCHITECTURE.md 5.2・5.3、db/migrations/0002_servers.sql)
// ============================================================

/**
 * 管理パスワードのハッシュ方式。保存形式は
 * `pbkdf2-sha256$<反復回数(10 進)>$<salt(base64url)>$<導出値(base64url)>`(区切りは `$`、base64url はパディング無し)
 */
export const PASSWORD_HASH_SCHEME = 'pbkdf2-sha256';
/**
 * 新しく保存するときの PBKDF2-HMAC-SHA256 の反復回数。
 * 実測(2026-10-16): ローカルの workerd(wrangler dev)で 1 回あたり約 0.44 µs/反復(1 万回 ≒ 4.4 ms、10 万回 ≒ 44 ms)。
 * 無料プランの CPU 10 ms/リクエストに収めるため 1 万回にした。本番の Workers での実測は要確認(C-20)。
 * 値を上げた場合は、ログイン成功時に古い反復回数のハッシュを新しい値で保存し直す(docs/ARCHITECTURE.md 5.2)
 */
export const PASSWORD_HASH_ITERATIONS = 10_000;
/** 検証で受け付ける反復回数の範囲(範囲外の保存値は破損として扱い、ログインを失敗させる)。上限は Workers の PBKDF2 の上限(要確認 C-20) */
export const PASSWORD_HASH_ITERATIONS_MIN = 1_000;
export const PASSWORD_HASH_ITERATIONS_MAX = 100_000;
/** salt の長さ(バイト。ランダム) */
export const PASSWORD_HASH_SALT_BYTES = 16;
/** 導出値の長さ(バイト) */
export const PASSWORD_HASH_BYTES = 32;

/** D1 settings の instance_key の長さ(バイト。ランダム。値は base64url で保存) */
export const INSTANCE_KEY_BYTES = 32;
/** admins.session_stamp の長さ(バイト。ランダム。値は base64url で保存) */
export const SESSION_STAMP_BYTES = 16;

/**
 * D1 settings のキー。**どの API の応答にも値を含めない**(instance_key は全鍵の元)。
 * 将来 vars(LANGUAGE / TIMEZONE)を画面の設定に移すときは、ここにキーを足し、API で返すキーを明示的に列挙する
 */
export const SETTINGS_KEYS = ['instance_key'] as const;
export type SettingsKey = (typeof SETTINGS_KEYS)[number];

/** RCON パスワード(画面から入力したもの)がこれ未満なら一覧で警告を出す(Worker からは強制できない) */
export const RCON_PASSWORD_WARN_LENGTH = 24;

// ============================================================
// Cron Trigger(docs/ARCHITECTURE.md 17.3・17.4。wrangler.jsonc の triggers.crons)
// ============================================================

/**
 * Cron の式(UTC。1 分ごと)。wrangler.jsonc の triggers.crons(最上位と env.gmkz)と一致させる。
 * scheduled ハンドラ(src/worker.ts)はこの値と controller.cron を比べず、1 本だけの前提で動く
 */
export const RECORDING_CRON = '* * * * *';
/**
 * 掃除(古い生データ・試合・日次カウンタの削除。17.7)を行う分(UTC の「分」)。毎時この分の実行でだけ行う。
 * 0 分を避けるのは、他のスケジュール処理と時刻が重なりにくくするため(根拠は弱い。値は任意)
 */
export const CLEANUP_MINUTE_UTC = 17;
/** 1 回の掃除で消す行数の上限(1 つの表あたり。D1 の 1 クエリの実行時間と書き込み枠を抑える) */
export const CLEANUP_BATCH_ROWS = 2000;
/** Cron 1 回で同時に問い合わせるサーバー数(Workers の同時接続 6 の内側に収める) */
export const CRON_RCON_CONCURRENCY = 3;

/**
 * scheduled ハンドラが受け取る env のうち、Cron の処理(src/lib/cron.ts。backend)が使うもの。
 * fetch と同じ Worker・同じバインディングなので、`import { env } from 'cloudflare:workers'` で取っても同じ値になる。
 * Cron の処理はログイン・CSRF・middleware を通らない(リクエストではないため)。D1 の判定(probeD1)も行わず、
 * 最初のクエリが失敗したら(D1 が無い・0003 未適用)何もせずに終える
 */
export type CronEnv = Pick<OpsEnv, 'DB' | 'TIMEZONE'>;
