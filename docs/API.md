# Worker 内部 API 契約

作成日: 2026-10-15(JST)/ 担当: architect。型の正本は `src/types/api.ts`(本書と食い違ったら司令塔に報告)。
構成・認証の詳細は `docs/ARCHITECTURE.md`。RCON の確度は第 6 章と `docs/research/wardogs-rcon.md`。

## 1. 共通

- ベース: Worker と同じオリジン(`https://<worker>.<account>.workers.dev` またはカスタムドメイン)。
- 認証: すべての `/api/*` はログイン Cookie(`__Host-wo_session`)が必要。無い・不正・期限切れは 401 `UNAUTHENTICATED`。
- 設定不足(必須 Secrets の不足・不正)のときは、すべての `/api/*` が 503 `NOT_CONFIGURED`。
- POST: `Content-Type: application/json` 必須(415)、本文 8 KiB まで(413)、Origin 検査(403 `FORBIDDEN_ORIGIN`。ARCHITECTURE 5.5)。
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

- **API は表示用の文言を返さない**。画面は `error.code`(`ApiErrorCode`)でメッセージカタログの `error.<code>` を引き、`fields` の値(`ValidationIssue`: `required` `too_long` `invalid_format` `invalid_characters` `not_online` `unknown_map`)で `validation.<issue>` を引く(ARCHITECTURE 13.5)。
- `message` は**任意・英語固定**の開発者向けの短い説明(ログ調査用)。**画面には出さない**。Secrets・接続先・内部例外の文字列・入力値を含めない。
- `retryAfterSec` などの数値はカタログの文言に埋め込むパラメータとして使う。
- `rconMessage` は RCON が返したエラー文を 200 文字に切り詰め制御文字を除いたもの(`RCON_REJECTED` のときのみ)。RCON の生データなので翻訳せず、補足としてそのまま表示する。
- 成功応答も同様で、確認ダイアログ・操作ログの文は Worker で作らない(正規化済みの値だけを返し、画面がカタログで組み立てる)。

## 2. ページ側のエンドポイント(フォーム)

| メソッド・パス | 本文 | 結果 |
|---|---|---|
| `GET /login` | − | ログインフォーム。ログイン済みなら `/` へ 303 |
| `POST /login` | `application/x-www-form-urlencoded`: `password`(必須、256 文字まで評価)、`operator`(任意、32 文字まで) | 成功: Cookie 発行 + `/` へ 303。失敗: 401 でフォーム再表示(文言はカタログ `login.failed`)。ロック中: 429 でフォーム再表示(`login.locked`、残り分数)。Origin 不一致: 403 |
| `POST /logout` | なし(Origin 検査あり) | Cookie 削除 + `/login` へ 303 |
| `GET /setup` | − | 設定の案内(ARCHITECTURE 5.7) |

## 3. 読み取り API

### `GET /api/session` → `SessionResponse`

ログイン中のセッション情報、段階的有効化の状態(`features`)、設定の警告(`warnings`)。RCON は呼ばない。

### `GET /api/capabilities` → `CapabilitiesResponse`

RCON `GET /v1/capabilities` を解釈し、本パネルの読み取り・書き込みごとに `available` / `missing` / `unknown` を返す。Worker で 10 分キャッシュ。`?refresh=1` でキャッシュを無視(1 分に 1 回まで。超過時はキャッシュを返す)。capabilities が取れなくてもエラーにせず `source: "unavailable"`、全項目 `unknown` で 200 を返す。

### `GET /api/status` → `StatusResponse`

RCON `GET /v1/status`。成功時は人数スナップショットを記録(D1 がある場合、5 分に 1 行)。

### `GET /api/players` → `PlayersResponse`

RCON `GET /v1/players`。`cash` 等の本パネルで使わない項目は返さない。

### `GET /api/bans` → `BansResponse`

RCON `GET /v1/bans`。D1 がある場合、`knownName` を audit_log(event=ban、succeeded、同じ Steam ID の最新)から補完する。

