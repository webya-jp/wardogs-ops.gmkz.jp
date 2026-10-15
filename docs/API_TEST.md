# API 動作確認記録

確認日: 2026-10-15(JST)/ 担当: backend
対象: `docs/API.md` の各エンドポイント。値(パスワード・Cookie・接続先)は記録しない。

## 1. 確認環境

| 項目 | 内容 |
|---|---|
| RCON | `scripts/mock-rcon.mjs`(`pnpm mock:rcon`。架空のプレイヤー 4 人・BAN 1 件。形式は `docs/research/wardogs-rcon.md` 2 章に合わせた架空のもので、実サーバーの挙動は未確認) |
| Worker | (a) `pnpm dev`(astro dev。Cookie 名 `wo_session`)、(b) `pnpm build` 後の `wrangler dev`(本番と同じ `__Host-wo_session`、`Secure` 付き) |
| Secrets | `.dev.vars` にダミー値(`ADMIN_PASSWORD` はランダム 24 文字、`RCON_URL=http://localhost:7776`、`RCON_PASSWORD` はモックの既定値) |
| D1 | ローカル D1 に `pnpm db:migrate:local` で `0001_init.sql` を適用 |
| 手段 | Node の `fetch` で書いた確認スクリプト(リポジトリ外)と curl。(a)(b) の両方で同じ結果(下記 4 章の 1 件を除く) |
| 単体テスト | `pnpm test`(vitest、10 ファイル・57 件すべて成功) |

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
| N-18 | 全応答のヘッダ | `Cache-Control: no-store`、`X-Frame-Options: DENY`、CSP(`frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'`)、`Referrer-Policy: no-referrer`、`X-Content-Type-Options: nosniff`、`X-Robots-Tag: noindex, nofollow` | OK |
| N-19 | `GET /setup`(設定済み) | 「設定済みです。」だけを表示 | OK |

## 3. 異常系

| # | 操作 | 期待 | 結果 |
|---|---|---|---|
| E-1 | 未ログインで `GET /api/status` | 401 `UNAUTHENTICATED` | OK |
| E-2 | 未ログインで `GET /` | 303 `/login` | OK |
| E-3 | `POST /login` に Origin なし(Sec-Fetch-Site もなし) | 403 | OK |
| E-4 | `POST /login` の Origin が別サイト | 403(Astro 標準の origin 検査が先に返す。4 章) | OK |
| E-5 | `POST /login` 誤パスワード | 401 でフォーム再表示(「パスワードが違います。」)、約 300 ms 遅延 | OK |
| E-6 | 同じ接続元から 5 回失敗 → 6 回目 | 1〜5 回目 401、6 回目 429(「約 N 分間ログインできません」)。ロック中は正しいパスワードでも 429。別の接続元はログインできる | OK |
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
| E-24 | `ADMIN_PASSWORD` を短く、`RCON_URL` を IP アドレス(文書用アドレス)にして起動 | ページは 303 `/setup`、API は 503 `NOT_CONFIGURED`、`POST /login` も `/setup` へ。`/setup` は警告 2 件(短すぎる・IP アドレス不可)だけを表示し、値は出さない | OK |

単体テストのみで確認した項目(実機・dev では未確認):

- RCON のタイムアウト(`RCON_TIMEOUT`)、404 / 409 / 429(`Retry-After`)/ 5xx / 3xx / JSON 不正 / 512 KiB 超の分類、`rconMessage` の 200 文字切り詰めと制御文字除去、ログに接続先・パスワードが出ないこと(`src/lib/rcon/client.test.ts`)
- D1 が無い / テーブルが無いときの features(書き込み不可、`AUDIT_REQUIRED="false"` で可)、D1 なしでの execute の 1 回限り(メモリ近似)とログに Steam ID・名前を出さないこと(`src/lib/actions.test.ts`)
- capabilities が `missing` のときの `CAPABILITY_MISSING`、別セッションのトークンの拒否(同上)
- Cookie の改ざん・期限切れ・鍵の変更(`src/lib/session.test.ts`)、throttle の D1 上限超過時のメモリ近似(`src/lib/throttle.test.ts`)

## 4. 既知の事象

- 開発サーバー(astro dev / wrangler dev の両方)で、本文を読まずに返した応答の直後に同じ接続(keep-alive)で送った次のリクエストが 500(`Network connection lost` / `fetch failed`)になることがある。こちらの middleware・API は拒否の前に本文を読み捨てるようにして解消した。ただし Astro 標準の origin 検査(別オリジンからのフォーム POST に `Cross-site POST form submissions are forbidden` の 403 を返す)は本パネルの middleware より先に動き、本文を読まずに返すため、E-4 の直後のリクエストだけは開発サーバーで失敗する(curl のように接続を毎回作ると起きない)。本番の Workers で起きるかは未確認。この 403 にはセキュリティヘッダも付かない。
- RCON の実サーバーでの挙動(ルートの実在、応答形式、エラー形式)は未確認(`docs/ARCHITECTURE.md` 14 章 R-1〜R-17)。
