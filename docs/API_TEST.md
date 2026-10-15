# API 動作確認記録

確認日: 2026-10-15(JST)/ 担当: backend(同日、QA レビュー M-2・M-3・M-4・M-6 の修正後に N-18・E-4・E-6b・E-25〜E-27 と 4 章を再確認)/ 2026-10-16: 複数サーバー対応(5 章)
対象: `docs/API.md` の各エンドポイント。値(パスワード・Cookie・接続先)は記録しない。

## 1. 確認環境

| 項目 | 内容 |
|---|---|
| RCON | `scripts/mock-rcon.mjs`(`pnpm mock:rcon`。架空のプレイヤー 4 人・BAN 1 件。形式は `docs/research/wardogs-rcon.md` 2 章に合わせた架空のもので、実サーバーの挙動は未確認) |
| Worker | (a) `pnpm dev`(astro dev。Cookie 名 `wo_session`)、(b) `pnpm build` 後の `wrangler dev`(本番と同じ `__Host-wo_session`、`Secure` 付き) |
| Secrets | `.dev.vars` にダミー値(`ADMIN_PASSWORD` はランダム 24 文字、`RCON_URL=http://localhost:7776`、`RCON_PASSWORD` はモックの既定値) |
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
| E-24 | `ADMIN_PASSWORD` を短く、`RCON_URL` を IP アドレス(文書用アドレス)にして起動 | ページは 303 `/setup`、API は 503 `NOT_CONFIGURED`、`POST /login` も `/setup` へ。`/setup` は警告 2 件(短すぎる・IP アドレス不可)だけを表示し、値は出さない | OK |

単体テストのみで確認した項目(実機・dev では未確認):

- RCON のタイムアウト(`RCON_TIMEOUT`)、404 / 409 / 429(`Retry-After`)/ 5xx / 3xx / JSON 不正 / 512 KiB 超の分類、`rconMessage` の 200 文字切り詰めと制御文字除去、ログに接続先・パスワードが出ないこと(`src/lib/rcon/client.test.ts`)
- D1 が無い / テーブルが無いときの features(書き込み不可、`AUDIT_REQUIRED="false"` で可)、D1 なしでの execute の 1 回限り(メモリ近似)とログに Steam ID・名前を出さないこと(`src/lib/actions.test.ts`)
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

### 5.1 確認環境

| 項目 | 内容 |
|---|---|
| RCON | `scripts/mock-rcon.mjs` を `MOCK_RCON_PORTS` で 2 ポート同時に起動(サーバー名 `Mock Server <ポート>`、ポートごとに人数・プレイヤー名が違う)。2 台目だけ `MOCK_RCON_PASSWORDS` で別のダミーパスワード。ポートは開発機の空きポート(既定の 7776 / 7777 とは別)を使った |
| Worker | `pnpm dev`(astro dev。Cookie 名 `wo_session` / `wo_server`) |
| Secrets | `.dev.vars` から `RCON_URL` / `RCON_PASSWORD` を**外し**、`ADMIN_PASSWORD` だけにした状態(確認後に元へ戻した) |
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
| S-E2 | Secrets なしで `?server=default` | 404 `SERVER_NOT_FOUND` | OK |
| S-E3 | ホスト名に IP アドレス | 400、`fields.host = ip_address` | OK |
| S-E4 | 既存と同じ表示名・ホスト名 + ポート | 400、`fields.name = duplicate`、`fields.host = duplicate` | OK |
| S-E5 | ホスト名に `http://…:ポート` を貼り付け、ポート 70000、パスワードが `ADMIN_PASSWORD` と同じ | 400、`host = invalid_format`、`port = out_of_range`、`password = same_as_admin_password` | OK |
| S-E6 | モックの無いポートを登録 | 201 で保存され、`test.ok: false`、`test.code = RCON_UNREACHABLE`(接続テストの失敗で保存を取り消さない) | OK |
| S-E7 | 本文が JSON の文字列(オブジェクトでない) | 400 `BAD_REQUEST` | OK |
| S-E8 | 別オリジンの POST / `text/plain` の POST | 403 `FORBIDDEN_ORIGIN` / 415 | OK |
| S-E9 | `?server=999`(存在しない)/ `?server=abc`(形式不正) | 404 `SERVER_NOT_FOUND` / 400 `fields.server = invalid_format` | OK |
| S-E10 | prepare に `server` が無い | 400、`fields.server = required`(監査ログに残さない) | OK |
| S-E11 | 1 台目で prepare したトークンを、`server` = 2 台目で execute | 400 `CONFIRM_INVALID`。RCON は呼ばない。監査ログに `status: failed`・`serverId` = 2 台目で 1 行残る | OK |
| S-E12 | 宛先(ポート)だけを変える PUT(パスワードなし) | 400、`fields.password = reenter_required` | OK |
| S-E13 | 無効にしたサーバーの `GET /api/status` | 409 `SERVER_DISABLED` | OK |
| S-E14 | `PUT /api/servers/default` | 409 `SERVER_READ_ONLY` | OK |
| S-E15 | 同じサーバーの接続テストを 5 秒以内に再実行 | 429 `RATE_LIMITED`、`retryAfterSec` 付き | OK |
| S-E16 | DELETE の `confirmName` が現在の表示名と違う | 400、`fields.confirmName = mismatch` | OK |
| S-E17 | 本文の無い DELETE | 400 `BAD_REQUEST` | OK |
| S-E18 | `GET /api/audit?kind=bad` | 400、`fields.kind = invalid_format` | OK |

