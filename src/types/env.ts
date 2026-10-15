/**
 * Worker のバインディング・Secrets・vars の型。docs/ARCHITECTURE.md 第 10 章と同期(変更は architect 経由)。
 * 値はここに書かない。Astro からは `import { env } from 'cloudflare:workers'` で参照する。
 *
 * 必須の Secrets が欠けていても Worker は起動し、/setup で「どの名前が足りないか」だけを案内する
 * (値は出さない)。そのため Secrets も型の上では optional にしてある。
 *
 * 複数サーバー対応(docs/ARCHITECTURE.md 第 15 章)以降、必須は ADMIN_PASSWORD だけ。
 * RCON_URL / RCON_PASSWORD は任意で、両方あれば「既定サーバー」(ServerId 'default')として扱う。
 */
export interface OpsEnv {
  // ---- bindings ----
  /**
   * D1(操作ログ・人数スナップショット・ログイン失敗の記録)。
   * 利用者が wrangler.jsonc から外した場合は undefined になり得る。
   * undefined またはテーブル未作成のときは「操作ログ無し」モード(docs/ARCHITECTURE.md 7.4)
   */
  DB?: D1Database;
  /** 静的アセット(@astrojs/cloudflare が使う) */
  ASSETS: Fetcher;

  // ---- secrets(必須) ----
  /** パネルのログインパスワード。16 文字以上。満たさない場合はログインを受け付けない */
  ADMIN_PASSWORD?: string;

  // ---- secrets(任意: 既定サーバー。両方そろったときだけ有効) ----
  /**
   * 既定サーバーの RCON HTTP API の基点 URL(`http://<ホスト名>:<ポート>`)。IP アドレス直指定は不可。値をログ・応答に出さない。
   * 画面から追加するサーバー(D1 servers)とは別枠で、画面からは編集・削除できない
   */
  RCON_URL?: string;
  /** 既定サーバーの RCON パスワード(`Authorization: Bearer` に使う)。値をログ・応答に出さない */
  RCON_PASSWORD?: string;

  // ---- secrets(任意) ----
  /**
   * 設定時は ADMIN_PASSWORD と組み合わせて Cookie 署名鍵などを派生する。未設定なら ADMIN_PASSWORD のみから派生(HKDF)。
   * 画面から追加したサーバーの RCON パスワードの暗号鍵は、設定時は SESSION_SECRET だけから派生する
   * (ADMIN_PASSWORD を変えても復号できる。docs/ARCHITECTURE.md 15.3)
   */
  SESSION_SECRET?: string;

  // ---- vars ----
  /** "true"(既定。未設定も true 扱い)/ "false"。"false" のときだけ D1 無しでも書き込み操作を許す */
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

/**
 * @deprecated 複数サーバー対応前の必須 Secrets。backend が config.ts を LOGIN_REQUIRED_SECRETS に切り替え、
 * config.test.ts を更新した時点で architect が削除する(docs/ARCHITECTURE.md 15.6)
 */
export const REQUIRED_SECRETS = ['ADMIN_PASSWORD', 'RCON_URL', 'RCON_PASSWORD'] as const;
export type RequiredSecretName = (typeof REQUIRED_SECRETS)[number];

/** ログインに必須の Secrets(/setup の「未設定の Secrets」に出すのはこれだけ) */
export const LOGIN_REQUIRED_SECRETS = ['ADMIN_PASSWORD'] as const;
export type LoginRequiredSecretName = (typeof LOGIN_REQUIRED_SECRETS)[number];

/** 既定サーバーの Secrets。両方あれば既定サーバーを作る。片方だけなら RCON_URL_MISSING / RCON_PASSWORD_MISSING を警告(ログインは止めない) */
export const DEFAULT_SERVER_SECRETS = ['RCON_URL', 'RCON_PASSWORD'] as const;
export type DefaultServerSecretName = (typeof DEFAULT_SERVER_SECRETS)[number];

/** ADMIN_PASSWORD の長さの下限(README.md 3 章と同期)。満たさない場合はログイン不可 */
export const ADMIN_PASSWORD_MIN_LENGTH = 16;
/** SESSION_SECRET を設定する場合の長さの下限。満たさない場合は設定エラー扱い */
export const SESSION_SECRET_MIN_LENGTH = 32;
/** RCON_PASSWORD(および画面から入力した RCON パスワード)がこれ未満なら警告を出す(Worker からは強制できない) */
export const RCON_PASSWORD_WARN_LENGTH = 24;
