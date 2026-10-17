# Worker 内部 API 契約

作成日: 2026-10-15(JST)/ 更新: 2026-10-17(キルフィード第 2 段階: 11 章。第 1 段階の契約は変えず追加のみ。ARCHITECTURE 17.10)、2026-10-17(スコア記録とキルフィードの観測モード: 1 章の例外、4.1、7.2〜7.4、8〜10 章、5 章のコード。ARCHITECTURE 第 17 章)、2026-10-17(`/api/status` に `experiences`・次のマップを追加。3 章)、2026-10-16(複数サーバー対応: 1.2、3・4 章の `server`、5 章のコード、7 章。Worker Secrets の廃止: 1 章、2 章の `/setup`、5 章、既定サーバーの削除)/ 担当: architect。型の正本は `src/types/api.ts`(本書と食い違ったら司令塔に報告)。
構成・認証の詳細は `docs/ARCHITECTURE.md`。RCON の確度は第 6 章と `docs/research/wardogs-rcon.md`。

## 1. 共通

- ベース: Worker と同じオリジン(`https://<worker>.<account>.workers.dev` またはカスタムドメイン)。
- 認証: すべての `/api/*` はログイン Cookie(`__Host-wo_session`)が必要。無い・不正・期限切れは 401 `UNAUTHENTICATED`。
  - **例外: `POST /api/ingest/events`**(10 章。ゲームサーバーからのキルフィードの受信)。ログイン Cookie・Origin 検査・管理者の有無を見ず、サーバーごとの受信用トークン(`Authorization: Bearer`)で認証する。本文の上限は 64 KiB(下の 8 KiB ではない)。パスの完全一致だけが対象(ARCHITECTURE 5.8)。
- D1 が無い・マイグレーション未適用のときは、すべての `/api/*` が 503 `NOT_CONFIGURED`。管理者が未登録(`/setup` で管理パスワードを登録する前)のときは 503 `SETUP_REQUIRED`(ARCHITECTURE 5.1.1)。いずれも認証より先に判定する。
- Worker Secrets は使わない(2026-10-16)。管理パスワード・鍵・RCON の接続先とパスワードはすべて D1 にある(ARCHITECTURE 第 5 章)。
- POST / PUT / DELETE: `Content-Type: application/json` 必須(415)、本文 8 KiB まで(413)、Origin 検査(403 `FORBIDDEN_ORIGIN`。ARCHITECTURE 5.5)。本文の無い DELETE は受け付けない(7 章の DELETE は本文必須)。
- 未定義のメソッドは 405 `METHOD_NOT_ALLOWED`。
- 応答ヘッダ: `Content-Type: application/json; charset=utf-8`、`Cache-Control: no-store`、`X-Content-Type-Options: nosniff`。
- 時刻: UTC epoch ミリ秒(number)。画面で vars `TIMEZONE`(既定 `Asia/Tokyo`)に変換する(ARCHITECTURE 13.4)。
- 応答形式:

```jsonc
// 成功
{ "ok": true, "data": { /* 各 API の型 */ } }
// 失敗
{ "ok": false, "error": { "code": "RCON_RATE_LIMITED", "message": "RCON rate limited", "retryAfterSec": 30 } }
// 入力の検証失敗
{ "ok": false, "error": { "code": "VALIDATION_FAILED", "fields": { "message": "too_long" } } }
```

### 1.1 エラーは機械可読なコードで返す(多言語化)

- **API は表示用の文言を返さない**。画面は `error.code`(`ApiErrorCode`)でメッセージカタログの `error.<code>` を引き、`fields` の値(`ValidationIssue`: `required` `too_long` `invalid_format` `invalid_characters` `not_online` `unknown_map` `out_of_range` `ip_address` `duplicate` `same_as_admin_password` `mismatch` `reenter_required`)で `validation.<issue>` を引く(ARCHITECTURE 13.5)。
- `message` は**任意・英語固定**の開発者向けの短い説明(ログ調査用)。**画面には出さない**。Secrets・接続先・内部例外の文字列・入力値を含めない。
- `retryAfterSec` などの数値はカタログの文言に埋め込むパラメータとして使う。
- `rconMessage` は RCON が返したエラー文を 200 文字に切り詰め制御文字を除いたもの(`RCON_REJECTED` のときのみ)。RCON の生データなので翻訳せず、補足としてそのまま表示する。
- 成功応答も同様で、確認ダイアログ・操作ログの文は Worker で作らない(正規化済みの値だけを返し、画面がカタログで組み立てる)。

### 1.2 対象サーバー(`server`)

複数サーバー対応(ARCHITECTURE 第 15 章)。RCON を呼ぶ API は対象サーバーを `ServerId`(`"3"` など = 画面から登録したサーバーの `servers.id`。形式 `SERVER_ID_PATTERN`)で受け取る。Secrets による既定サーバー(`"default"`)は 2026-10-16 に廃止した(`"default"` は形式不正)。

| API | 渡し方 | 省略時 |
|---|---|---|
| `GET /api/status` `players` `bans` `maps` `capabilities` | クエリ `?server=<id>` | Cookie(`__Host-wo_server`)→ 表示順で最初に使えるサーバー(更新前から開いていたタブとの互換用。画面は常に明示して送る) |
| `POST /api/actions/prepare` `execute` | 本文 `server` | **不可**(400 `VALIDATION_FAILED`、`fields.server = required`) |
| `GET /api/audit` | クエリ `?server=<id>` または `all` | `all`(全サーバー) |
| `GET /api/matches`、`GET /api/feed/raw`、`GET /api/killfeed/kills`、`GET /api/feed/raw/:id/normalized` | クエリ `?server=<id>`(必須) | **不可**(400 `VALIDATION_FAILED`、`fields.server = required`)。RCON は呼ばない。削除済みのサーバーの id でもエラーにせず 0 件を返す(`/api/audit` と同じ) |
| `GET /api/matches/:id/samples` | パスの試合 id(`server` は任意。指定して試合のサーバーと違えば 404 `MATCH_NOT_FOUND`) | − |
| `/api/servers/*` | パスの `:id` | − |

サーバーを解決できないときのエラー(すべての RCON を呼ぶ API で共通):

| 状況 | 応答 |
|---|---|
| 形式が不正 | 400 `VALIDATION_FAILED`(`fields.server = invalid_format`) |
| 該当するサーバーが無い(削除済み) | 404 `SERVER_NOT_FOUND` |
| 無効にしてある | 409 `SERVER_DISABLED` |
| 保存済みの RCON パスワードを復号できない(通常は起きない。ARCHITECTURE 15.3) | 409 `SERVER_NEEDS_PASSWORD` |
| サーバーが 1 台も無い(省略時の解決で見つからない) | 409 `NO_SERVERS` |

RCON パスワード(平文・暗号文とも)、管理パスワードのハッシュ、`instance_key` はどの応答にも含めない。

## 2. ページ側のエンドポイント(フォーム)

