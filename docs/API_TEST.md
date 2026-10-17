# API 動作確認記録

確認日: 2026-10-15(JST)/ 担当: backend(同日、QA レビュー M-2・M-3・M-4・M-6 の修正後に N-18・E-4・E-6b・E-25〜E-27 と 4 章を再確認)/ 2026-10-16: 複数サーバー対応(5 章)、Worker Secrets の廃止(6 章。1〜5 章のうち Secrets・既定サーバーに関わる記録は旧方式のもの)
対象: `docs/API.md` の各エンドポイント。値(パスワード・Cookie・接続先)は記録しない。

## 1. 確認環境

> 1〜4 章は 2026-10-15 時点(Worker Secrets 使用時)の記録。現在は Secrets・`.dev.vars` を使わず、管理パスワードは `/setup` で登録して D1 に保存する。現行の確認は 6 章。

| 項目 | 内容 |
|---|---|
| RCON | `scripts/mock-rcon.mjs`(`pnpm mock:rcon`。架空のプレイヤー 4 人・BAN 1 件。形式は `docs/research/wardogs-rcon.md` 2 章に合わせた架空のもので、実サーバーの挙動は未確認) |
| Worker | (a) `pnpm dev`(astro dev。Cookie 名 `wo_session`)、(b) `pnpm build` 後の `wrangler dev`(本番と同じ `__Host-wo_session`、`Secure` 付き) |
| Secrets | (旧方式。2026-10-16 の Worker Secrets 廃止で無くなった。現行は 6 章)当時は `.dev.vars` にダミー値(管理パスワード・RCON の接続先とパスワード)を置いた |
| D1 | ローカル D1 に `pnpm db:migrate:local` で `0001_init.sql` を適用 |
| 手段 | Node の `fetch` で書いた確認スクリプト(リポジトリ外)と curl。(a)(b) の両方で同じ結果(下記 4 章の 1 件を除く) |
| 単体テスト | `pnpm test`(vitest、10 ファイル・62 件すべて成功。QA 修正後) |

## 2. 正常系

| # | 操作 | 期待 | 結果 |
|---|---|---|---|
| N-1 | `GET /login` | 200、フォーム表示 | OK |
| N-2 | `POST /login`(正しいパスワード、操作者名つき) | 303 `/`、`Set-Cookie`(`HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`、本番ビルドは `__Host-` + `Secure`) | OK |
| N-3 | ログイン済みで `GET /login` | 303 `/` | OK |
| N-4 | `GET /api/session` | `session.operator` が入力値、`features` が audit / snapshots / writes すべて true、`warnings` 空 | OK |
| N-5 | `GET /api/status` | モックの serverName・map・人数・陣営スコア・ローテーション | OK |
| N-6 | `GET /api/players` | 4 件、`cash` を含まない | OK |
| N-7 | `GET /api/bans` / `GET /api/maps` | BAN 1 件 / マップ 3 件 | OK |
| N-8 | `GET /api/capabilities` | `source: "rcon"`、kick 等が `available` | OK |
| N-9 | `prepare` kick(理由の前後に空白) | 200、`targetName` がモックの名前、`params.reason` が前後の空白除去済み、`destructive: false`、`capability: "available"` | OK |
| N-10 | `execute` kick(prepare の値そのまま) | 200、`auditId` が数値 | OK |
| N-11 | kick 後の `GET /api/players` | 対象が一覧から消え、件数が 1 減る | OK |
| N-12 | ban の prepare → execute | `destructive: true`、200。`GET /api/bans` に増え、`knownName` が監査ログの名前で補完される | OK |
| N-13 | unban の prepare | `targetName` が監査ログ(同じ Steam ID の最新)から引ける | OK |
| N-14 | unban / broadcast / match_end の execute | いずれも 200 | OK |
| N-15 | `GET /api/audit?limit=10` | kick の行が `status: succeeded`、`operator`・`sessionTag`・`targetName`・`rconStatus: 200`・`finishedAt >= createdAt` 付きで残る。`login` の行も残る | OK |
| N-16 | `GET /api/audit?limit=2` | 2 件 + `nextBefore` が数値 | OK |
| N-17 | `POST /logout` | 303 `/login`、Cookie を `Max-Age=0` で削除。以後 `/api/session` は 401 | OK |
| N-18 | 全応答のヘッダ | `Cache-Control: no-store`、`X-Frame-Options: DENY`、CSP(`frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'`)、`Referrer-Policy: same-origin`、`X-Content-Type-Options: nosniff`、`X-Robots-Tag: noindex, nofollow` | OK |
| N-19 | `GET /setup`(設定済み) | 「設定済みです。」だけを表示 | OK |

## 3. 異常系

