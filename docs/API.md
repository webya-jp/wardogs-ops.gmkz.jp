# Worker 内部 API 契約

作成日: 2026-10-15(JST)/ 更新: 2026-10-16(複数サーバー対応: 1.2、3・4 章の `server`、5 章のコード、7 章)/ 担当: architect。型の正本は `src/types/api.ts`(本書と食い違ったら司令塔に報告)。
構成・認証の詳細は `docs/ARCHITECTURE.md`。RCON の確度は第 6 章と `docs/research/wardogs-rcon.md`。

## 1. 共通

- ベース: Worker と同じオリジン(`https://<worker>.<account>.workers.dev` またはカスタムドメイン)。
- 認証: すべての `/api/*` はログイン Cookie(`__Host-wo_session`)が必要。無い・不正・期限切れは 401 `UNAUTHENTICATED`。
- 設定不足(必須 Secrets の不足・不正)のときは、すべての `/api/*` が 503 `NOT_CONFIGURED`。
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

複数サーバー対応(ARCHITECTURE 第 15 章)。RCON を呼ぶ API は対象サーバーを `ServerId`(`"default"` = Secrets の既定サーバー、`"3"` など = 画面から登録したサーバー。形式 `SERVER_ID_PATTERN`)で受け取る。

| API | 渡し方 | 省略時 |
|---|---|---|
| `GET /api/status` `players` `bans` `maps` `capabilities` | クエリ `?server=<id>` | Cookie(`__Host-wo_server`)→ 表示順で最初に使えるサーバー(更新前から開いていたタブとの互換用。画面は常に明示して送る) |
| `POST /api/actions/prepare` `execute` | 本文 `server` | **不可**(400 `VALIDATION_FAILED`、`fields.server = required`) |
| `GET /api/audit` | クエリ `?server=<id>` または `all` | `all`(全サーバー) |
| `/api/servers/*` | パスの `:id` | − |

サーバーを解決できないときのエラー(すべての RCON を呼ぶ API で共通):

| 状況 | 応答 |
|---|---|
| 形式が不正 | 400 `VALIDATION_FAILED`(`fields.server = invalid_format`) |
| 該当するサーバーが無い(削除済み、既定サーバーの Secrets が両方未設定) | 404 `SERVER_NOT_FOUND` |
| 無効にしてある | 409 `SERVER_DISABLED` |
| 保存済みの RCON パスワードを復号できない | 409 `SERVER_NEEDS_PASSWORD` |
| 既定サーバーの Secrets に不備(片方だけ・`RCON_URL` 不正) | 503 `NOT_CONFIGURED` |
| サーバーが 1 台も無い(省略時の解決で見つからない) | 409 `NO_SERVERS` |
| 登録サーバーを指定したが D1 が使えない・0002 未適用 | 503 `SERVERS_UNAVAILABLE` |

RCON パスワード(平文・暗号文とも)はどの応答にも含めない。既定サーバーの `RCON_URL` も返さない。

## 2. ページ側のエンドポイント(フォーム)

| メソッド・パス | 本文 | 結果 |
|---|---|---|
| `GET /login` | − | ログインフォーム。ログイン済みなら `/` へ 303 |
| `POST /login` | `application/x-www-form-urlencoded`: `password`(必須、256 文字まで評価)、`operator`(任意、32 文字まで) | 成功: Cookie 発行 + `/` へ 303。失敗: 401 でフォーム再表示(文言はカタログ `login.failed`)。ロック中: 429 でフォーム再表示(`login.locked`、残り分数)。Origin 不一致: 403 |
| `POST /logout` | なし(Origin 検査あり) | Cookie 削除 + `/login` へ 303 |
| `GET /setup` | − | 設定の案内(ARCHITECTURE 5.7) |

## 3. 読み取り API

### `GET /api/session` → `SessionResponse`