| メソッド・パス | 本文 | 結果 |
|---|---|---|
| `GET /setup` | − | D1 の不備なら案内(`D1_MISSING` / `D1_NOT_MIGRATED`。フォームなし)。管理者が未登録なら登録フォーム。登録済みなら `/login` へ 303(ログイン済みなら `/`)。ARCHITECTURE 5.1.1・9.1 |
| `POST /setup` | `application/x-www-form-urlencoded`: `password`(必須、16〜256 文字)、`passwordConfirm`(必須、`password` と完全一致) | 成功: 管理者を登録し `/login?registered=1` へ 303(自動ログインはしない)。失敗: 下表のステータスでフォームを再表示(入力したパスワードは再表示しない)。Origin 不一致: 403。D1 の不備: フォームを処理せず案内を表示(503) |
| `GET /login` | − | ログインフォーム。ログイン済みなら `/` へ 303。管理者が未登録なら `/setup` へ 303。`?registered=1` のときは登録完了の案内を出す |
| `POST /login` | `application/x-www-form-urlencoded`: `password`(必須、256 文字まで評価)、`operator`(任意、32 文字まで) | 成功: Cookie 発行 + `/` へ 303。失敗: 401 でフォーム再表示(文言はカタログ `login.failed`)。ロック中: 429 でフォーム再表示(`login.locked`、残り分数)。Origin 不一致: 403 |
| `POST /logout` | なし(Origin 検査あり) | Cookie 削除 + `/login` へ 303 |

`POST /setup` の失敗(`SetupFormError`。文言はカタログ `setup.error.<code>`、HTTP ステータスは `SETUP_FORM_ERROR_STATUS`):

| code | HTTP | 意味 |
|---|---|---|
| `BAD_REQUEST` | 400 | フォームを読み取れない |
| `PASSWORD_TOO_SHORT` | 400 | 16 文字(`ADMIN_PASSWORD_MIN_LENGTH`、コードポイント)未満。空を含む |
| `PASSWORD_TOO_LONG` | 400 | 256 文字(`ADMIN_PASSWORD_MAX_LENGTH`)超 |
| `PASSWORD_MISMATCH` | 400 | 確認入力が一致しない |
| `PASSWORD_SAME_AS_RCON` | 400 | 登録済みサーバーの RCON パスワードと同じ(管理者を消して登録し直す場合) |
| `SETUP_ALREADY_DONE` | 409 | 管理者が既に登録されている(先に誰かが登録した・二重送信)。登録は `admins` が 0 行のときだけ、条件付きの INSERT で受け付ける |

- 判定の順序: D1 の判定 → Origin 検査 → 管理者の有無(登録済みなら `SETUP_ALREADY_DONE`)→ 入力検証 → 登録(条件付き INSERT。0 行なら `SETUP_ALREADY_DONE`)。
- 成功時は `settings_audit_log` に `admin_register` を記録する(3 章の `kind=settings` で見える)。
- `/setup` にはログイン失敗のようなレート制限は掛けない(登録は 1 回だけで、総当たりの対象が無い)。

## 3. 読み取り API

### `GET /api/session` → `SessionResponse`

ログイン中のセッション情報、機能の可否(`features`。D1 必須化により通常はすべて true)、設定の警告(`warnings`。`SetupWarning` の配列)。RCON は呼ばない。`server` は受け取らない。

`warnings` の変更(2026-10-16): Worker Secrets の廃止で、Secrets に関する警告(`ADMIN_PASSWORD_*`、`RCON_URL_*`、`RCON_PASSWORD_*`、`SESSION_SECRET_TOO_SHORT`)と `AUDIT_DISABLED_WRITES_ALLOWED` を削除した。ログイン後に入り得るのは `LOGIN_FAILURES_HIGH` と `SERVER_PASSWORDS_UNREADABLE`(登録サーバーに復号できないパスワードがある。通常は起きない)だけ。`D1_MISSING` / `D1_NOT_MIGRATED` はログイン前の `/setup` にだけ出る。

`status` は `pending` / `succeeded` / `failed` / `unknown`。`unknown` = RCON がタイムアウトし、実行されたかどうか不明(DB 上は `failed` + `error_code = RCON_TIMEOUT` のまま。DB スキーマは変えず、API の変換で `unknown` にする)。

`warnings` には設定の警告に加え、全体のログイン失敗が直近 1 時間で 50 回を超えたときに `LOGIN_FAILURES_HIGH` が入る(ログインは止めない。ARCHITECTURE 5.6)。文言は画面がカタログの `setup.warning.<コード>` で引く。

### `GET /api/capabilities?server=<id>` → `CapabilitiesResponse`

対象サーバーの RCON `GET /v1/capabilities` を解釈し、本パネルの読み取り・書き込みごとに `available` / `missing` / `unknown` を返す。Worker で 10 分キャッシュ(サーバーごと)。`?refresh=1` でキャッシュを無視(サーバーごとに 1 分に 1 回まで。超過時はキャッシュを返す)。capabilities が取れなくてもエラーにせず `source: "unavailable"`、全項目 `unknown` で 200 を返す。

### `GET /api/status?server=<id>` → `StatusResponse`

RCON `GET /v1/status`。成功時は人数スナップショットを記録(サーバーごとに 5 分に 1 行。`server_snapshots`)。

2026-10-17 追加(サイドバーのサーバーカード・試合の要点用。ARCHITECTURE 9.3)。新しい API は作らず、この応答を広げる:

- `experiences`: `/v1/status` の `experiences[]` の文字列要素(最大 `STATUS_EXPERIENCES_MAX` 件、各 `STATUS_EXPERIENCE_MAX_LENGTH` 文字、制御文字を除く)。追加の RCON 呼び出しなし。画面は「ゲームモード」として表示する(モードを表すかは要確認 R-19)。
- `rotation.count` / `rotation.nextMap` / `rotation.nextMapName`: RCON `GET /v1/rotation` の `entries` から求める。**結果は isolate 内にサーバーごと `ROTATION_CACHE_SEC`(300 秒)保持**し(キーは capabilities と同じ `${serverId}|${baseUrl}`)、30 秒ごとのポーリングで毎回は呼ばない。`map` / `match_end` の execute が成功したとき、そのサーバーの分を破棄する。
- `/v1/rotation` が capabilities で `missing`、または失敗(タイムアウト・形式不正・`enabled: false`)した場合は 3 項目とも null にし、**`/api/status` 自体は失敗にしない**(状態の表示を優先)。失敗は 60 秒間キャッシュし、毎回呼び直さない。
- `/v1/rotation` の呼び出しは `/v1/status` の成功後に行い、そのタイムアウトは 3 秒(`/api/status` 全体の応答を遅らせすぎないため)。
- backend の実装が済むまで 3 項目は省略され得る(型は `?`)。画面は省略を null と同じに扱う。
- `scoreCap` / `matchSeconds`(2026-10-17 追加): `/v1/status` の同名の項目(ビルドによって無い。R-21)。正の数(`matchSeconds` は 0 以上)でなければ null。概要タブのスコア記録の節で上限の表示に使う。省略の扱いは上と同じ。

### `GET /api/players?server=<id>` → `PlayersResponse`

RCON `GET /v1/players`。`cash` 等の本パネルで使わない項目は返さない。

### `GET /api/bans?server=<id>` → `BansResponse`