| # | 操作 | 期待 | 結果 |
|---|---|---|---|
| E-1 | 未ログインで `GET /api/status` | 401 `UNAUTHENTICATED` | OK |
| E-2 | 未ログインで `GET /` | 303 `/login` | OK |
| E-3 | `POST /login` に Origin なし(Sec-Fetch-Site もなし) | 403 | OK |
| E-4 | `POST /login` の CSRF 検査(誤ったパスワードで送り、通過すれば 401) | Origin が別サイト → 403。Origin なしかつ `Sec-Fetch-Site` なし → 403。`Origin: null` かつ `Sec-Fetch-Site` なし → 403。`Origin: null` + `same-origin` → 通過(401)。`Origin: null` + `same-site` / `cross-site` → 403。Origin なし + `same-origin` → 通過。Origin 一致 → 通過。403 はすべて本パネルの middleware が返す(`astro.config.mjs` の `checkOrigin: false` により Astro 標準の検査は動かない)。セキュリティヘッダ付き(`cross-site` だけは 4 章の例外)。403 の直後のリクエストも正常 | OK |
| E-5 | `POST /login` 誤パスワード | 401 でフォーム再表示(「パスワードが違います。」)、約 300 ms 遅延 | OK |
| E-6 | 同じ接続元から 5 回失敗 → 6 回目 | 1〜5 回目 401、6 回目 429(「約 N 分間ログインできません」)。ロック中は正しいパスワードでも 429。別の接続元はログインできる | OK |
| E-6b | 同じ接続元から誤ったパスワードを 10 本同時に送る | 評価前に試行を加算するため、401 は 5 本だけ、残り 5 本は 429(並行でも上限を超えて評価しない) | OK |
| E-7 | `POST /api/actions/prepare` に Origin なし | 403 `FORBIDDEN_ORIGIN` | OK |
| E-8 | prepare をフォーム形式で送る | 415 `UNSUPPORTED_MEDIA_TYPE` | OK |
| E-9 | prepare に不正な JSON | 400 `BAD_REQUEST` | OK |
| E-10 | prepare に 8 KiB 超の本文 | 413 `PAYLOAD_TOO_LARGE` | OK |
| E-11 | prepare の Steam ID が 17 桁でない | 400 `VALIDATION_FAILED`、`fields.steamId = invalid_format` | OK |
| E-12 | 接続していない Steam ID を kick | 400、`fields.steamId = not_online` | OK |
| E-13 | broadcast に改行 / 257 文字 | `invalid_characters` / `too_long` | OK |
| E-14 | 一覧に無いマップ | `fields.map = unknown_map` | OK |
| E-15 | 偽の確認トークンで execute | 400 `CONFIRM_INVALID` | OK |
| E-16 | prepare 後に params を変えて execute | 400 `CONFIRM_INVALID`(RCON は呼ばない) | OK |
| E-17 | 同じトークンで execute を再送 | 409 `ALREADY_EXECUTED`(RCON は 1 回だけ呼ばれる) | OK |
| E-18 | 未定義の `/api/nope` | 404 `NOT_FOUND`(JSON) | OK |
| E-19 | `POST /api/status`、`GET /logout` | 405 | OK |
| E-20 | `GET /api/audit?limit=0` | 400、`fields.limit = invalid_format` | OK |
| E-21 | モックを止めた状態で status / players / bans / maps / prepare kick | 502 `RCON_UNREACHABLE` | OK |
| E-22 | モックを別のパスワードで起動 | 502 `RCON_AUTH_FAILED` | OK |
| E-23 | E-21・E-22 のときの `GET /api/capabilities` | 200、`source: "unavailable"`(全項目 unknown) | OK |
| E-25 | 未ログインで `/_image`、`/_image?href=x`、`/favicon.ico`、`/favicon.svg` | すべて 303 `/login`(middleware の除外は `/_astro/` のみ) | OK |
| E-26 | ログイン後、偽の確認トークンで execute | 400 `CONFIRM_INVALID`。`/api/audit` の先頭に `event`(送った action)・`status: failed`・`errorCode: CONFIRM_INVALID`・操作者名付きの行が残る | OK |
| E-27 | ログイン後、Steam ID が不正な prepare(400 `VALIDATION_FAILED`) | 監査ログに行を作らない(E-26 の行の次はログインの行) | OK |
| E-24 | (旧方式。2026-10-16 の Worker Secrets 廃止で無くなった。現行は 6 章)管理パスワードの Secret を短く、RCON の接続先の Secret を IP アドレス(文書用アドレス)にして起動 | ページは 303 `/setup`、API は 503 `NOT_CONFIGURED`、`POST /login` も `/setup` へ。`/setup` は警告 2 件(短すぎる・IP アドレス不可)だけを表示し、値は出さない | OK |

単体テストのみで確認した項目(実機・dev では未確認):

- RCON のタイムアウト(`RCON_TIMEOUT`)、404 / 409 / 429(`Retry-After`)/ 5xx / 3xx / JSON 不正 / 512 KiB 超の分類、`rconMessage` の 200 文字切り詰めと制御文字除去、ログに接続先・パスワードが出ないこと(`src/lib/rcon/client.test.ts`)
- (旧方式。2026-10-16 の Worker Secrets 廃止で無くなった。現行は 6 章)D1 が無い / テーブルが無いときの features と、D1 なしでの execute の 1 回限り(メモリ近似)。現在は D1 必須で、この経路は削除した
- capabilities が `missing` のときの `CAPABILITY_MISSING`、別セッションのトークンの拒否(同上)
- 拒否の監査ログ: `CAPABILITY_MISSING`(prepare)・`CONFIRM_INVALID`・`CONFIRM_EXPIRED` が `status=failed`・nonce なしで 1 行残り、入力検証失敗と action 不明は残らないこと。正常な execute は 1 行(pending → succeeded)。`node:sqlite` で実際の SQL を実行(`src/lib/actions.test.ts`)
- ログイン制限の UPSERT … RETURNING(5 回まで加算、ロック中は更新しない、窓が過ぎたら 1 回目から、並行でも 5 回まで、成功で行を削除)を `node:sqlite` で実際の SQL で確認(`src/lib/throttle.test.ts`)
- Cookie の改ざん・期限切れ・鍵の変更(`src/lib/session.test.ts`)、throttle の D1 上限超過時のメモリ近似(`src/lib/throttle.test.ts`)

## 4. 既知の事象

- 2026-10-15 の初回確認では、Astro 標準の origin 検査(本文を読まずに 403 を返す)の直後に同じ接続(keep-alive)で送ったリクエストが開発サーバーで 500 になっていた。`astro.config.mjs` を `checkOrigin: false` にしたため、今は 403 をすべて本パネルの middleware が返し、拒否の前に本文を読み捨てるので、再確認では 403 の直後のリクエストも正常だった(E-4)。本番の Workers では未確認。
- 開発サーバー(astro dev)だけの事象: `Sec-Fetch-Site: cross-site` かつ画面遷移でないリクエストは、Vite の開発サーバーが本パネルより先に 403(`Cross-origin request blocked`、text/plain、セキュリティヘッダなし)を返す。本番のビルドには無い仕組みなので、本番では本パネルの middleware が 403 を返す想定(本番での確認は未実施)。
- RCON の実サーバーでの挙動(ルートの実在、応答形式、エラー形式)は未確認(`docs/ARCHITECTURE.md` 14 章 R-1〜R-17)。

## 5. 複数サーバー(2026-10-16)

`docs/ARCHITECTURE.md` 第 15 章・`docs/API.md` 1.2・7 章。値(パスワード・Cookie・接続先)は記録しない。

> 5 章は Worker Secrets 廃止前(既定サーバー・`.dev.vars` あり)の記録。既定サーバー(`default`)・`SERVER_READ_ONLY`・鍵の 2 系統は廃止した。現行の確認は 6 章。

### 5.1 確認環境

| 項目 | 内容 |
|---|---|
| RCON | `scripts/mock-rcon.mjs` を `MOCK_RCON_PORTS` で 2 ポート同時に起動(サーバー名 `Mock Server <ポート>`、ポートごとに人数・プレイヤー名が違う)。2 台目だけ `MOCK_RCON_PASSWORDS` で別のダミーパスワード。ポートは開発機の空きポート(既定の 7776 / 7777 とは別)を使った |
| Worker | `pnpm dev`(astro dev。Cookie 名 `wo_session` / `wo_server`) |
| Secrets | (旧方式。2026-10-16 の Worker Secrets 廃止で無くなった。現行は 6 章)当時は `.dev.vars` を管理パスワードだけにした状態で確認した |
| D1 | ローカル D1 に `pnpm db:migrate:local` で `0002_servers.sql` を適用 |
| 手段 | Node の `fetch` で書いた確認スクリプト(リポジトリ外)。サーバーの追加はホスト名 `localhost` |
| 単体テスト | `pnpm test`(vitest、11 ファイル・93 件すべて成功)。`pnpm check` エラー 0、`pnpm build` 成功 |