ログイン中のセッション情報、段階的有効化の状態(`features`。`servers` = 画面からサーバーを管理できるか)、設定の警告(`warnings`。`SetupWarning` の配列)。RCON は呼ばない。`server` は受け取らない。

`warnings` の変更(2026-10-16): `RCON_URL_*` / `RCON_PASSWORD_MISSING` はログインを止めない警告になった(既定サーバーの不備)。登録サーバーに復号できないパスワードがあると `SERVER_PASSWORDS_UNREADABLE` が入る。

`status` は `pending` / `succeeded` / `failed` / `unknown`。`unknown` = RCON がタイムアウトし、実行されたかどうか不明(DB 上は `failed` + `error_code = RCON_TIMEOUT` のまま。DB スキーマは変えず、API の変換で `unknown` にする)。

`warnings` には設定の警告に加え、全体のログイン失敗が直近 1 時間で 50 回を超えたときに `LOGIN_FAILURES_HIGH` が入る(ログインは止めない。ARCHITECTURE 5.6)。文言は画面がカタログの `setup.warning.<コード>` で引く。

### `GET /api/capabilities?server=<id>` → `CapabilitiesResponse`

対象サーバーの RCON `GET /v1/capabilities` を解釈し、本パネルの読み取り・書き込みごとに `available` / `missing` / `unknown` を返す。Worker で 10 分キャッシュ(サーバーごと)。`?refresh=1` でキャッシュを無視(サーバーごとに 1 分に 1 回まで。超過時はキャッシュを返す)。capabilities が取れなくてもエラーにせず `source: "unavailable"`、全項目 `unknown` で 200 を返す。

### `GET /api/status?server=<id>` → `StatusResponse`

RCON `GET /v1/status`。成功時は人数スナップショットを記録(D1 がある場合、サーバーごとに 5 分に 1 行。`server_snapshots`)。

### `GET /api/players?server=<id>` → `PlayersResponse`

RCON `GET /v1/players`。`cash` 等の本パネルで使わない項目は返さない。

### `GET /api/bans?server=<id>` → `BansResponse`

RCON `GET /v1/bans`。D1 がある場合、`knownName` を audit_log(event=ban、succeeded、同じ Steam ID の最新)から補完する(サーバーで絞らない。Steam ID は全サーバー共通のため)。

### `GET /api/maps?server=<id>` → `MapsResponse`

RCON `GET /v1/catalog/maps`。マップ変更のプルダウン用。

### `GET /api/audit?kind=operations&server=all&limit=50&before=<id>` → `AuditResponse`

ログを新しい順に返す。RCON は呼ばない。D1 が使えない場合は 200 で `available: false`、`entries: []`。

| クエリ | 値 | 既定 |
|---|---|---|
| `kind` | `operations`(audit_log: RCON の操作・login・logout)/ `settings`(settings_audit_log: サーバーの追加・変更・削除) | `operations` |
| `server` | `all` / `ServerId`。`operations` で `ServerId` を指定すると、その対象サーバーの書き込み操作だけ(login / logout は除く)。`default` は `server_id IS NULL` の書き込み操作。`settings` ではその対象サーバーの変更だけ | `all` |
| `limit` | 1〜100 | 50 |
| `before` | 前ページの `nextBefore`(`kind` ごとに id の系列が別) | − |

- 2 つの `kind` は別テーブルで id の系列が違うため、1 回の応答に混ぜない(ARCHITECTURE 15.2)。
- `entries[].serverId` / `serverName`: 書き込み操作は対象サーバー(D1 が NULL の行は `"default"`、`serverName` は操作時点の表示名。既定サーバーは null)。login / logout は両方 null。
- `settings` の行: `event` は `server_add` / `server_update` / `server_delete`、`status` は常に `succeeded`、`params` は変更内容(`name` `host` `port` `enabled` `passwordChanged`。パスワードは含まない)、`targetSteamId` / `targetName` / `rconStatus` / `errorCode` は null。
- `server` が存在しない id でもエラーにせず、該当 0 件として返す(削除済みサーバーのログも引けるようにするため)。形式不正は 400。