RCON `GET /v1/bans`。`knownName` を audit_log(event=ban、succeeded、同じ Steam ID の最新)から補完する(サーバーで絞らない。Steam ID は全サーバー共通のため)。

### `GET /api/maps?server=<id>` → `MapsResponse`

RCON `GET /v1/catalog/maps`。マップ変更のプルダウン用。

### `GET /api/audit?kind=operations&server=all&limit=50&before=<id>` → `AuditResponse`

ログを新しい順に返す。RCON は呼ばない。`available` は D1 必須化により常に true(形は互換のため残す)。

| クエリ | 値 | 既定 |
|---|---|---|
| `kind` | `operations`(audit_log: RCON の操作・login・logout)/ `settings`(settings_audit_log: サーバーの追加・変更・削除、管理者の登録) | `operations` |
| `server` | `all` / `ServerId`。`operations` で `ServerId` を指定すると、その対象サーバーの書き込み操作だけ(login / logout は除く)。`settings` ではその対象サーバーの変更だけ(`admin_register` は除く)。`default` は形式不正(400) | `all` |
| `limit` | 1〜100 | 50 |
| `before` | 前ページの `nextBefore`(`kind` ごとに id の系列が別) | − |

- 2 つの `kind` は別テーブルで id の系列が違うため、1 回の応答に混ぜない(ARCHITECTURE 15.2)。
- `entries[].serverId` / `serverName`: 書き込み操作は対象サーバー(`serverName` は操作時点の表示名)。D1 の `server_id` が NULL の書き込み操作の行(複数サーバー対応前の行)は両方 null(画面は「不明」)。login / logout・`admin_register` も両方 null。
- `settings` の行(`SETTINGS_EVENTS`。パスワード・ハッシュは `params` に含まない)。`targetSteamId` / `targetName` / `rconStatus` は null、`finishedAt` は `createdAt` と同じ:

  | event | status | errorCode | params |
  |---|---|---|---|
  | `server_add` / `server_update` / `server_delete` | `succeeded` | null | 変更内容(`name` `host` `port` `enabled` `passwordChanged`。削除は削除時点の name / host / port) |
  | `server_update_rejected` | `failed` | `VALIDATION_FAILED` | `reason: "reenter_required"`、変えようとした `host` / `port` |
  | `server_delete_rejected` | `failed` | `VALIDATION_FAILED` | `reason: "mismatch"`(入力された表示名は残さない) |
  | `server_test` | `ok` なら `succeeded`、それ以外は `failed` | 失敗時は `params.result`(`RCON_*`) | `result: "ok" \| <RCON_*>` |
  | `admin_register` | `succeeded` | null | `{}` |

  拒否の記録は 7 章の PUT(`reenter_required`)と DELETE(`confirmName` の不一致)だけ。それ以外の入力検証の失敗(400)は記録しない。D1 に status 列は無く、API が event と params から決める(未知の event の行は返さない)。`admin_register` の `operator` / `sessionTag` は null(ログイン前の操作のため)。
- `server` が存在しない id でもエラーにせず、該当 0 件として返す(削除済みサーバーのログも引けるようにするため)。形式不正は 400。

読み取り API の RCON 由来のエラーは第 5 章の `RCON_*`。

## 4. 書き込み API(二段階)

すべての書き込みは `prepare` → `execute` の 2 リクエストで行う。`execute` だけを直接呼んでも、有効な確認トークンが無ければ実行されない。どちらも本文に対象サーバー `server` が必須(1.2)。

`features.writes` が false なら、どちらも 503 `WRITES_DISABLED`(D1 必須化により通常は起きない。`AUDIT_REQUIRED` は効果なし)。

### `POST /api/actions/prepare`

本文 `PrepareRequest`:

```jsonc
{ "server": "3", "action": "kick", "params": { "steamId": "<17 桁の SteamID64>", "reason": "暴言" } }
```

| action | params | 検証 |
|---|---|---|
| `kick` | `steamId`、`reason?` | Steam ID 形式、reason 200 文字以内、接続中一覧にいること |
| `ban` | `steamId`、`reason?` | 同上(オンライン必須。R-7) |
| `unban` | `steamId` | Steam ID 形式 |
| `broadcast` | `message` | 1〜256 文字、改行・制御文字不可 |
| `message` | `steamId`、`message` | Steam ID 形式、接続中一覧にいること、本文は broadcast と同じ |
| `map` | `map` | id の形式、catalog が取れればその中にあること |
| `match_end` | `{}` | なし |

処理: 入力検証(400 `VALIDATION_FAILED`、`fields` に項目ごとの `ValidationIssue`)→ サーバーの解決(1.2 の `SERVER_*`)→ capability(そのサーバーの)が `missing` なら 409 `CAPABILITY_MISSING` → 対象の名前解決 → params の正規化(前後の空白除去など)→ 確認トークン発行。確認ダイアログの文は画面がカタログの `confirm.<action>` で組み立てる。

応答 `PrepareResponse`:

```jsonc
{
  "confirmToken": "v1.<payload>.<sig>",
  "action": "kick",
  "params": { "steamId": "<17 桁の SteamID64>", "reason": "暴言" },
  "targetName": "Example",
  "destructive": false,
  "capability": "available",
  "expiresAt": 1792050000000,
  "server": "3"
}
```

確認トークンの中身: `{ v:1, a:action, h:SHA-256(正規化した params の JSON) の先頭 128 bit, s:セッション ID, e:期限(発行から 120 秒), n:nonce 128 bit, t?:対象名, sv:ServerId, sh:SHA-256(対象サーバーの baseUrl) の先頭 128 bit }` を base64url にし、確認用鍵の HMAC-SHA256 で署名。中身は秘密ではないが改ざんできない。

- `sv` / `sh`(2026-10-16 追加): 対象サーバーと、その時点の宛先(ホスト名・ポート)。別のサーバーへのすり替えと、prepare 後の宛先の変更を execute で検出する(ARCHITECTURE 15.6)。`sv` の無い旧形式のトークンは `CONFIRM_INVALID`。

- `t`(任意): prepare で解決した対象プレイヤーの名前(最大 64 文字)。execute は RCON を呼び直さずにこの値を監査ログの `target_name` に残す。署名で保護されるため差し替えできない。画面はトークンの中身を解釈・表示しない(表示には prepare 応答の `targetName` を使う)。

### `POST /api/actions/execute`

本文 `ExecuteRequest` = prepare と同じ `server`・`action`・`params` + `confirmToken`。

検証の順序とエラー:

| 順 | 確認 | 失敗時 |
|---|---|---|
| 1 | 署名・形式 | 400 `CONFIRM_INVALID` |
| 2 | セッション ID が現在の Cookie と一致 | 400 `CONFIRM_INVALID` |
| 3 | action と params のハッシュが一致 | 400 `CONFIRM_INVALID` |
| 3' | トークンの `sv` が本文の `server` と一致し、`sh` が現在のそのサーバーの baseUrl と一致(サーバーの解決に失敗したら 1.2 の `SERVER_*`) | 400 `CONFIRM_INVALID` |
| 4 | 期限内 | 409 `CONFIRM_EXPIRED`(画面は prepare からやり直す) |
| 5 | audit_log に pending で INSERT(`confirm_nonce` UNIQUE。`server_id` / `server_name` を含む) | 重複は 409 `ALREADY_EXECUTED` |
| 6 | RCON の書き込みルートを 1 回呼ぶ(再試行なし)。**2xx なら本文が JSON でなくても・空でも成功**(本文は解釈しない。R-18) | 第 5 章の `RCON_*`。audit_log を failed に更新 |
| 7 | audit_log を succeeded に更新 | − |