### 5.2 正常系

| # | 操作 | 期待 | 結果 |
|---|---|---|---|
| S-N1 | RCON の Secrets なしで `GET /` | `/setup` ではなく `/login` へ 303(ログインを止めない) | OK |
| S-N2 | `POST /login` → `GET /api/session` | ログイン成功。`features.servers: true`、`warnings` に `RCON_*` が無い | OK |
| S-N3 | `GET /api/servers`(0 台) | 200、`servers: []`、`manageable: true`、`limit: 20` | OK |
| S-N4 | `POST /api/servers`(1 台目・2 台目。2 台目はホスト名を大文字で入力) | 201、`test.ok: true`、`test.serverName` がそれぞれのモックの名前、`host` は小文字に正規化。応答にパスワード・暗号文(`v1.a.` 等)を含まない | OK |
| S-N5 | `GET /api/status?server=<1 台目>` / `?server=<2 台目>` | サーバー名・人数がそれぞれ別の値 | OK |
| S-N6 | `GET /api/players?server=` / `GET /api/capabilities?server=` | 指定したサーバーの一覧・capabilities | OK |
| S-N7 | `GET /api/status`(`server` 省略) | 表示順で最初に使えるサーバー | OK |
| S-N8 | `server` 省略 + 選択 Cookie(2 台目) | 2 台目 | OK |
| S-N9 | `server` 省略 + 選択 Cookie が削除済みの id | 無視して最初に使えるサーバー | OK |
| S-N10 | prepare kick(`server` = 1 台目) | 200、`server` が 1 台目、`targetName` が 1 台目のプレイヤー名 | OK |
| S-N11 | execute kick(同じ `server`) | 200、`server` と `auditId`。1 台目だけ人数が 1 減り、2 台目は変わらない(モックのログでも kick は 1 台目のポートにだけ届いた) | OK |
| S-N12 | `GET /api/audit?limit=10` | kick の行が `serverId` = 1 台目、`serverName` = 登録した表示名、`operator` 付き。login の行は `serverId: null` / `serverName: null` | OK |
| S-N13 | `GET /api/audit?server=<1 台目>` | 1 台目の書き込み操作だけ(login / logout を含まない) | OK |
| S-N14 | `GET /api/audit?kind=settings` | `kind: "settings"`、`server_add` が追加した台数分。パスワードを含まない | OK |
| S-N15 | `PUT /api/servers/:id`(改名 + 無効化) | 200、`name`・`enabled: false`、`test: null`(接続に関わる項目を変えていないので接続テストしない) | OK |
| S-N16 | `POST /api/servers/:id/test` | 200、`test.ok: true` | OK |
| S-N17 | `DELETE /api/servers/:id`(現在の表示名を `confirmName` に) | 200、`deletedId`。以後その id は 404 | OK |
| S-N18 | `GET /api/servers`(削除後) | 残りの台数。パスワード・暗号文を含まない | OK |
| S-N19 | `POST /logout` | `wo_session` と `wo_server` の両方を `Max-Age=0` で削除 | OK |
| S-N20 | dev サーバーのログ | RCON の失敗はルート名・ステータス・所要時間・コードだけ。接続先・パスワード・`Authorization` は出ない | OK |

### 5.3 異常系

| # | 操作 | 期待 | 結果 |
|---|---|---|---|
| S-E1 | 0 台で `GET /api/status`(`server` 省略) | 409 `NO_SERVERS` | OK |
| S-E2 | `?server=default` | (旧)404 `SERVER_NOT_FOUND` → 現在は 400、`fields.server = invalid_format`(6.4 の T2-5) | OK |
| S-E3 | ホスト名に IP アドレス | 400、`fields.host = ip_address` | OK |
| S-E4 | 既存と同じ表示名・ホスト名 + ポート | 400、`fields.name = duplicate`、`fields.host = duplicate` | OK |
| S-E5 | ホスト名に `http://…:ポート` を貼り付け、ポート 70000、パスワードが管理パスワードと同じ(現在は D1 の管理者のハッシュで検証。6.4 の T2-2) | 400、`host = invalid_format`、`port = out_of_range`、`password = same_as_admin_password` | OK |
| S-E6 | モックの無いポートを登録 | 201 で保存され、`test.ok: false`、`test.code = RCON_UNREACHABLE`(接続テストの失敗で保存を取り消さない) | OK |
| S-E7 | 本文が JSON の文字列(オブジェクトでない) | 400 `BAD_REQUEST` | OK |
| S-E8 | 別オリジンの POST / `text/plain` の POST | 403 `FORBIDDEN_ORIGIN` / 415 | OK |
| S-E9 | `?server=999`(存在しない)/ `?server=abc`(形式不正) | 404 `SERVER_NOT_FOUND` / 400 `fields.server = invalid_format` | OK |
| S-E10 | prepare に `server` が無い | 400、`fields.server = required`(監査ログに残さない) | OK |
| S-E11 | 1 台目で prepare したトークンを、`server` = 2 台目で execute | 400 `CONFIRM_INVALID`。RCON は呼ばない。監査ログに `status: failed`・`serverId` = 2 台目で 1 行残る | OK |
| S-E12 | 宛先(ポート)だけを変える PUT(パスワードなし) | 400、`fields.password = reenter_required` | OK |
| S-E13 | 無効にしたサーバーの `GET /api/status` | 409 `SERVER_DISABLED` | OK |
| S-E14 | `PUT /api/servers/default` | (旧)409 `SERVER_READ_ONLY` → 2026-10-16 の既定サーバー廃止後は 400、`fields.server = invalid_format`(6.4 で再確認) | OK |
| S-E15 | 同じサーバーの接続テストを 5 秒以内に再実行 | 429 `RATE_LIMITED`、`retryAfterSec` 付き | OK |
| S-E16 | DELETE の `confirmName` が現在の表示名と違う | 400、`fields.confirmName = mismatch` | OK |
| S-E17 | 本文の無い DELETE | `Content-Type` 無し・本文なし → 415 `UNSUPPORTED_MEDIA_TYPE`。`Content-Type: application/json`・本文なし → 400 `BAD_REQUEST`(2026-10-16 再実行。QA M-3 で旧記録「400」の食い違いを指摘されたため、2 通りに分けて記録) | OK |
| S-E18 | `GET /api/audit?kind=bad` | 400、`fields.kind = invalid_format` | OK |

### 5.4 単体テストのみで確認した項目