### `GET /api/maps` → `MapsResponse`

RCON `GET /v1/catalog/maps`。マップ変更のプルダウン用。

### `GET /api/audit?limit=50&before=<id>` → `AuditResponse`

audit_log を新しい順に返す。`limit` は 1〜100(既定 50)、`before` は前ページの `nextBefore`。D1 が使えない場合は 200 で `available: false`、`entries: []`。RCON は呼ばない。

読み取り API の RCON 由来のエラーは第 5 章の `RCON_*`。

## 4. 書き込み API(二段階)

すべての書き込みは `prepare` → `execute` の 2 リクエストで行う。`execute` だけを直接呼んでも、有効な確認トークンが無ければ実行されない。

`features.writes` が false(D1 が無く `AUDIT_REQUIRED` が `"false"` でない)なら、どちらも 503 `WRITES_DISABLED`。

### `POST /api/actions/prepare`

本文 `PrepareRequest`:

```jsonc
{ "action": "kick", "params": { "steamId": "<17 桁の SteamID64>", "reason": "暴言" } }
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

処理: 入力検証(400 `VALIDATION_FAILED`、`fields` に項目ごとの `ValidationIssue`)→ capability が `missing` なら 409 `CAPABILITY_MISSING` → 対象の名前解決 → params の正規化(前後の空白除去など)→ 確認トークン発行。確認ダイアログの文は画面がカタログの `confirm.<action>` で組み立てる。

応答 `PrepareResponse`:

```jsonc
{
  "confirmToken": "v1.<payload>.<sig>",
  "action": "kick",
  "params": { "steamId": "<17 桁の SteamID64>", "reason": "暴言" },
  "targetName": "Example",
  "destructive": false,
  "capability": "available",
  "expiresAt": 1792050000000
}
```

確認トークンの中身: `{ v:1, a:action, h:SHA-256(正規化した params の JSON) の先頭 128 bit, s:セッション ID, e:期限(発行から 120 秒), n:nonce 128 bit }` を base64url にし、確認用鍵の HMAC-SHA256 で署名。中身は秘密ではないが改ざんできない。

### `POST /api/actions/execute`

本文 `ExecuteRequest` = prepare と同じ `action`・`params` + `confirmToken`。

検証の順序とエラー:

| 順 | 確認 | 失敗時 |
|---|---|---|
| 1 | 署名・形式 | 400 `CONFIRM_INVALID` |
| 2 | セッション ID が現在の Cookie と一致 | 400 `CONFIRM_INVALID` |
| 3 | action と params のハッシュが一致 | 400 `CONFIRM_INVALID` |
| 4 | 期限内 | 409 `CONFIRM_EXPIRED`(画面は prepare からやり直す) |
| 5 | audit_log に pending で INSERT(`confirm_nonce` UNIQUE) | 重複は 409 `ALREADY_EXECUTED` |
| 6 | RCON の書き込みルートを 1 回呼ぶ(再試行なし) | 第 5 章の `RCON_*`。audit_log を failed に更新 |
| 7 | audit_log を succeeded に更新 | − |

応答 `ExecuteResponse`: `{ auditId, action, executedAt }`。

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
| `NOT_CONFIGURED` | 503 | 必須 Secrets の不足・不正 |
| `RCON_UNREACHABLE` | 502 | RCON に接続できない |
| `RCON_TIMEOUT` | 504 | RCON の応答なし(読み取り 5 秒 / 書き込み 8 秒) |
| `RCON_AUTH_FAILED` | 502 | RCON が 401 / 403 |
| `RCON_RATE_LIMITED` | 503 | RCON が 429。`retryAfterSec` 付き |
| `RCON_ROUTE_NOT_FOUND` | 502 | RCON が 404 |
| `RCON_REJECTED` | 422 | RCON がその他の 4xx。`rconMessage` 付き |
| `RCON_BAD_RESPONSE` | 502 | 応答が JSON でない・大きすぎる・リダイレクト |
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