応答 `ExecuteResponse`: `{ auditId, action, executedAt, server }`。

3' で `SERVER_*` になった場合と 1〜4 の失敗は、ARCHITECTURE 4.3 の規則どおり audit_log に `status=failed`・`error_code` 付きで 1 行残す(`server_id` 付き)。

注意: `RCON_TIMEOUT` は「RCON 側で実行されたかどうか不明」を意味する。画面は「結果不明。状態を再読み込みして確認してください」と表示し、自動で再実行しない。

- `map` / `match_end` が成功したとき、そのサーバーで記録中の試合があれば `match_action` で終える(8 章。ARCHITECTURE 17.5)。
- `ExecuteResponse.auditKind`(2026-10-17 追加): 省略時は `operations`(`audit_log` の id)。

### 4.1 スコア記録の開始・停止(`record_start` / `record_stop`。2026-10-17)

同じ `prepare` / `execute` に乗せる(確認ダイアログを通す)。ゲームサーバーには何も書き込まない操作で、`action` は `RecordingAction`(`WriteAction` とは別系列)。型は `RecordingActionRequest` / `RecordingPrepareResponse` / `RecordingExecuteResponse`(`src/types/api.ts`)。詳細は ARCHITECTURE 17.2。

| action | params | prepare | execute |
|---|---|---|---|
| `record_start` | `{}` | サーバーの解決 → 記録中なら 409 `RECORDING_ALREADY_ACTIVE` → 全体の記録中が `MAX_ACTIVE_RECORDINGS`(8)以上なら 409 `RECORDING_LIMIT_REACHED` → RCON `GET /v1/status`(失敗は `RCON_*`)→ マップと上限を返す | RCON `GET /v1/status`(失敗は `RCON_*`。記録しない)→ `GET /v1/players`(失敗しても続ける)→ 記録・最初のサンプル・`settings_audit_log`(`record_start`)を 1 つの batch で作る |
| `record_stop` | `{ "recordingId": "<MatchId>" }` | そのサーバーの記録中の試合でなければ 409 `RECORDING_NOT_ACTIVE`(形式不正は 400、`fields.recordingId`) | 記録を `manual` で終え、`settings_audit_log`(`record_stop`)を書く。既に終わっていれば 409 `RECORDING_NOT_ACTIVE` |

- 確認トークンの中身・検証の順序は 4 章と同じ(`a` が `record_start` / `record_stop` になる。`sv` / `sh` も同じ)。capabilities は見ない。`destructive` は常に false。
- 1 回限りの保証は `settings_audit_log.confirm_nonce`(UNIQUE)。重複は 409 `ALREADY_EXECUTED`。
- 失敗(`RCON_*`、`RECORDING_*`、トークンの検証失敗)は記録しない(ゲームに影響せず、実行されたか不明になることも無いため。4 章の `audit_log` の規則とは違う)。
- 応答 `RecordingPrepareResponse` の例(値はダミー):

```jsonc
{
  "confirmToken": "v1.<payload>.<sig>", "action": "record_start", "params": {},
  "destructive": false, "expiresAt": 1792050000000, "server": "3",
  "map": "<マップ id>", "scoreCap": 100, "scoreCapSource": "default", "match": null
}
```

- 応答 `RecordingExecuteResponse`: `{ auditId, auditKind: "settings", action, executedAt, server, match: MatchSummary }`。

## 5. エラーコード

表示文言は `src/i18n/<言語コード>.ts` の `error.<code>` にある(全コード必須。型で強制)。下表の「意味」は開発者向けの説明。

| code | HTTP | 意味 |
|---|---|---|
| `BAD_REQUEST` | 400 | JSON として読めない等 |
| `VALIDATION_FAILED` | 400 | 入力の検証失敗(`fields` に項目名 → `ValidationIssue`) |
| `UNAUTHENTICATED` | 401 | 未ログイン・Cookie 不正・期限切れ |
| `FORBIDDEN_ORIGIN` | 403 | Origin / Sec-Fetch-Site 検査に失敗 |
| `NOT_FOUND` | 404 | 該当 API が無い |
| `METHOD_NOT_ALLOWED` | 405 | |
| `PAYLOAD_TOO_LARGE` | 413 | 本文 8 KiB 超(`/api/ingest/events` は 64 KiB 超) |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | JSON 以外 |
| `RATE_LIMITED` | 429 | `/api/capabilities?refresh=1` の連打など。`retryAfterSec` 付き |
| `CONFIRM_INVALID` | 400 | 確認トークンが不正・別セッション・内容不一致 |
| `CONFIRM_EXPIRED` | 409 | 確認トークンの期限切れ |
| `ALREADY_EXECUTED` | 409 | 同じ確認トークンで実行済み |
| `CAPABILITY_MISSING` | 409 | このサーバーのビルドに該当ルートが無い |
| `WRITES_DISABLED` | 503 | 書き込みを止めている(`features.writes` が false。D1 必須化により通常は起きない) |
| `NOT_CONFIGURED` | 503 | D1 が無い・マイグレーション未適用(ARCHITECTURE 7.4)。画面は `/setup` の案内へ |
| `SETUP_REQUIRED` | 503 | 管理者が未登録(`/setup` で管理パスワードを登録する前)。画面は `/setup` へ |
| `SERVER_NOT_FOUND` | 404 | 指定したサーバーが無い(1.2、7 章) |
| `SERVER_DISABLED` | 409 | サーバーが無効になっている |
| `SERVER_NEEDS_PASSWORD` | 409 | 保存済みの RCON パスワードを復号できない(D1 の `instance_key` を手で消した・データ破損。通常は起きない。7 章の PUT で入れ直す) |
| `SERVER_LIMIT_REACHED` | 409 | 登録できる上限(`MAX_SERVERS` = 20)に達した |
| `NO_SERVERS` | 409 | サーバーが 1 台も無い(画面は `/servers` への案内を出す) |
| `FEED_TOKEN_INVALID` | 401 | `POST /api/ingest/events` の受信用トークンが無い・形式不正・一致しない・取り消し済み(`WWW-Authenticate: Bearer` 付き) |
| `RECORDING_ALREADY_ACTIVE` | 409 | `record_start`: そのサーバーは既に記録中 |
| `RECORDING_NOT_ACTIVE` | 409 | `record_stop`: 指定した試合が記録中でない |
| `RECORDING_LIMIT_REACHED` | 409 | `record_start`: 同時に記録できるサーバー数(8)に達した |
| `MATCH_NOT_FOUND` | 404 | 指定した試合の記録が無い(保持期間を過ぎて削除された・別サーバー) |
| `RCON_UNREACHABLE` | 502 | RCON に接続できない |
| `RCON_TIMEOUT` | 504 | RCON の応答なし(読み取り 5 秒 / 書き込み 8 秒) |
| `RCON_AUTH_FAILED` | 502 | RCON が 401 / 403 |
| `RCON_RATE_LIMITED` | 503 | RCON が 429。`retryAfterSec` 付き |
| `RCON_ROUTE_NOT_FOUND` | 502 | RCON が 404 |
| `RCON_REJECTED` | 422 | RCON がその他の 4xx。`rconMessage` 付き |
| `RCON_BAD_RESPONSE` | 502 | 読み取りの応答が JSON でない・大きすぎる、またはリダイレクト(書き込みの 2xx は本文に関係なく成功) |
| `RCON_ERROR` | 502 | RCON が 5xx |
| `INTERNAL_ERROR` | 500 | Worker 内部の想定外のエラー |