(2026-10-16 の Worker Secrets 廃止で、下記のうち鍵の出所 `k`・`s` / `a` の切り替え・再暗号化・既定サーバーの項目は削除された仕組みの記録。現行の単体テストは 6.5)

- 暗号化(`src/lib/servers.test.ts`): AES-256-GCM の往復、暗号文に平文を含まないこと、IV が毎回変わること。AAD(宛先・スキーム・鍵の出所 `k`)が違うと復号できないこと。鍵の 2 系統の切り替えと再暗号化(旧方式。現在は instance_key から派生した 1 系統で、鍵が変わると `needsPassword: true`・`SERVER_NEEDS_PASSWORD`・入れ直しで解消。6.5)
- 上限 20 台で `SERVER_LIMIT_REACHED`、削除した id を再利用しないこと、変更ログの `params`(パスワードを含まない)
- ホスト名の検証(小文字化・末尾の `.`・10 進 1 語の IPv4・IPv6・`@`・空白・253 文字超・国際化ドメイン名の punycode)、ポート・並び順の範囲
- 既定サーバーの扱い(旧方式。2026-10-16 の Worker Secrets 廃止で無くなった。現行は 6 章)
- 確認トークン(`src/lib/confirm.test.ts`): `sv`(別サーバーの id)・`sh`(同じ id で宛先が変わった)のすり替えを `CONFIRM_INVALID`、期限切れより先に判定。`sv` の無い旧形式のトークンは `CONFIRM_INVALID`。トークンに baseUrl そのものを入れないこと
- execute(`src/lib/actions.test.ts`): prepare 後にポートを変えたら `CONFIRM_INVALID`、無効にしたら `SERVER_DISABLED`(いずれも監査ログに `server_id` 付きで 1 行)、トークンが不正なら サーバーの状態より `CONFIRM_INVALID` を優先
- D1 の判定(`src/lib/config.test.ts`): 0001 だけ適用した D1 は `not_migrated`(`features` がすべて false)、0002 まで適用で `servers: true`
- 選択(`selectServer`): クエリ → Cookie → 最初の usable → 先頭。クエリの id が無い・形式不正なら切り替えない(`notFound`)

### 5.5 未確認

- ~~ページの選択 Cookie の発行は第 3 引数を渡したページでだけ行い、現状のページは渡していないため `Set-Cookie: wo_server` が出ない~~ → 2026-10-16 に再実行(QA M-3): 全ページが `Astro.response` を渡しており、`GET /?server=1` は `Set-Cookie: wo_server=<id>; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000`(開発のため `Secure` 無し)を返す。`?server=default`(形式不正)・`?server=999`(存在しない)は Cookie を出さず、ページは 200 で「見つかりません」の案内になる(6.4)
- `wrangler dev`(本番ビルド、`__Host-wo_server`)と本番 D1 での `db.batch()` の原子性(M-2)は未確認

## 6. Worker Secrets の廃止(2026-10-16)

`docs/ARCHITECTURE.md` 第 5 章(5.1.1 初期設定、5.1.2 instance_key、5.2 PBKDF2、5.3 Cookie v2)・7.4・8 章・16 章、`docs/API.md` 2 章。値(パスワード・ハッシュ・鍵・Cookie・接続先)は記録しない。

### 6.1 確認環境

| 項目 | 内容 |
|---|---|
| RCON | `MOCK_RCON_PORTS=7776,7777 pnpm mock:rcon`(2 ポート。パスワードはモックの既定のダミー値) |
| Worker | `pnpm dev --host 127.0.0.1 --port 4322`(astro dev。Cookie 名 `wo_session` / `wo_server`) |
| Secrets | **なし**。先に旧 `.dev.vars`(`ADMIN_PASSWORD` / `RCON_URL` / `RCON_PASSWORD` 入り)が残った状態で起動し、wrangler が読み込んでも(「Using secrets defined in .dev.vars」)コードが使わないことを確認(6.2 の S2-1〜S2-4 と同じ結果)。その後 `.dev.vars` を削除して再起動し、以降を確認した |
| D1 | 既存のローカル D1(`.wrangler/state/v3/d1`)を退避し、`pnpm db:migrate:local` で `0001_init.sql` + 書き換え後の `0002_servers.sql` を適用し直した空の D1 |
| 手段 | Node の `fetch` で書いた確認スクリプト(リポジトリ外)。管理パスワードはスクリプト内でランダム生成(24 文字)。全応答の本文に管理パスワード・RCON パスワードが含まれないことも確かめた(0 件) |
| 単体テスト | `pnpm test`(vitest、13 ファイル・105 件すべて成功)。`pnpm build` 成功。`pnpm check` は frontend 担当のファイルに 12 件残る(backend のファイルは 0 件) |

### 6.2 初期設定(/setup)

| # | 操作 | 期待 | 結果 |
|---|---|---|---|
| S2-1 | 管理者 0 件で `GET /`・`GET /login` | 303 → `/setup` | OK |
| S2-2 | 管理者 0 件で `GET /api/status`・`GET /api/session`(Cookie なし) | 503 `SETUP_REQUIRED`(認証より先に判定) | OK |
| S2-3 | 管理者 0 件で `POST /api/servers` | 503 `SETUP_REQUIRED` | OK |
| S2-4 | 管理者 0 件で `GET /setup` | 200、登録フォーム(`password` / `passwordConfirm`) | OK |
| S2-5 | `POST /setup` Origin なし(`Sec-Fetch-Site` なし)/ 別オリジン | 403(CSRF。/setup も対象) | OK |
| S2-6 | `POST /setup` 15 文字 | 400 `PASSWORD_TOO_SHORT`、フォーム再表示、入力したパスワードは再表示しない | OK |
| S2-7 | `POST /setup` 257 文字 | 400 `PASSWORD_TOO_LONG`(同上) | OK |
| S2-8 | `POST /setup` 確認入力が不一致 | 400 `PASSWORD_MISMATCH`(同上) | OK |
| S2-9 | `POST /setup` `Content-Type: text/plain` | 400 `BAD_REQUEST` | OK |
| S2-9b | 管理者 0 件・サーバー登録ありで、登録サーバーの RCON パスワードと同じ値を登録 | 303(登録する。`PASSWORD_SAME_AS_RCON` は返さない = 未認証者に一致を教えない。QA setup M-3) | OK(単体テスト `auth.test.ts`。dev サーバーでは未実施) |
| S2-10 | `POST /setup` 正常(24 文字・確認一致) | 303 → `/login?registered=1`(自動ログインしない) | OK |
| S2-11 | 登録後にもう一度 `POST /setup` | 409 `SETUP_ALREADY_DONE`(フォームは出さず、ログイン画面へのリンク) | OK |
| S2-12 | 登録後の `GET /setup`(未ログイン / ログイン済み) | 303 → `/login` / 303 → `/` | OK |
| S2-13 | 登録後の `GET /`・`GET /api/status`(未ログイン) | 303 → `/login` / 401 `UNAUTHENTICATED` | OK |
| S2-14 | `GET /api/audit?kind=settings` | `admin_register` が 1 行(`operator` / `sessionTag` / `serverId` は null、`params` は `{}`) | OK |