読み取り API の RCON 由来のエラーは第 5 章の `RCON_*`。

## 4. 書き込み API(二段階)

すべての書き込みは `prepare` → `execute` の 2 リクエストで行う。`execute` だけを直接呼んでも、有効な確認トークンが無ければ実行されない。どちらも本文に対象サーバー `server` が必須(1.2)。

`features.writes` が false(D1 が無く `AUDIT_REQUIRED` が `"false"` でない)なら、どちらも 503 `WRITES_DISABLED`。

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
| `PAYLOAD_TOO_LARGE` | 413 | 本文 8 KiB 超 |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | JSON 以外 |
| `RATE_LIMITED` | 429 | `/api/capabilities?refresh=1` の連打など。`retryAfterSec` 付き |
| `CONFIRM_INVALID` | 400 | 確認トークンが不正・別セッション・内容不一致 |
| `CONFIRM_EXPIRED` | 409 | 確認トークンの期限切れ |
| `ALREADY_EXECUTED` | 409 | 同じ確認トークンで実行済み |
| `CAPABILITY_MISSING` | 409 | このサーバーのビルドに該当ルートが無い |
| `WRITES_DISABLED` | 503 | D1 が使えず書き込みを止めている(ARCHITECTURE 7.4) |
| `NOT_CONFIGURED` | 503 | 必須 Secrets(ADMIN_PASSWORD 系)の不足・不正。または既定サーバーの Secrets の不備で既定サーバーを使えない(1.2) |
| `SERVER_NOT_FOUND` | 404 | 指定したサーバーが無い(1.2、7 章) |
| `SERVER_DISABLED` | 409 | サーバーが無効になっている |
| `SERVER_NEEDS_PASSWORD` | 409 | 保存済みの RCON パスワードを復号できない(ADMIN_PASSWORD / SESSION_SECRET の変更後。7 章の PUT で入れ直す) |
| `SERVER_READ_ONLY` | 409 | 既定サーバー(Secrets)は画面から変更・削除できない |
| `SERVER_LIMIT_REACHED` | 409 | 登録できる上限(`MAX_SERVERS` = 20)に達した |
| `SERVERS_UNAVAILABLE` | 503 | D1 が使えない・0002 未適用のため、登録サーバーを扱えない |
| `NO_SERVERS` | 409 | サーバーが 1 台も無い(画面は `/servers` への案内を出す) |
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

### 6.3 使わないルート(第 2 段階以降)

`GET /v1/health`、`GET /v1/rotation`、`GET /v1/reserved-slots`、`GET /v1/audit`(RCON 側の監査ログ。AUTH_FAIL の確認用に第 2 段階で検討)、`GET /v1/config`・`POST /v1/config/validate`・`PUT /v1/config`(設定。第 2 段階)、`POST /v1/players/{steamId}/kill`、`PATCH /v1/players/{steamId}`、`POST /v1/match/restart`、`PUT /v1/world/lighting`、`GET /v1/server-id`(サーバー ID は非公開情報のため取得しない)。

## 7. サーバー API(複数サーバー)

画面 `/servers` が使う。構成・暗号化・選択の詳細は ARCHITECTURE 第 15 章。共通:

- 登録サーバーは D1 `servers` に保存する。D1 が使えない・0002 未適用(`features.servers` が false)なら、`GET` は既定サーバーだけを返し、追加・変更・削除・登録サーバーの接続テストは 503 `SERVERS_UNAVAILABLE`。
- 既定サーバー(`:id` = `default`)への PUT / DELETE は 409 `SERVER_READ_ONLY`(接続テストは可)。
- 応答の `ServerSummary` に RCON パスワード・暗号文は含めない。保存後のパスワードは二度と返さない。
- 追加・変更・削除は D1 の変更と `settings_audit_log` の INSERT を 1 つの `db.batch()` で行う(ARCHITECTURE 15.2)。検証で拒否したもの(400)は記録しない。
- `:id` の形式が不正なら 400(`fields.server = invalid_format`)、無ければ 404 `SERVER_NOT_FOUND`。