## 6. RCON ルート対応表

確度: 第 1 列の API と RCON ルートの対応は本パネルの設計(確定)。RCON ルートの実在・形式は**すべて非公式資料ベースの未検証**(出典 A: wardogs.tech/rcon-reference、B: warcon docs/wardogs-api.md。`docs/research/wardogs-rcon.md` 2 章)。本番では `GET /v1/capabilities` で実在を確定する(R-1)。

### 6.1 読み取り

| Worker API | RCON ルート | 使う項目 | 確度 | 要確認 |
|---|---|---|---|---|
| `/api/capabilities` | `GET /v1/capabilities` | `apiVersion`, `build`, `routes[]` | 未検証(A, B) | R-1 |
| `/api/status` | `GET /v1/status` | `serverName`, `map`, `players.current/max`, `factionScores[]`, `rotation.nowIndex/nextIndex` | 未検証(A, B) | R-8 |
| `/api/status`(次のマップ・件数。300 秒キャッシュ) | `GET /v1/rotation` | `enabled`, `entries[].map`(表示名があれば併用), `entries.length` | 未検証(A, B。要素の形式は不明) | R-8、R-19 |
| `/api/players`、prepare(kick / ban / message の名前解決) | `GET /v1/players` | `players[].name/steamId/faction/kills/deaths/pingMs`, `count` | 未検証(A, B) | R-9 |
| `/api/bans` | `GET /v1/bans` | `bans[].steamId/bannedAtUtc/bannedBy/reason`, `count` | 未検証(A, B) | − |
| `/api/maps`、prepare(map) | `GET /v1/catalog/maps` | `maps[].id/displayName` | 未検証(A, B) | R-11 |

### 6.2 書き込み

| action | RCON ルート | 送る本文 | 確度 | 要確認 |
|---|---|---|---|---|
| `kick` | `POST /v1/players/{steamId}/kick` | `{ "reason": "…" }`(reason 省略時は `{}`) | 未検証(A, B) | R-2, R-10 |
| `ban` | `POST /v1/bans` | `{ "steamId": "…", "reason": "…" }` | 未検証(A, B)。オンライン必須の記載あり | R-2, R-7, R-10 |
| `unban` | `DELETE /v1/bans/{steamId}` | なし | 未検証(A, B) | R-2, R-7 |
| `broadcast` | `POST /v1/broadcast` | `{ "message": "…" }` | 未検証(A, B)。長さ上限の存在は確定(wiki)、256 は未検証 | R-2, R-6 |
| `message` | `POST /v1/players/{steamId}/message` | `{ "message": "…" }` | 未検証(A, B) | R-2, R-6 |
| `map` | `POST /v1/match/map` | `{ "map": "<id>" }`(experiences 等は送らない) | 未検証(A, B) | R-2, R-11 |
| `match_end` | `POST /v1/match/end` | `{}`(要否未確認) | 未検証(A, B, C) | R-2, R-12 |

### 6.2.1 Cron(スコア記録。2026-10-17)

| 呼び出し元 | RCON ルート | 使う項目 | 確度 | 要確認 |
|---|---|---|---|---|
| `record_start` の prepare / execute、Cron(記録中のサーバーだけ 1 分に 1 回) | `GET /v1/status` | `map`, `players.current/max`, `factionScores[]`, `scoreCap`(ビルド依存) | 未検証(A, B) | R-8, R-21 |
| `record_start` の execute、Cron | `GET /v1/players` | `players[].faction`, `players[].cash`(人数と cash の陣営別・全体の合計だけを保存。名前・Steam ID は保存しない) | 未検証(A, B) | R-22 |

### 6.3 使わないルート(第 2 段階以降)

`GET /v1/health`、`GET /v1/reserved-slots`、`GET /v1/audit`(RCON 側の監査ログ。AUTH_FAIL の確認用に第 2 段階で検討)、`GET /v1/config`・`POST /v1/config/validate`・`PUT /v1/config`(設定。第 2 段階)、`POST /v1/players/{steamId}/kill`、`PATCH /v1/players/{steamId}`、`POST /v1/match/restart`、`PUT /v1/world/lighting`、`GET /v1/server-id`(サーバー ID は非公開情報のため取得しない)。

## 7. サーバー API(複数サーバー)

画面 `/servers` が使う。構成・暗号化・選択の詳細は ARCHITECTURE 第 15 章。共通:

- サーバーは D1 `servers` に保存する。Secrets による既定サーバーは廃止した(`:id` = `default` は形式不正の 400)。
- 応答の `ServerSummary` に RCON パスワード・暗号文は含めない。保存後のパスワードは二度と返さない。
- 追加・変更・削除は D1 の変更と `settings_audit_log` の INSERT を 1 つの `db.batch()` で行う(ARCHITECTURE 15.2)。検証で拒否したもの(400)は記録しない。例外は PUT の `reenter_required` と DELETE の `confirmName` 不一致で、`server_update_rejected` / `server_delete_rejected` を記録する(QA M-2。3 章)。
- `:id` の形式が不正なら 400(`fields.server = invalid_format`)、無ければ 404 `SERVER_NOT_FOUND`。

### `GET /api/servers` → `ServersResponse`

`{ servers: ServerSummary[], limit }`。並びは `sort_order`、`id` の順。RCON は呼ばない(接続テストの結果は保存済みの `lastTest`)。各行のパスワードを復号して `needsPassword` / `passwordShort` を決める(再暗号化はしない。ARCHITECTURE 15.3)。

`ServerSummary` の例(値はダミー):

```jsonc
{
  "id": "3", "name": "サーバー B",
  "host": "rcon-b.example.com", "port": 7777,
  "enabled": true, "sortOrder": 0,
  "needsPassword": false, "passwordShort": false, "usable": true,
  "lastTest": { "at": 1792050000000, "result": "ok" },
  "createdAt": 1792040000000, "updatedAt": 1792050000000
}
```

### `POST /api/servers` → 201 `ServerMutationResponse`

本文 `CreateServerRequest`:

```jsonc
{ "name": "サーバー B", "host": "rcon-b.example.com", "port": 7777, "password": "<RCON パスワード>" }
```