### 6.3 ログイン(PBKDF2・Cookie v2)

| # | 操作 | 期待 | 結果 |
|---|---|---|---|
| L2-1 | `POST /login` 誤ったパスワード | 401(フォーム再表示) | OK |
| L2-2 | `POST /login` 登録したパスワード | 303 → `/`、`Set-Cookie: wo_session=v2.<aid>.…; HttpOnly; SameSite=Strict; Max-Age=43200` | OK |
| L2-3 | `GET /api/session` | 200、`features` はすべて true、`warnings: []` | OK |
| L2-4 | `POST /logout` | 303 → `/login`、`wo_session` と `wo_server` を消す。操作ログに `logout` | OK |

### 6.4 サーバー・書き込み操作・QA 2026-10-16 の要修正

| # | 操作 | 期待 | 結果 |
|---|---|---|---|
| T2-1 | 0 台で `GET /api/status` | 409 `NO_SERVERS` | OK |
| T2-2 | `POST /api/servers` で RCON パスワード = 管理パスワード | 400、`fields.password = same_as_admin_password`(管理者のハッシュで検証) | OK |
| T2-3 | `POST /api/servers`(`localhost` 7776 / 7777) | 201、id `1` / `2`、接続テスト成功(`Mock Server 7776` / `7777`) | OK |
| T2-4 | `GET /api/servers` | 200、`{ servers, limit }`(`manageable` 無し)。行に `source` / `secretsIssue` 無し、パスワード・暗号文無し | OK |
| T2-5 | `GET /api/status?server=1` / `?server=default` | 200 `Mock Server 7776` / 400 `fields.server = invalid_format` | OK |
| T2-6 | kick の prepare → execute(server `1`) | 200、`auditId` は number、`server: "1"`。再送は 409 `ALREADY_EXECUTED` | OK |
| T2-7 | `GET /api/audit` | 先頭が `kick` / `succeeded` / `serverId: "1"` / `serverName: "Mock A"`、次が `login`(`serverId: null`)。`?server=default` は 400 | OK |
| T2-8 | (M-2)`PUT /api/servers/2 { port: 7778 }`(パスワードなし) | 400 `reenter_required`。`settings_audit_log` に `server_update_rejected`(`params`: `reason`・変更しようとした `host` / `port`)。`/api/audit?kind=settings` では `event: server_update`・`status: failed`・`errorCode: VALIDATION_FAILED` | OK |
| T2-9 | (M-2)`DELETE /api/servers/2 { confirmName: "mock b" }` | 400 `mismatch`。`server_delete_rejected`(`params`: `{ reason: "mismatch" }`。入力した名前は残さない)。API では `server_delete` / `failed` | OK |
| T2-10 | (M-2)`POST /api/servers/2/test` | 200 `test.ok: true`。`settings_audit_log` に `server_test`(`params`: `{ result }`)。契約の `SETTINGS_EVENTS` に無いため `/api/audit` には出さない(要確認、報告済み) | OK(D1 の行は単体テストで確認) |
| T2-11 | `PUT /api/servers/default` | 400、`fields.server = invalid_format`(旧 S-E14 の `SERVER_READ_ONLY` は廃止) | OK |
| T2-12 | (M-3)`GET /?server=1` | 200、`Set-Cookie: wo_server=<id>; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000` | OK |
| T2-13 | (M-3)`GET /players?server=default` / `?server=999` | 200(「見つかりません」の案内)、`Set-Cookie` なし | OK |
| T2-14 | (M-3、S-E17 の再実行)`DELETE /api/servers/2` を `Content-Type` 無し・本文なしで | 415 `UNSUPPORTED_MEDIA_TYPE` | OK |
| T2-15 | (同)`Content-Type: application/json`・本文なし | 400 `BAD_REQUEST` | OK |

### 6.5 単体テストで確認した項目

- `src/lib/password.test.ts`: PBKDF2 の往復、保存形式、salt が毎回変わる、反復回数 1 万回(定数 1 か所)、古い回数で `needsRehash`、範囲外の回数・形式不正・長さ違いは破損(`invalidHash`)、256 文字で打ち切り、空白を除かない
- `src/lib/keys.test.ts`: `instance_key` の `INSERT OR IGNORE` → `SELECT`(並行しても 1 行)、壊れた値は例外、用途別の鍵(`extractable: false`)、5 分キャッシュ
- `src/lib/session.test.ts`: Cookie v2 の往復、改ざん(期限・署名・操作者名・`aid` の付け替え)、`v1` は形式不正、`session_stamp` の変更・管理者の行の削除・鍵の変更で失効、行を消して登録し直すと(AUTOINCREMENT で新しい id)既存の Cookie は通らない
- `src/lib/auth.test.ts`: 初期設定の登録(`admins`・`settings`・`admin_register`)、入力検証、2 回目と**並行した 2 本の登録で 2 本目が `SETUP_ALREADY_DONE`**(条件付き INSERT の変更行数 0)、登録し直しでは登録サーバーの RCON パスワードとの同一判定をせず登録する(未認証者への漏えい防止。QA setup M-3。同一値はログイン後のサーバー保存時に `same_as_admin_password` で拒否。`instance_key` は変わらない)、ログイン(未登録で `setup_required`、成功で `login` を記録、5 回失敗でロック・失敗は記録しない、古い回数のハッシュの保存し直しで `session_stamp` を変えない、壊れたハッシュはコードだけをログに出す)
- `src/lib/servers.test.ts`: 暗号化 `v2.<iv>.<ct>`(AAD = 宛先、鍵違い・旧 `v1` は復号不可)、`same_as_admin_password`、`default` は形式不正、`instance_key` が変わると `needsPassword`・入れ直しで解消、拒否と接続テストの記録(M-2。他の項目にも誤りがある場合と `same_as_admin_password` は記録しない)
- `src/lib/actions.test.ts`: D1 必須(メモリ近似・`AUDIT_REQUIRED` の経路は削除)、`auditId` は常に number、pending を書けなければ RCON を呼ばない(`INTERNAL_ERROR`)、`server_id` が NULL の書き込み行は `serverId: null`
- `src/lib/config.test.ts`: `admins` / `settings` が欠けた D1 は `not_migrated`、旧 Secrets と `AUDIT_REQUIRED` を設定しても読まない

### 6.6 未確認