### `GET /api/servers` → `ServersResponse`

`{ manageable, servers: ServerSummary[], limit }`。並びは既定サーバー(あれば先頭)→ 登録サーバーを `sort_order`、`id` の順。RCON は呼ばない(接続テストの結果は保存済みの `lastTest`)。登録サーバーのパスワードを復号して `needsPassword` / `passwordShort` を決める。SESSION_SECRET が設定されていて古い鍵(`k = "a"`)の行を復号できたら、応答後にその行を再暗号化する(15.3)。

`ServerSummary` の例(値はダミー):

```jsonc
{
  "id": "3", "source": "db", "name": "サーバー B",
  "host": "rcon-b.example.com", "port": 7777,
  "enabled": true, "sortOrder": 0,
  "needsPassword": false, "passwordShort": false, "secretsIssue": null, "usable": true,
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
| `password` | 必須。1〜256 文字(`required` / `too_long`)、`ADMIN_PASSWORD` と同じ値は `same_as_admin_password` |

処理: 検証 → 上限確認(登録サーバーが 20 台なら 409 `SERVER_LIMIT_REACHED`)→ 暗号化して INSERT + `server_add` の変更ログ → **接続テスト**(RCON `GET /v1/status`、5 秒)→ 結果を `last_test_*` に保存 → 応答。**接続テストに失敗しても保存は取り消さない**(`test.ok: false` と `test.code` で返す)。

### `PUT /api/servers/:id` → `ServerMutationResponse`

本文 `UpdateServerRequest`(省略した項目は変えない)。検証は POST と同じ。加えて:

- `password` が省略または空文字なら据え置き。
- `host` か `port` を今の値から変える場合は `password` が必須(無ければ 400、`fields.password = reenter_required`)。保存済みのパスワードを新しい宛先へ送らないため(15.6)。
- `enabled`(真偽)、`sortOrder`(整数 -1000〜1000。範囲外は `out_of_range`)も変更できる。
- `needsPassword` のサーバーは、`password` を送れば解消する(他の項目は省略可)。
- 変更が 1 つも無ければ何もせず現在の値を返す(変更ログも書かない)。

処理: 検証 → UPDATE + `server_update` の変更ログ(`params` は変えた項目と `passwordChanged`)→ そのサーバーの capabilities キャッシュを破棄 → 接続に関わる項目(`host` / `port` / `password`、または `enabled` を true にした)を変えたときだけ接続テスト(変えていなければ `test: null`)。

### `DELETE /api/servers/:id` → `DeleteServerResponse`

本文 `DeleteServerRequest`: `{ "confirmName": "<現在の表示名>" }`。画面は確認ダイアログで表示名を入力させる。現在の表示名と完全一致しなければ 400(`fields.confirmName = mismatch`)。

処理: 行の削除 + `server_delete` の変更ログ(`params` は削除時点の name / host / port)→ capabilities キャッシュの破棄 → `{ deletedId }`。操作ログ・人数スナップショットは残す(id は再利用しない)。選択 Cookie がこの id を指していても、次のページ表示で無視・削除される。

### `POST /api/servers/:id/test` → `ServerMutationResponse`

本文 `{}`(JSON 必須)。保存済みの設定で接続テスト(RCON `GET /v1/status`、5 秒)を行い、`last_test_*` を更新して返す(既定サーバーも可。既定サーバーの結果は isolate 内メモリにだけ持つ)。capabilities キャッシュも破棄する。

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

### 7.1 RCON ルートとの対応

| Worker API | RCON ルート | 確度 |
|---|---|---|
| `POST /api/servers`、`PUT /api/servers/:id`、`POST /api/servers/:id/test` の接続テスト | `GET /v1/status` | 未検証(A, B)。R-8 |