| 項目 | 検証(`fields.<項目>` の `ValidationIssue`) |
|---|---|
| `name` | 必須。前後の空白を除いて 1〜32 文字(`required` / `too_long`)、改行・制御文字不可(`invalid_characters`)、既存と重複不可(`duplicate`) |
| `host` | 必須。ホスト名のみ。空白・`/` `?` `#` `@` `:` `[` `]` `\` を含むと `invalid_format`、IP アドレスは `ip_address`、253 文字超は `too_long`、同じ `host` + `port` が既にあれば `duplicate`。小文字に正規化して保存 |
| `port` | 必須。整数でなければ `invalid_format`、1〜65535 の外は `out_of_range` |
| `password` | 必須。1〜256 文字(`required` / `too_long`)、管理パスワードと同じ値は `same_as_admin_password`(管理者のハッシュで検証。ARCHITECTURE 5.2) |

処理: 検証 → 上限確認(登録サーバーが 20 台なら 409 `SERVER_LIMIT_REACHED`)→ 暗号化して INSERT + `server_add` の変更ログ → **接続テスト**(RCON `GET /v1/status`、5 秒)→ 結果を `last_test_*` に保存 → 応答。**接続テストに失敗しても保存は取り消さない**(`test.ok: false` と `test.code` で返す)。

### `PUT /api/servers/:id` → `ServerMutationResponse`

本文 `UpdateServerRequest`(省略した項目は変えない)。検証は POST と同じ。加えて:

- `password` が省略または空文字なら据え置き。
- `host` か `port` を今の値から変える場合は `password` が必須(無ければ 400、`fields.password = reenter_required`)。保存済みのパスワードを新しい宛先へ送らないため(15.6)。
- `enabled`(真偽)、`sortOrder`(整数 -1000〜1000。範囲外は `out_of_range`)も変更できる。
- `needsPassword` のサーバーは、`password` を送れば解消する(他の項目は省略可)。
- 変更が 1 つも無ければ何もせず現在の値を返す(変更ログも書かない)。

`reenter_required` で拒否したときは `server_update_rejected` を 1 行記録する(3 章)。

処理: 検証 → UPDATE + `server_update` の変更ログ(`params` は変えた項目と `passwordChanged`)→ そのサーバーの capabilities キャッシュを破棄 → 接続に関わる項目(`host` / `port` / `password`、または `enabled` を true にした)を変えたときだけ接続テスト(変えていなければ `test: null`)。

### `DELETE /api/servers/:id` → `DeleteServerResponse`

本文 `DeleteServerRequest`: `{ "confirmName": "<現在の表示名>" }`。画面は確認ダイアログで表示名を入力させる。現在の表示名と完全一致しなければ 400(`fields.confirmName = mismatch`)。このとき `server_delete_rejected` を 1 行記録する(3 章)。

処理: 行の削除 + `server_delete` の変更ログ(`params` は削除時点の name / host / port)→ capabilities キャッシュの破棄 → `{ deletedId }`。操作ログ・人数スナップショットは残す(id は再利用しない)。選択 Cookie がこの id を指していても、次のページ表示で無視・削除される。

### `POST /api/servers/:id/test` → `ServerMutationResponse`

本文 `{}`(JSON 必須)。保存済みの設定で接続テスト(RCON `GET /v1/status`、5 秒)を行い、`last_test_*` の更新と `server_test` の記録(3 章。結果 `ok` / `RCON_*`)を同じ `db.batch()` で行って返す。capabilities キャッシュも破棄する。POST / PUT に伴う接続テストは `server_test` を記録しない(`server_add` / `server_update` の行で足りるため)。

- 同じサーバーへのテストは isolate 内で 5 秒に 1 回まで(`SERVER_TEST_MIN_INTERVAL_SEC`。超えたら 429 `RATE_LIMITED`、`retryAfterSec` 付き)。
- 無効(`enabled: false`)のサーバーもテストできる(有効にする前の確認のため)。`needsPassword` は 409 `SERVER_NEEDS_PASSWORD`。
- RCON 側の失敗はエラー応答にせず、200 で `test.ok: false`、`test.code`(`RCON_*`)で返す。

`ServerTestResult` の例:

```jsonc
// 成功
{ "ok": true, "code": null, "testedAt": 1792050000000, "serverName": "Mock Server 7777", "players": { "current": 12, "max": 64 } }
// 失敗
{ "ok": false, "code": "RCON_AUTH_FAILED", "testedAt": 1792050000000, "serverName": null, "players": { "current": null, "max": null } }
```

### 7.2 スコア上限(`PUT /api/servers/:id` の `scoreCap`。2026-10-17)

- `UpdateServerRequest.scoreCap`: 整数 1〜100,000(整数でなければ `invalid_format`、範囲外は `out_of_range`)、`null` で既定(100)に戻す。接続テストはしない。変更ログ `server_update` の `params` に `scoreCap` を含める。
- `ServerSummary.scoreCap`(null = 既定)と `feedConfigured`(受信用トークンを発行済みか)を返す(backend の実装までは省略され得る)。
- `DELETE /api/servers/:id` は、受信用トークン(`server_feeds` の行)も同じ batch で消す。記録中の試合は消さない(次の Cron が `server_unavailable` で終える)。

### 7.3 キルフィードの受信設定(2026-10-17)

ログイン必須・Origin 検査あり・本文 8 KiB(1 章の共通の規則)。`:id` の規則は 7 章と同じ。トークンの値・ハッシュはここで述べる発行の応答以外のどこにも返さない。

| メソッド・パス | 本文 | 応答 | 記録 |
|---|---|---|---|
| `GET /api/servers/:id/feed` | − | `ServerFeedStatus`(未発行なら `configured: false`、時刻は null、`today` は 0) | − |
| `PUT /api/servers/:id/feed` | `UpdateFeedRequest` `{ "enabled": false }` | `ServerFeedStatus`。トークンが未発行なら 404 `NOT_FOUND`(受信設定が無い)。`enabled` が真偽でなければ 400(`fields.enabled = invalid_format`) | `feed_settings_update`(`params: { enabled }`)。値が変わらなければ書かない |
| `POST /api/servers/:id/feed-token` | `{}` | `FeedTokenResponse`(**`token` はこの応答でだけ返す**)。既にあれば置き換える(`reissued: true`) | `feed_token_issue`(`params: { reissued }`) |
| `DELETE /api/servers/:id/feed-token` | `{}` | `ServerFeedStatus`(`configured: false`)。未発行でも 200(冪等) | 行があったときだけ `feed_token_revoke` |

- 無効(`enabled: false`)のサーバー・`needsPassword` のサーバーでもトークンを発行できる(受信しても ARCHITECTURE 17.6 の 10 で捨てる)。
- 再発行・取り消しの後、古いトークンは他の isolate のキャッシュが切れるまで最大 60 秒(`FEED_TOKEN_CACHE_SEC`)通る。
- `FeedTokenResponse` の例(値はダミー。実際のトークンは 43 文字の乱数):

```jsonc
{ "token": "wof1.3.<43 文字>", "tokenHint": "<末尾 4 文字>", "createdAt": 1792050000000, "reissued": false, "status": { /* ServerFeedStatus */ } }
```

### 7.4 RCON ルートとの対応

| Worker API | RCON ルート | 確度 |
|---|---|---|
| `POST /api/servers`、`PUT /api/servers/:id`、`POST /api/servers/:id/test` の接続テスト | `GET /v1/status` | 未検証(A, B)。R-8 |

## 8. スコア記録の読み取り API(2026-10-17)

ログイン必須。RCON は呼ばない(D1 だけ)。詳細は ARCHITECTURE 第 17 章。

### `GET /api/matches?server=<id>` → `MatchesResponse`

そのサーバーの試合を、記録中(あれば先頭)→ 終了済みの新しい順(最大 5 件)で返す。`activeLimit`(8)と `activeCount`(全サーバーで記録中の数)も返す。

- `server` は必須(1.2)。形式不正は 400、削除済みの id は 0 件で 200。
- `MatchSummary.lastScores` は、記録中なら最後のサンプルの陣営スコア、終了済みなら終了時の値。`sampleCount` / `lastSampleAt` はサンプルから数える。
- 画面は概要タブ(記録中なら 60 秒ごと)とキルフィードタブ(表示時と操作の後)で使う。

### `GET /api/matches/:id/samples?server=<id>` → `MatchSamplesResponse`

試合の要約と、1 分ごとのサンプル(古い順、最大 200 件)。

- `:id` は `MATCH_ID_PATTERN`。形式不正は 400(`fields.id = invalid_format`)、無い・`server` と違う → 404 `MATCH_NOT_FOUND`。
- `MatchSample`: `at`、`map`、`players`、`factionScores`(陣営名は RCON の生データ)、`cashTotal`(取れなければ null)、`factions`(陣営ごとの人数と cash。`/v1/players` が取れなければ空)。
- 記録中の試合は Cron が 1 分に 1 行足すので、画面は 60 秒ごとに取り直す(`POLL_MIN_INTERVAL_SEC` より長い)。

## 9. キルフィードの生データ(観測モード。2026-10-17)

### `GET /api/feed/raw?server=<id>&limit=20&before=<id>` → `FeedRawResponse`

受信した本文を新しい順に返す。ログイン必須。

| クエリ | 値 | 既定 |
|---|---|---|
| `server` | `ServerId`(必須) | − |
| `limit` | 1〜50(`FEED_RAW_PAGE_MAX`) | 20 |
| `before` | 前ページの `nextBefore` | − |

- `configured`: そのサーバーに受信用トークンがあるか(無ければ `entries` は空)。トークンを取り消した後も、保持期間内の生データは返す(`configured: false` でも `entries` があり得る)。
- `entries[].body` は受けた JSON 文字列のまま(最大 64 KiB)。**Steam ID・プレイヤー名を含み得る**。画面はテキストとして表示する(HTML として解釈しない)。
- 1 回の応答は最大 50 × 64 KiB ≒ 3.2 MB になり得る。画面の既定は 20 件。

## 10. キルフィードの受信(`POST /api/ingest/events`。2026-10-17)

ゲームサーバー(`[WDServerFeed]`)が送ってくる先。**ブラウザからは使わない**。仕様の出典は非公式資料で未検証(`docs/research/wardogs-rcon.md` 2.4、K-1)。処理の順序の正本は ARCHITECTURE 17.6。

| 項目 | 値 |
|---|---|
| 認証 | `Authorization: Bearer <受信用トークン>`(`wof1.<ServerId>.<43 文字>`。7.3 で発行)。ログイン Cookie・Origin 検査・管理者の有無は見ない |
| 本文 | `Content-Type: application/json`(`; charset=` 可)。64 KiB(`FEED_MAX_BODY_BYTES`)まで。JSON なら形を問わない(配列・オブジェクト。既知外の項目も保存する) |
| レート制限 | サーバーごとに 1 分 90 回(`FEED_RATE_PER_MIN`。isolate 内) |
| 保存 | 空でないバッチを `feed_raw_events` に 1 行。1 日の上限: サーバーごと 1,000 件・4 MiB、全体 4,000 件・16 MiB。保持 7 日 |

応答:

| 状況 | HTTP | 本文 |
|---|---|---|
| 保存した | 204 | なし |
| 空のバッチ(本文が空、`[]`、`events` が空配列) | 204 | なし(D1 に書かない) |
| 受信の保存を止めている・サーバーが無効・1 日の上限 | 204 | なし(捨てる。理由は `ServerFeedStatus.lastDroppedReason`) |
| POST 以外 | 405 | `METHOD_NOT_ALLOWED` |
| D1 が使えない | 503 | `NOT_CONFIGURED` |
| トークンが無い・形式不正・一致しない・取り消し済み | 401 | `FEED_TOKEN_INVALID`(`WWW-Authenticate: Bearer`) |
| 回数の上限 | 429 | `RATE_LIMITED`(`retryAfterSec`、`Retry-After`) |
| JSON 以外の `Content-Type` | 415 | `UNSUPPORTED_MEDIA_TYPE` |
| 64 KiB 超 | 413 | `PAYLOAD_TOO_LARGE` |
| JSON として読めない | 400 | `BAD_REQUEST` |
| D1 の書き込みに失敗 | 500 | `INTERNAL_ERROR` |

- 失敗の本文は 1 章の `ApiFailure`(英語の `message` 付き)。ゲーム側で読まれる前提ではない。
- 上限・無効でも 204 にするのは、ゲームの再送で回数が増えるのを避けるため(再送の挙動は K-6)。
- トークン・本文・`Authorization`・接続元 IP はログに出さない。
- 例(値はダミー。本文の形は資料からの推測で、実際の形は観測で確かめる):

```http
POST /api/ingest/events HTTP/1.1
Host: <パネルのホスト名>
Authorization: Bearer wof1.3.<43 文字>
Content-Type: application/json