- `wrangler dev`(本番ビルド。`__Host-wo_session` / `__Host-wo_server`)での同じ確認は未実施
- 本番の Workers での PBKDF2(1 万回)の CPU 時間(C-20)、本番 D1 での条件付き INSERT・`db.batch()` の原子性(M-2)

### 6.7 `/api/status` の新項目(2026-10-17)

`docs/API.md` 3 章(`experiences`、`rotation.count` / `nextMap` / `nextMapName`)、`docs/ARCHITECTURE.md` 9.3。dev サーバーは起動せず(frontend の作業と並行のため)、単体テストと Node でのモック直接呼び出しで確認した。`/v1/rotation` の形式は非公式資料ベースの未検証(R-19)。

| # | 確認 | 期待 | 結果 |
|---|---|---|---|
| ST-1 | `/v1/status` の `experiences[]` | 文字列の要素だけ、最大 `STATUS_EXPERIENCES_MAX` 件・各 `STATUS_EXPERIENCE_MAX_LENGTH` 文字、制御文字を除く。配列でなければ `[]` | OK(`normalize.test.ts`) |
| ST-2 | `/v1/rotation` `{ enabled: true, entries }` + status の `nextIndex` | `count = entries.length`、`nextMap = entries[nextIndex].map`、表示名があれば `nextMapName` | OK(同上) |
| ST-3 | 要素の形式の揺れ(文字列 / `map` がオブジェクト / `mapId`・`id` / `mapName`・`name`) | 落ちずに読める。読めない要素・範囲外・`nextIndex` なしは `nextMap` / `nextMapName` だけ null(`count` は残す) | OK(同上) |
| ST-4 | `enabled: false`・`entries` が配列でない・最上位が配列 / null | 3 項目とも null(`nowIndex` / `nextIndex` は残す) | OK(同上) |
| ST-5 | capabilities の `routes` に `GET /v1/rotation` が無い / capabilities が取れない | `/v1/rotation` を呼ばない。3 項目 null、`/api/status` は成功 | OK(`reads.test.ts`) |
| ST-6 | 成功のキャッシュ | サーバーごとに 300 秒は再取得しない。次のマップは毎回 status の `nextIndex` から求める | OK(同上) |
| ST-7 | `/v1/rotation` が 500・形式不正・`enabled: false` | `/api/status` は成功・3 項目 null。60 秒は再取得しない | OK(同上) |
| ST-8 | `/v1/status` 自体の失敗 | 従来どおりのエラー。`/v1/rotation` は呼ばない | OK(同上) |
| ST-9 | `match_end` の execute | 成功でそのサーバーのキャッシュだけ破棄(他サーバー・失敗時・kick では破棄しない) | OK(`actions.test.ts`。`map` は同じ分岐) |
| ST-10 | モック(`MOCK_RCON_PORTS` に 2 ポート、Node から直接呼び出し) | ポートごとに `experiences`(1 件 / 2 件)・`entries` の件数(3 / 4)が異なる。capabilities に `GET /v1/rotation`。`match/end`・`match/map` でローテーション位置が 1 つ進み、他のポートは変わらない | OK |

- 単体テスト: `pnpm test` 14 ファイル・116 件すべて成功。`pnpm check` のエラーは frontend 担当のファイル(`src/layouts/OpsLayout.astro`、`src/pages/*.astro`、`src/components/{StatusPanel,ServersPanel}.tsx`)のみで、backend のファイルは 0 件
- 未確認: dev サーバー経由の `/api/status` の応答(frontend の作業後に確認する)、実サーバーの `/v1/rotation` の形式と `experiences` の意味(R-19)

## 7. スコア記録と受信(2026-10-17)

`docs/ARCHITECTURE.md` 第 17 章、`docs/API.md` 4.1・7.2・7.3・8〜10 章。値(パスワード・Cookie・受信用トークン・本文)は記録しない。

### 7.1 確認環境

| 項目 | 内容 |
|---|---|
| RCON | `MOCK_RCON_PORTS=7776,7777 MOCK_SCORE_STEP_SEC=3 pnpm mock:rcon`(スコアが 3 秒ごとに増え、1 台目は `scoreCap: 100` を返す。2 台目は返さない) |
| Worker | `pnpm dev --host 127.0.0.1 --port 4322`。Cron は `/cdn-cgi/handler/scheduled` で起こした(astro dev でも `src/worker.ts` の `scheduled` が呼ばれ、Workers Logs 相当の出力に `{ kind: 'cron', … }` が出ることを確認) |
| D1 | 既存のローカル D1 に `pnpm db:migrate:local` で `0003_recordings.sql` を適用。確認のため管理者の行を消して登録し直し、確認後に適用直後の D1 へ戻した |
| 手段 | Node の `fetch` の確認スクリプト(リポジトリ外)と curl(受信用トークンはヘッダファイル経由で渡し、出力しない。確認後に削除) |
| 単体テスト | `pnpm test`(vitest、16 ファイル・159 件すべて成功)。`pnpm check` 0 件、`pnpm build` 成功(`dist/server/entry.mjs` に `scheduled`、`dist/server/wrangler.json` に `triggers.crons`) |

### 7.2 スコア記録

| # | 操作 | 期待 | 結果 |
|---|---|---|---|
| R-1 | `prepare` `record_start`(server 1) | 200、`map`・`scoreCap: 100`・`scoreCapSource: "status"`・`destructive: false`。RCON は `/v1/status` だけ(capabilities を見ない) | OK |
| R-2 | `execute` `record_start` | 200、`auditKind: "settings"`、`match.status: "recording"`・`sampleCount: 1` | OK |
| R-3 | 同じトークンで再送 / もう一度 `prepare` | 409 `ALREADY_EXECUTED` / 409 `RECORDING_ALREADY_ACTIVE` | OK |
| R-4 | `GET /api/matches?server=1` | 記録中が先頭、`activeCount: 1`。`server` 省略は 400 `fields.server = required` | OK |
| R-5 | `GET /api/matches/:id/samples?server=1` / `?server=2` | 200(陣営スコア・人数・`cashTotal`・陣営別の人数と cash。名前・Steam ID なし)/ 404 `MATCH_NOT_FOUND` | OK |
| R-6 | 開始と同じ分に Cron 1 回 | `sampled: 1` だがサンプルは 1 行のまま(主キーで無視) | OK |
| R-7 | 次の分に Cron を 2 回続けて | サンプルは 1 行だけ増える(1 分バケットが重複しない) | OK |
| R-8 | スコアが 100 に達した後の Cron | `status: "ended"`・`endReason: "score_cap"`、`lastScores` が終了時の値。`/api/audit?kind=settings` に `record_end`(`operator: null`、`params: { recordingId, reason }`) | OK |
| R-9 | server 2(`scoreCap` を返さない)で開始 → `record_stop` | `scoreCapSource: "default"`、停止は 200・`endReason: "manual"` | OK |
| R-10 | 設定変更ログ | `record_start`(`params: { recordingId, map }`)・`record_stop`・`record_end` が `succeeded` で残る | OK |

