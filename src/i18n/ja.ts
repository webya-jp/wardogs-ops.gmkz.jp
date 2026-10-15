/**
 * 日本語(言語コード ja)のメッセージカタログ(既定の言語。キーの正本)。docs/ARCHITECTURE.md 第 13 章。
 * - 画面の文言はここに集約し、コンポーネント・Astro ページに直接書かない
 * - キーはドット区切りのフラットな文字列。`{name}` の形でパラメータを埋め込める
 * - `error.<ApiErrorCode>` と `validation.<ValidationIssue>` は全コード分が必須(型で強制)
 * - RCON から返る生データ(マップ名、陣営名、プレイヤー名など)はカタログに入れない(翻訳しない)
 * - 他の言語を足すときは `src/i18n/<言語コード>.ts` を `Catalog` 型(全キー必須)で作る(手順は docs/ARCHITECTURE.md 13.7)
 */
import type { ApiErrorCode, ValidationIssue } from '../types/api';

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
  'logout.submit': 'ログアウト',

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
  Record<`validation.${ValidationIssue}`, string>;

/** メッセージのキー(ja が正本) */
export type MessageKey = keyof typeof ja;
/** 言語ごとのカタログの型。全キー必須 */
export type Catalog = Record<MessageKey, string>;