[{"type":"killed", "...": "..."}]
```

## 11. キルフィードの集計(第 2 段階。2026-10-17)

ログイン必須。RCON は呼ばない(D1 だけ)。設計の正本は ARCHITECTURE 17.10、型は `src/types/api.ts` の「キルフィード 第 2 段階」の節。第 1 段階(9・10 章、7.3)の契約は変えない。

**集計・JSON 出力の API は無い**。キルの一覧(11.1)をブラウザが受け取り、統計カード・時間帯別・武器別・距離・上位・最長・絞り込み・検索・JSON 出力をブラウザで計算する(ARCHITECTURE 17.10.6。型 `KillfeedSummary` / `KillfeedExport` は画面と出力で共通)。

### 11.1 `GET /api/killfeed/kills?server=<id>&match=<id|unrecorded>&after=<cursor>` → `KillfeedKillsResponse`

| クエリ | 値 | 既定 |
|---|---|---|
| `server` | `ServerId`(必須) | − |
| `match` | `MatchId`(`MATCH_ID_PATTERN`)または `unrecorded`(記録外。`KILLFEED_UNRECORDED`)。必須 | − |
| `after` | 前回の応答の `cursor`(`KILL_CURSOR_PATTERN`)。指定すると、それより後のキルだけを返す(差分) | − |

- `server` が無い → 400 `VALIDATION_FAILED`(`fields.server = required`)、形式不正 → `invalid_format`。削除済みのサーバーの id は 0 件で 200(1.2 と同じ)。
- `match` が無い → 400(`fields.match = required`)、形式不正 → `invalid_format`。試合が無い・`server` と違う → 404 `MATCH_NOT_FOUND`。
- `after` の形式不正 → 400(`fields.after = invalid_format`)。
- 全件(`after` なし): 試合は古い順に最大 `KILLFEED_MATCH_KILLS_MAX`(3,000)件、記録外は新しい方から `KILLFEED_UNRECORDED_MAX`(500)件を古い順に並べて返す。超えたら `truncated: true`。
- 差分(`after` あり): `(receivedAt, id)` が `after` より後のものを古い順に最大 `KILLFEED_INCREMENT_MAX`(500)件。超えたら `truncated: true`(画面は `after` なしで取り直す)。記録外の差分も同じ。
- `cursor`: 返した最後のキルの位置。キルが 0 件なら `after` をそのまま返す(`after` も無ければ null)。
- `match`: 試合の要約(`GET /api/matches` と同じ `MatchSummary`)。記録外は null。記録中の試合が終わると `status: 'ended'` になり、画面は差分の取得をやめる。
- `factions`: 陣営の表示順(試合の最後のサンプルの `factionScores` の順 → キルに現れた順)。陣営の印の配色に使う。
- `kills[].teamkill`: 両者の陣営が同じ出所(`factionSource`)で分かり、自殺でないときだけ true / false。それ以外は null。
- `today`: 今日(UTC)の正規化の件数(保存したキル・キル以外のイベント・読み取れなかったキル・上限で捨てたキル)。
- `configured`: 受信用トークンを発行済みか(未発行でも保存済みのキルは返す)。
- **Steam ID・プレイヤー名を含む**。画面はテキストとして表示する(HTML として解釈しない)。
- 画面は記録中の試合・記録外を表示している間、`KILLFEED_POLL_SEC`(30 秒)ごとに差分を取る。終了済みの試合は 1 回だけ。

例(値はダミー):

```jsonc
{
  "ok": true,
  "data": {
    "server": "3",
    "scope": "12",
    "match": { "id": "12", "status": "recording", "map": "<マップ>", "...": "..." },
    "factions": ["Blue", "Red"],
    "kills": [
      {
        "id": 501,
        "receivedAt": 1792233600000,
        "eventAt": null,
        "gameTimeSec": 3151,
        "killer": { "name": "TestPlayerA", "steamId": "<17 桁>", "faction": "Blue", "factionSource": "roster" },
        "victim": { "name": "TestPlayerB", "steamId": "<17 桁>", "faction": "Red", "factionSource": "roster" },
        "weapon": { "id": "WEPN_031", "name": null },
        "vehicle": null,
        "flags": { "headshot": true, "penetration": false, "roadkill": false, "vehicleExplosion": false, "suicide": false },
        "teamkill": false,
        "distanceM": 37.2
      }
    ],
    "cursor": "1792233600000-501",
    "incremental": false,
    "truncated": false,
    "today": { "kills": 120, "otherEvents": 0, "incomplete": 0, "droppedKills": 0 },
    "configured": true
  }
}
```

### 11.2 `GET /api/feed/raw/:id/normalized?server=<id>` → `FeedNormalizePreviewResponse`

保存済みの生データ(`feed_raw_events`)1 件に、**今の対応表**(`src/lib/killfeed/fields.ts`)で正規化を試した結果を返す。**何も保存しない**。対応表の見直し用(観測で本物の形を見た後、どの項目が読めていないかを確かめる)。

- `:id` は 9 章の `FeedRawEntry.id`(正の整数)。形式不正 → 400(`fields.id = invalid_format`)。`server` は必須(1.2)。生データが無い(保持期間切れ・別サーバー)→ 404 `NOT_FOUND`。
- `envelope`: 本文の外側の形(`array` / `events` / `single` / `unknown`)。
- `events`: 先頭から最大 `FEED_NORMALIZE_PREVIEW_MAX`(50)件。各件に結果(`kill` / `other` / `incomplete` / `invalid`)、正規化した値(`kill`)、項目ごとに使った候補名(`matched`)、どの候補にも使われなかった最上位のキー(`unmappedKeys`。値は含めない)。
- `counts`: バッチ全体の件数。`bigIntegersQuoted`: 引用符の無い 16 桁以上の整数を文字列として読んだ数(K-10)。
- 正規化の値は Steam ID・プレイヤー名を含む(9 章の生データと同じ扱い)。

### 11.3 JSON で書き出す(API なし)

ブラウザが 11.1 の全件と `GET /api/matches/:id/samples` のサンプルから `KillfeedExport`(`format: 'wardogs-ops.killfeed'`、`version: 1`)を組み立て、`Blob` でダウンロードさせる。ファイル名は `killfeed-s<サーバー id>-<試合 id または unrecorded>-<YYYYMMDD-HHmm>.json`(日時は `TIMEZONE`)。絞り込み・検索の前の全件を入れる。Steam ID・プレイヤー名を含むことを画面に書く。

### 11.4 受信設定の追加(`GET` / `PUT /api/servers/:id/feed`。7.3 への追加)

- `GET` / `PUT` の応答は `ServerFeedStatus & KillfeedFeedStatusExtra`(第 1 段階の項目はそのまま):
  - `rawEnabled`: 生データ(`feed_raw_events`)も保存するか(既定 true)。false でもキルの正規化・保存は続ける。`enabled = false` のときは従来どおり何も保存しない。
  - `killsToday`: 今日(UTC)の正規化の件数(11.1 の `today` と同じ)。
  - `killLimits`: `dailyKills`(3,000)、`globalDailyKills`(8,000)、`perBatch`(100)、`unrecordedRetentionDays`(7)。
- `PUT` の本文は `UpdateFeedRequest & KillfeedUpdateFeedExtra`。`enabled` は従来どおり必須、`rawEnabled` は任意(省略時は変えない。真偽以外は 400 `fields.rawEnabled = invalid_format`)。`settings_audit_log` の `feed_settings_update` の `params` に `rawEnabled` を足す(変えたときだけ)。

### 11.5 受信(10 章)の処理の追加

HTTP の契約(認証・上限・応答のコード)は 10 章のまま。保存の中身だけが増える(ARCHITECTURE 17.10.3):

- 空でないバッチを正規化し、`killed` のイベントを `feed_kills` に保存する(1 バッチ 100 件まで、1 日サーバーごと 3,000 件・全体 8,000 件。超えた分は 204 で受けて捨て、`droppedKills` に数える)。
- 生データの保存は `rawEnabled` が true のときだけ。生データの 1 日の上限(10 章)はキルの保存を止めない。
- `killed` 以外のイベント・読み取れなかったキルは保存せず、件数だけ数える。

### 11.6 エラーコード

新しいコードは無い(400 `VALIDATION_FAILED`、404 `MATCH_NOT_FOUND` / `NOT_FOUND`、503 `NOT_CONFIGURED` 等の既存のコードを使う)。0004 のマイグレーションが未適用の D1 は、他の API と同じく 503 `NOT_CONFIGURED`(ARCHITECTURE 7.4)。