### 7.3 受信(`POST /api/ingest/events`)

| # | 操作 | 期待 | 結果 |
|---|---|---|---|
| F-1 | `POST /api/servers/1/feed-token`(`{}`) | 200、`reissued: false`、`tokenHint` 4 文字、`status.configured: true` | OK |
| F-2 | 正しいトークンで `killed` 1 件のバッチ(Origin・Cookie なし) | 204。`feed_raw_events` に 1 行、`feed_daily`(サーバー・全体)が 1 加算 | OK |
| F-3 | 誤ったトークン / トークンなし | 401 `FEED_TOKEN_INVALID`(`WWW-Authenticate: Bearer`)。行は増えない | OK |
| F-4 | 空のバッチ(`[]`、本文なし) | 204。`feed_raw_events`・`feed_daily` とも増えない(D1 の行数で確認: 保存 2 行・日次 2 件のまま) | OK |
| F-5 | `Content-Type: text/plain` / GET | 415 / 405 | OK |
| F-6 | パスの例外の範囲: 末尾 `/` / `//api/ingest/events` / `/api/INGEST/events` | 204(例外の対象)/ 403(例外の対象外。CSRF 検査で拒否) / 403 `FORBIDDEN_ORIGIN` | OK |
| F-7 | 204 の応答ヘッダ | `Cache-Control: no-store`、CSP・`X-Frame-Options`・`X-Content-Type-Options`、`Set-Cookie` なし | OK |
| F-8 | 受信の状況・生データ | `GET /api/servers/1/feed` に `lastReceivedAt`・`lastStoredAt`・`today`、`GET /api/feed/raw` に `eventCount`・受信時に記録中の試合(`matchId`)。応答にトークンが含まれない | OK |
| F-9 | モックの送信モード(`MOCK_FEED_URL` / `MOCK_FEED_TOKEN`、2 秒ごと) | `killed` バッチと空のバッチが交互に 204。保存は `killed` の分だけ | OK |
| F-10 | `DELETE /api/servers/1/feed-token` → 同じトークンで送信 | 200 `configured: false` → 401 | OK |
| F-11 | dev サーバーのログ | トークン・本文を含まない(`wof1.` の出現 0 件) | OK |

### 7.4 単体テストで確認した項目

- `src/lib/recordings.test.ts`: 上限の優先順位(status → 設定 → 既定)、サンプルの陣営別集計、開始の batch と nonce の 1 回限り、並行した開始は部分 UNIQUE 索引で 1 本だけ、RCON 失敗時は記録しない(同じトークンでやり直せる)、players 失敗時も開始、トークンの検証(別サーバー・別系列・期限切れ)、全体の上限、停止と既に終わった試合、`match_end` 成功で `match_action`、Cron の二重実行(サンプル 1 行・`record_end` 1 行)、各終了条件(`score_cap`・`map_changed`〔サンプルを保存しない〕・`empty`〔途中で人が来たら戻す〕・`max_duration`・`server_unavailable`〔無効化・削除〕)、RCON に届かない分は何もしない、D1 が無い・0003 未適用で例外を投げない、保持数(6 試合目で最古をサンプルごと削除)、毎時の掃除、`scoreCap` の検証と変更ログ
- `src/lib/feed.test.ts`: トークンの形式・ハッシュ保存(平文・ハッシュを応答・変更ログに出さない)、不一致・形式不正・別サーバー・取り消し後・再発行後の旧トークンは 401、空のバッチで D1 に書かない、既知外の JSON の保存と `event_count`、Content-Type・サイズ・JSON の検証、受信の状況の 1 分間引き、1 分 90 回(不一致のトークンは枠を使わない)、保存停止・サーバー無効・1 日の上限(サーバー・全体)で 204 のまま捨てる、サーバー削除で受信設定も消える、ログにトークン・本文を出さない
- `src/lib/config.test.ts`: 0003 の表が欠けた D1 は `not_migrated`

### 7.5 未確認

- 本番(Workers Builds・Deploy ボタン経由)での Cron の起動(C-10・C-22)、本番 D1 での `WITHOUT ROWID`・部分索引・batch の原子性(C-23)、Cron 1 回の CPU 時間(C-24)
- 実サーバーのキルフィードの本文の形式・送信間隔・空のバッチを送るか・再送の挙動(K-1・K-3・K-6)、`scoreCap` / `matchSeconds` / `cash` の意味(R-21・R-22)
- `wrangler dev`(本番ビルド)での同じ確認は未実施(astro dev のみ)

### 7.6 キルフィード第 2 段階(正規化・保存・API。2026-10-17)

`docs/ARCHITECTURE.md` 17.10、`docs/API.md` 11 章。値(管理パスワード・Cookie・受信用トークン・プレイヤー名・Steam ID)は記録しない。

**確認環境**

| 項目 | 内容 |
|---|---|
| Worker | `pnpm build` の成果物を `wrangler dev --port 4391 --persist-to <別の状態ディレクトリ> --test-scheduled`(本番ビルド。司令塔の dev サーバー 4322 とその D1 は使わない) |
| D1 | 空の別の状態ディレクトリに `wrangler d1 migrations apply DB --local --persist-to …` で 0001〜0004 を適用。`/setup` で管理パスワード(確認スクリプト内でランダム生成)を登録してログイン |
| RCON・送信 | `MOCK_RCON_PORTS=7790 MOCK_FEED_URL=http://127.0.0.1:4391 MOCK_FEED_TOKEN=<発行したトークン> MOCK_FEED_SHAPE=mixed MOCK_FEED_SEC=1 pnpm mock:rcon`(サーバーの追加はホスト名 `localhost`、ポート 7790) |
| 手段 | Node の `fetch` の確認スクリプト(リポジトリ外)と `wrangler d1 execute --local --persist-to …`。Cron は curl で `/cdn-cgi/handler/scheduled` を呼んだ |
| 司令塔の D1 | 4322 が使うローカル D1(`.wrangler/state`)には `pnpm db:migrate:local` で `0004_killfeed.sql` だけを適用した(行は足していない)。適用後も `/login` 200、`/api/killfeed/kills` は未ログインで 401 |
| 単体テスト | `pnpm test`(vitest、19 ファイル・410 件すべて成功。frontend の `killstats.test.ts` を含む)、`pnpm build` 成功。`pnpm check` 0 件(frontend の作業中のファイルで `tsc` が 1 件出た時点があったが、最終的に 0 件) |

