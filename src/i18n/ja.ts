/**
 * 日本語(言語コード ja)のメッセージカタログ(既定の言語。キーの正本)。docs/ARCHITECTURE.md 第 13 章。
 * - 画面の文言はここに集約し、コンポーネント・Astro ページに直接書かない
 * - キーはドット区切りのフラットな文字列。`{name}` の形でパラメータを埋め込める
 * - `error.<ApiErrorCode>` と `validation.<ValidationIssue>` は全コード分が必須(型で強制)
 * - RCON から返る生データ(マップ名、陣営名、プレイヤー名など)はカタログに入れない(翻訳しない)
 * - 他の言語を足すときは `src/i18n/<言語コード>.ts` を `Catalog` 型(全キー必須)で作る(手順は docs/ARCHITECTURE.md 13.7)
 */
import type { ApiErrorCode, SetupWarning, ValidationIssue } from '../types/api';

export const ja = {
  // 共通
  'app.name': 'wardogs-ops',
  'app.preparing': '準備中です。',

  // ログイン
  'login.title': 'ログイン',
  'login.password': 'パスワード',
  'login.operator': '操作者名(任意)',
  'login.operatorHelp': '操作ログに記録する名前です。複数人で使う場合に入力してください。',
  'login.submit': 'ログイン',
  'login.failed': 'パスワードが違います。',
  'login.locked': 'ログインの失敗が続いたため、約 {minutes} 分間ログインできません。',
  'login.forbidden': 'このリクエストは受け付けられません。ページを開き直してください。',
  'login.badRequest': '送信内容を読み取れませんでした。もう一度お試しください。',
  'logout.submit': 'ログアウト',

  // 設定の案内(/setup)
  'setup.title': '設定の確認',
  'setup.configured': '設定済みです。',
  'setup.toLogin': 'ログイン画面へ',
  'setup.intro': '次の設定が足りないか、正しくありません。Cloudflare のダッシュボードで Workers & Pages > wardogs-ops > Settings > Variables and Secrets を開き、値を入れ直してください。',
  'setup.missingTitle': '未設定の Secrets',
  'setup.warningsTitle': '確認が必要な項目',
  'setup.readme': '詳しい手順は README の「Secrets の意味」と「困ったとき」を参照してください。',

  // 設定の警告(SetupWarning ごと。全コード必須)
  'setup.warning.ADMIN_PASSWORD_MISSING': 'ADMIN_PASSWORD(ログインパスワード)が設定されていません。',
  'setup.warning.ADMIN_PASSWORD_TOO_SHORT': 'ADMIN_PASSWORD が短すぎます。16 文字以上にしてください。',
  'setup.warning.ADMIN_PASSWORD_EQUALS_RCON_PASSWORD': 'ADMIN_PASSWORD と RCON_PASSWORD が同じです。別の値にしてください。',
  'setup.warning.RCON_URL_MISSING': 'RCON_URL(RCON の接続先)が設定されていません。',
  'setup.warning.RCON_URL_INVALID': 'RCON_URL の形式が正しくありません。http://ホスト名:ポート の形にしてください(末尾の /v1 は付けません)。',
  'setup.warning.RCON_URL_IS_IP_ADDRESS': 'RCON_URL に IP アドレスは使えません。ホスト名を用意してください(README の「IP アドレスしか無い場合」を参照)。',
  'setup.warning.RCON_URL_HAS_CREDENTIALS': 'RCON_URL にユーザー名やパスワードを含めないでください。パスワードは RCON_PASSWORD に入れます。',
  'setup.warning.RCON_PASSWORD_MISSING': 'RCON_PASSWORD(RCON のパスワード)が設定されていません。',
  'setup.warning.RCON_PASSWORD_SHORT': 'RCON_PASSWORD が短めです。ランダムな 32 文字以上を推奨します。',
  'setup.warning.SESSION_SECRET_TOO_SHORT': 'SESSION_SECRET が短すぎます。32 文字以上にするか、削除してください。',
  'setup.warning.D1_MISSING': '操作ログ用のデータベース(D1)が見つかりません。読み取り専用で動いています。',
  'setup.warning.D1_NOT_MIGRATED': '操作ログ用のデータベース(D1)の準備(マイグレーション)が済んでいません。読み取り専用で動いています。',
  'setup.warning.AUDIT_DISABLED_WRITES_ALLOWED': '操作ログを残さずに操作できる設定になっています(AUDIT_REQUIRED="false")。',
  'setup.warning.LOGIN_FAILURES_HIGH': '直近 1 時間にログインの失敗が多数あります。パスワードが推測されにくいものか確認し、心当たりが無ければ ADMIN_PASSWORD の変更を検討してください。',

  // API エラー(ApiErrorCode ごと。全コード必須)
  'error.BAD_REQUEST': 'リクエストを読み取れませんでした。',
  'error.VALIDATION_FAILED': '入力内容を確認してください。',
  'error.UNAUTHENTICATED': 'ログインし直してください。',
  'error.FORBIDDEN_ORIGIN': 'このリクエストは受け付けられません。ページを開き直してください。',
  'error.NOT_FOUND': '対象が見つかりません。',
  'error.METHOD_NOT_ALLOWED': 'この操作はできません。',
  'error.PAYLOAD_TOO_LARGE': '送信内容が大きすぎます。',
  'error.UNSUPPORTED_MEDIA_TYPE': 'リクエストの形式が正しくありません。',
  'error.RATE_LIMITED': '操作が多すぎます。{seconds} 秒ほど待ってからお試しください。',
  'error.CONFIRM_INVALID': '確認の情報が正しくありません。最初からやり直してください。',
  'error.CONFIRM_EXPIRED': '確認の有効期限が切れました。最初からやり直してください。',
  'error.ALREADY_EXECUTED': 'この操作は実行済みです。',
  'error.CAPABILITY_MISSING': 'このサーバーでは使えない操作です。',
  'error.WRITES_DISABLED': '操作ログが使えないため、操作を止めています。',
  'error.NOT_CONFIGURED': '設定が足りません。設定画面を確認してください。',
  'error.RCON_UNREACHABLE': 'RCON に接続できません。',
  'error.RCON_TIMEOUT': 'RCON の応答がありません。実行されたかどうかは状態を再読み込みして確認してください。',
  'error.RCON_AUTH_FAILED': 'RCON の認証に失敗しました。',
  'error.RCON_RATE_LIMITED': 'RCON の利用回数の上限に達しました。{seconds} 秒ほど待ってからお試しください。',
  'error.RCON_ROUTE_NOT_FOUND': 'このサーバーでは使えない操作です。',
  'error.RCON_REJECTED': 'RCON が操作を受け付けませんでした。',
  'error.RCON_BAD_RESPONSE': 'RCON の応答を読み取れませんでした。',
  'error.RCON_ERROR': 'RCON でエラーが発生しました。',
  'error.INTERNAL_ERROR': '処理に失敗しました。',
  'error.NETWORK': '通信に失敗しました。接続を確認してください。',

  // 入力検証(ValidationIssue ごと。全コード必須)
  'validation.required': '入力してください。',
  'validation.too_long': '{max} 文字以内で入力してください。',
  'validation.invalid_format': '形式が正しくありません。',
  'validation.invalid_characters': '改行や制御文字は使えません。',
  'validation.not_online': 'このプレイヤーは接続していません。',
  'validation.unknown_map': 'このマップは一覧にありません。',
} as const satisfies Record<string, string> &
  Record<`error.${ApiErrorCode}`, string> &
  Record<`validation.${ValidationIssue}`, string> &
  Record<`setup.warning.${SetupWarning}`, string>;

/** メッセージのキー(ja が正本) */
export type MessageKey = keyof typeof ja;
/** 言語ごとのカタログの型。全キー必須 */
export type Catalog = Record<MessageKey, string>;