### 5.4 単体テストのみで確認した項目

- 暗号化(`src/lib/servers.test.ts`): AES-256-GCM の往復、暗号文に平文を含まないこと、IV が毎回変わること。AAD(宛先・スキーム・鍵の出所 `k`)が違うと復号できないこと。鍵の切り替え(`s` は SESSION_SECRET だけ、`a` は ADMIN_PASSWORD だけに依存)。ADMIN_PASSWORD を変えると `needsPassword: true`・`SERVER_NEEDS_PASSWORD`・`unreadable`(警告 `SERVER_PASSWORDS_UNREADABLE`)、パスワードの入れ直しで解消。SESSION_SECRET 設定後の `a` → `s` の再暗号化(1 回きり、`updated_at`・変更ログを変えない)
- 上限 20 台(既定サーバーは数えない)で `SERVER_LIMIT_REACHED`、削除した id を再利用しないこと、変更ログの `params`(パスワードを含まない)
- ホスト名の検証(小文字化・末尾の `.`・10 進 1 語の IPv4・IPv6・`@`・空白・253 文字超・国際化ドメイン名の punycode)、ポート・並び順の範囲
- 既定サーバー: 両方ありで使える、片方だけで `NOT_CONFIGURED`(一覧に `secretsIssue`)、両方なしで一覧に出ず `SERVER_NOT_FOUND`。接続テストの結果はメモリだけ
- 確認トークン(`src/lib/confirm.test.ts`): `sv`(別サーバーの id)・`sh`(同じ id で宛先が変わった)のすり替えを `CONFIRM_INVALID`、期限切れより先に判定。`sv` の無い旧形式のトークンは `CONFIRM_INVALID`。トークンに baseUrl そのものを入れないこと
- execute(`src/lib/actions.test.ts`): prepare 後にポートを変えたら `CONFIRM_INVALID`、無効にしたら `SERVER_DISABLED`(いずれも監査ログに `server_id` 付きで 1 行)、トークンが不正なら サーバーの状態より `CONFIRM_INVALID` を優先
- D1 の判定(`src/lib/config.test.ts`): 0001 だけ適用した D1 は `not_migrated`(`features` がすべて false)、0002 まで適用で `servers: true`
- 選択(`selectServer`): クエリ → Cookie → 最初の usable → 先頭。クエリの id が無い・形式不正なら切り替えない(`notFound`)

### 5.5 未確認

- ページの選択 Cookie の発行(`?server=` で決まったとき)は、`getPageContext(request, locals, Astro.response)` のように第 3 引数を渡したページでだけ行う。現状のページ(frontend 担当)はまだ渡していないため、`GET /?server=…` で `Set-Cookie: wo_server` が出ないことを確認した(frontend の対応後に再確認する)
- `wrangler dev`(本番ビルド、`__Host-wo_server`)と本番 D1 での `db.batch()` の原子性(M-2)は未確認