**結果**

| # | 操作 | 期待 | 結果 |
|---|---|---|---|
| K2-1 | 正しいトークンで mixed のバッチ(変種 1〜10)を約 1 分 | すべて 204。`feed_kills` にキルの行(変種 8〜9 は保存されない)、`feed_raw_events` にバッチ 1 行ずつ | OK(記録外で 18 キル) |
| K2-2 | `GET /api/killfeed/kills?server=1&match=unrecorded` | 200、`scope: "unrecorded"`・`match: null`、古い順。武器・乗り物・印・距離・ゲーム内時刻が正規化されている(変種 1 は `WEPN_031`・37.2 m・headshot・3151 秒、変種 3 は `TNK_01 · Anti Air`・roadkill、変種 4 は suicide で `teamkill: null`、変種 5 は `teamkill: true`、変種 7 はキラー null・`Test Fall`)。変種 2・3(陣営なし)は記録外なので陣営不明 | OK |
| K2-3 | `record_start` の後に同じ送信を続け、`match=<試合 id>` | 200、`match.status: "recording"`。変種 2・3 の当事者に `factionSource: "roster"` の陣営が付き、`teamkill` が判定される。`factions` は最後のサンプルの順 | OK |
| K2-4 | `after=<cursor>` | 200、`incremental: true`、それ以降のキルだけ(`truncated: false`) | OK |
| K2-5 | `GET /api/feed/raw/:id/normalized`(変種 6 を含む本文) | `envelope: "array"`、`bigIntegersQuoted: 1`、引用符無しの 17 桁の Steam ID を桁落ちなく読む | OK |
| K2-6 | 同上(変種 10 / 変種 9) | `envelope: "events"`・kill 2 件 / `incomplete` 1 件・`unmappedKeys: ["a"]` | OK |
| K2-7 | `PUT /api/servers/1/feed` `{ enabled: true, rawEnabled: "x" }` / `rawEnabled: false` | 400 `fields.rawEnabled = invalid_format` / 200 `rawEnabled: false`。以後 `feed_raw_events` は 38 行のまま増えず、`feed_kills` は 60 → 79 行に増えた | OK |
| K2-8 | 日次の上限: `feed_daily.kills` を 2,999 にして送信を続ける | 1 キルのバッチで 3,000 に達し、以後のバッチは全部捨てる(`feed_kills` は増えない)。`dropped_kills` が 1 分ごとに加算(46) | OK |
| K2-9 | `GET /api/servers/1/feed` | `rawEnabled`・`killsToday`(`kills` / `otherEvents` / `incomplete` / `droppedKills`)・`killLimits`(3,000 / 8,000 / 100 / 7)。キル以外・読み取れないキルの件数は受信の状況と同じく 1 分に 1 回まとめて `feed_daily` に書かれる(other 5・incomplete 5 を確認) | OK |
| K2-10 | 異常系: `server` なし / `match` なし / `match=abc` / `match=999` / `after=x` / 未ログイン / POST | 400 `server = required` / 400 `match = required` / 400 `invalid_format` / 404 `MATCH_NOT_FOUND` / 400 `after = invalid_format` / 401 `UNAUTHENTICATED` / 405 | OK |
| K2-11 | 異常系(正規化の試行): `:id=abc` / `server` なし / 無い id | 400 `fields.id` / 400 `fields.server = required` / 404 `NOT_FOUND` | OK |
| K2-12 | 監査ログ(`/api/audit?kind=settings`) | `feed_settings_update`(`params: { enabled: true, rawEnabled: false }`、操作者・succeeded)、`record_start`、`feed_token_issue`。応答にトークン・管理パスワードが含まれない | OK |
| K2-13 | Cron(curl で scheduled) | 記録中の試合のサンプルに `roster_json`(Steam ID → 陣営の添字。名前なし)。開始時のサンプルにも同じ形で入る | OK |
| K2-14 | Worker のログ | `wof1.`・プレイヤー名の出現 0 件 | OK |

**ローカル D1 での確認(C-25・C-26。本番 D1 は要確認のまま)**

- C-25: `INSERT INTO feed_kills (...) SELECT ..., json_extract(value, '$.…') ... FROM json_each(?) ORDER BY CAST(key AS INTEGER)` が `wrangler d1 execute --local` と `wrangler dev` の両方で動いた(Steam ID は `TEXT` のまま、null は NULL、記録中の試合の id の副問い合わせも可)。1 文の大きさの上限(1 バッチ 100 キル ≒ 20 KB のバインド)は本番で未確認。
- C-26: `wrangler d1 migrations apply --local` で 2 つのトリガーが作られ(`sqlite_master` で確認)、`DELETE FROM match_recordings` でその試合のキルが、`DELETE FROM servers` でそのサーバーの記録外のキルだけが消えた(試合に属するキルは残る)。
- `INSERT ... SELECT ... WHERE ... ON CONFLICT ... DO UPDATE ... WHERE ... RETURNING`(キルの日次の上限)も `wrangler dev` で期待どおり。

**単体テストで確認した項目**

- `src/lib/killfeed/normalize.test.ts`: 対応表の全候補(1 候補ずつ `matched` に出ること)、16 桁以上の整数の引用(小数・指数・負数・0 始まり・文字列の中は対象外)、外側の形 4 種と invalid、種類の判定(`KILL_EVENT_TYPES`・種類なし)、値の検証(Steam ID の形式・距離の範囲と丸め・cm・時刻の ±1 日・`m:ss`・真偽の表記・名前の切り詰め)、flagList、自殺(印・同じ Steam ID)、incomplete、1 バッチ 100 件、診断(値を含めない)
- `src/lib/killfeed/store.test.ts`: 受信からの保存と件数の間引き、`raw_enabled = 0` でキルだけ保存・PUT の検証と変更ログ、生データの上限はキルを止めない、キルの日次の上限(サーバー・全体。全部捨てる)、`enabled = 0` で保存しない、roster の鮮度(3 分)、出所が違えば `teamkill = null`、`buildRosterJson`、差分の位置(同じ受信時刻の複数行)、クエリの検証・`MATCH_NOT_FOUND`・記録外 500 件、トリガー(試合・サーバーの削除)、記録外の期限切れ(毎時の掃除)、正規化の試行
- `src/lib/recordings.test.ts`: 開始時と Cron のサンプルの `roster_json`(players が取れなければ NULL)
- `src/lib/config.test.ts`: 0004 の表・列が無い D1 は `not_migrated`

**未確認**

- 本番 D1 での `json_each` の INSERT・トリガー(C-25・C-26)、受信 1 件の CPU 時間(C-27)
- 実サーバーの本文の項目名(K-1・K-9〜K-14)。mixed の変種の項目名もすべて推測
