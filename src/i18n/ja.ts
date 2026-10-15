/**
 * 日本語(言語コード ja)のメッセージカタログ(既定の言語。キーの正本)。docs/ARCHITECTURE.md 第 13 章。
 * - 画面の文言はここに集約し、コンポーネント・Astro ページに直接書かない
 * - キーはドット区切りのフラットな文字列。`{name}` の形でパラメータを埋め込める
 * - `error.<ApiErrorCode>` と `validation.<ValidationIssue>` は全コード分が必須(型で強制)
 * - RCON から返る生データ(マップ名、陣営名、プレイヤー名など)はカタログに入れない(翻訳しない)
 * - 他の言語を足すときは `src/i18n/<言語コード>.ts` を `Catalog` 型(全キー必須)で作る(手順は docs/ARCHITECTURE.md 13.7)
 */
import type { ApiErrorCode, AuditEventType, AuditStatus, SetupWarning, ValidationIssue, WriteAction } from '../types/api';

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

  // 共通(画面)
  'common.refresh': '再読み込み',
  'common.loading': '読み込み中…',
  'common.lastUpdated': '最終更新 {time}',
  'common.autoRefresh': 'このタブを表示している間、{seconds} 秒ごとに自動で更新します。',
  'common.manualRefresh': '自動では更新しません。「再読み込み」で最新にします。',
  'common.staleData': '前回取得した内容を表示しています。',
  'common.unknown': '不明',
  'common.none': '−',
  'common.close': '閉じる',
  'common.cancel': 'キャンセル',
  'common.rconDetail': 'RCON からの応答:',
  'common.fieldLine': '{field}: {issue}',

  // レイアウト
  'layout.title': '{page} | {app}',
  'layout.skipToMain': '本文へ移動',
  'nav.label': 'メインメニュー',
  'nav.status': '状態',
  'nav.players': 'プレイヤー',
  'nav.bans': 'BAN',
  'nav.audit': '操作ログ',
  'header.operator': '操作者: {name}',
  'header.operatorAnonymous': '操作者名なし(セッション {tag})',
  'header.sessionExpires': 'ログインの有効期限 {time}',
  'notice.label': 'お知らせ',
  'stage.readOnly': '読み取り専用で動いています。kick・BAN・メッセージなどの操作はできません。',
  'stage.writesWithoutAudit': '操作ログを残さずに操作できる状態です。誰が何をしたかが記録されません。',

  // 項目名(入力検証の表示用)
  'field.steamId': 'Steam ID',
  'field.reason': '理由',
  'field.message': 'メッセージ',
  'field.map': 'マップ',

  // 操作の名前(WriteAction ごと。全コード必須)
  'action.kick': 'kick',
  'action.ban': 'BAN',
  'action.unban': 'BAN 解除',
  'action.broadcast': '全体メッセージ',
  'action.message': '個別メッセージ',
  'action.map': 'マップ変更',
  'action.match_end': '試合終了',

  // 操作ボタンの可否(capabilities と段階)
  'gate.writesDisabled': '読み取り専用のため使えません。',
  'gate.missing': 'このサーバーのビルドでは使えません。',
  'gate.unknown': '未確認(このサーバーで使えるか確認できていません。実行時の結果で判断します)。',
  'gate.line': '{action}: {note}',

  // 確認ダイアログ(confirm.<WriteAction> は全コード必須)
  'confirm.title': '操作の確認',
  'confirm.kick': '{target} をサーバーから退出させます。',
  'confirm.ban': '{target} を BAN します。このプレイヤーは再接続できなくなります。',
  'confirm.unban': '{target} の BAN を解除します。',
  'confirm.broadcast': 'サーバーの全員に次のメッセージを送ります。',
  'confirm.message': '{target} に次のメッセージを送ります。',
  'confirm.map': 'マップを {map} に変更します。',
  'confirm.match_end': '現在の試合を終了します。',
  'confirm.operation': '操作',
  'confirm.target': '対象',
  'confirm.targetValue': '{name}(Steam ID {steamId})',
  'confirm.unknownTarget': '(名前不明)',
  'confirm.reason': '理由',
  'confirm.noReason': '(なし)',
  'confirm.messageBody': 'メッセージ',
  'confirm.mapLabel': 'マップ',
  'confirm.mapValue': '{name}({id})',
  'confirm.reasonLabel': '理由(任意、{max} 文字まで)',
  'confirm.messageLabel': 'メッセージ(改行不可、{max} 文字まで)',
  'confirm.destructive': '影響の大きい操作です。内容をよく確認してください。',
  'confirm.acknowledge': '上の内容で実行することを確認しました',
  'confirm.expires': '{time} までに実行してください。過ぎた場合はやり直しになります。',
  'confirm.next': '確認へ進む',
  'confirm.preparing': '確認しています…',
  'confirm.execute': '実行する',
  'confirm.executing': '実行しています…',
  'confirm.success': '{action} を実行しました。',
  'confirm.failed': '{action} を実行できませんでした。',
  'confirm.prepareFailed': '確認の準備ができませんでした。',
  'confirm.restart': '最初からやり直す',

  // 状態(/)
  'status.title': 'サーバーの状態',
  'status.serverName': 'サーバー名',
  'status.map': 'マップ',
  'status.players': '人数',
  'status.playersValue': '{current} / {max}',
  'status.factionScores': '陣営スコア',
  'status.noScores': 'スコアの情報はありません。',
  'status.rotation': 'ローテーション位置',
  'status.rotationValue': '現在 {now} / 次 {next}',
  'status.broadcast.title': '全体メッセージ',
  'status.broadcast.label': 'メッセージ(改行不可、{max} 文字まで)',
  'status.broadcast.submit': '送信内容を確認',
  'status.mapChange.title': 'マップ変更',
  'status.mapChange.label': '変更先のマップ',
  'status.mapChange.placeholder': '選んでください',
  'status.mapChange.submit': 'マップ変更を確認',
  'status.mapChange.unavailable': 'マップ一覧を取得できませんでした。',
  'status.dangerZone': '影響の大きい操作',
  'status.matchEnd.help': '現在の試合を終了させます。押すと確認画面が開きます。',
  'status.matchEnd.submit': '試合終了を確認',

  // プレイヤー(/players)
  'players.title': '接続中のプレイヤー',
  'players.count': '{count} 人',
  'players.empty': '接続中のプレイヤーはいません。',
  'players.col.name': '名前',
  'players.col.faction': '陣営',
  'players.col.kd': 'K / D',
  'players.col.ping': 'ping',
  'players.col.steamId': 'Steam ID',
  'players.col.actions': '操作',
  'players.kdValue': '{kills} / {deaths}',
  'players.pingValue': '{ping} ms',
  'players.invalidSteamId': 'Steam ID の形式が想定と違うため操作できません。',
  'players.rowActions': '{name} への操作',

  // BAN(/bans)
  'bans.title': 'BAN 一覧',
  'bans.count': '{count} 件',
  'bans.empty': 'BAN されているプレイヤーはいません。',
  'bans.col.steamId': 'Steam ID',
  'bans.col.knownName': '名前(操作ログより)',
  'bans.col.bannedAt': '日時',
  'bans.col.reason': '理由',
  'bans.col.bannedBy': '実行者',
  'bans.col.actions': '操作',
  'bans.unban': '解除',

  // 操作ログ(/audit。audit.event.<AuditEventType>・audit.status.<AuditStatus> は全コード必須)
  'audit.title': '操作ログ',
  'audit.unavailable': '操作ログ用のデータベースが使えないため表示できません。',
  'audit.empty': '記録はありません。',
  'audit.loadMore': 'さらに {count} 件読み込む',
  'audit.end': 'これより古い記録はありません。',
  'audit.col.time': '日時',
  'audit.col.operator': '操作者',
  'audit.col.event': '操作',
  'audit.col.target': '対象',
  'audit.col.details': '内容',
  'audit.col.result': '結果',
  'audit.anonymous': '(名前なし)セッション {tag}',
  'audit.param.reason': '理由: {value}',
  'audit.param.message': 'メッセージ: {value}',
  'audit.param.map': 'マップ: {value}',
  'audit.rconStatus': 'RCON 応答 {status}',
  'audit.event.kick': 'kick',
  'audit.event.ban': 'BAN',
  'audit.event.unban': 'BAN 解除',
  'audit.event.broadcast': '全体メッセージ',
  'audit.event.message': '個別メッセージ',
  'audit.event.map': 'マップ変更',
  'audit.event.match_end': '試合終了',
  'audit.event.login': 'ログイン',
  'audit.event.logout': 'ログアウト',
  'audit.status.pending': '実行中',
  'audit.status.succeeded': '成功',
  'audit.status.failed': '失敗',
  'audit.status.unknown': '結果不明',
} as const satisfies Record<string, string> &
  Record<`error.${ApiErrorCode}`, string> &
  Record<`validation.${ValidationIssue}`, string> &
  Record<`setup.warning.${SetupWarning}`, string> &
  Record<`action.${WriteAction}`, string> &
  Record<`confirm.${WriteAction}`, string> &
  Record<`audit.event.${AuditEventType}`, string> &
  Record<`audit.status.${AuditStatus | 'unknown'}`, string>;

/** メッセージのキー(ja が正本) */
export type MessageKey = keyof typeof ja;
/** 言語ごとのカタログの型。全キー必須 */
export type Catalog = Record<MessageKey, string>;
