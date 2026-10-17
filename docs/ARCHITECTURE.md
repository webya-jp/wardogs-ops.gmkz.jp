# wardogs-ops 構成(正本)

作成日: 2026-10-15(JST)/ 更新: 2026-10-17(画面構成をサイドバー + ヘッダータブに。第 9 章・13.8・15.5)、2026-10-16(複数サーバー対応、第 15 章。Worker Secrets の廃止、第 5 章・第 16 章)/ 担当: architect
上位の正本: `docs/PLAN.md`(2026-10-15 改訂版)。契約: `docs/API.md`、`src/types/api.ts`、`src/types/env.ts`、`db/schema.sql`、`db/migrations/`、`wrangler.jsonc`。
RCON の仕様は非公式資料ベース(`docs/research/wardogs-rcon.md`)。本書の「未検証」「要確認」は第 14 章の番号(R-n / C-n / I-n / M-n / K-n / U-n)で参照する。

## 1. 目的と設計目標

- 任意の WARDOGS コミュニティサーバー運営者が、**フォーク(またはボタンで複製)→ Deploy to Cloudflare → パネルの URL を開いて管理パスワードを登録(`/setup`)→ サーバー側で RCON を有効化 → パネルの画面でサーバー(ホスト名・ポート・RCON パスワード)を追加** だけで使える運営パネル。**Cloudflare 側で Secrets・環境変数を入力する手順は無い**(2026-10-16。第 5 章)。サーバーは何台でも追加できる(上限 20 台。第 15 章)。
- 運営者 1〜数人が 1 つの管理パスワードを共有して使う規模を想定する。アカウント管理・権限分離はしない(D1 `admins` は将来に備えて複数行を許す形だけ用意する。8.7)。
- Cloudflare 無料プラン(Workers / D1)の範囲で動かす。KV・R2・Cron・Access・Tunnel は使わない(第 2 段階の選択肢は 12 章)。
- 公開リポジトリのテンプレートなので、リポジトリには接続先・パスワード等を一切含めない。利用者固有の値(管理パスワードのハッシュ、鍵、RCON の接続先と暗号化したパスワード)はすべて利用者自身の D1 に置く。

## 2. 構成図

```
運営者のブラウザ
  │  HTTPS(https://wardogs-ops.<アカウント>.workers.dev。カスタムドメインは任意)
  ▼
Cloudflare Worker「wardogs-ops」(Astro SSR + React アイランド)
  ├─ middleware: D1 の判定 → CSRF(Origin)検査 → 管理者の登録の有無(未登録なら /setup)→ ログイン Cookie 検証 → セキュリティヘッダ
  ├─ /setup(初期設定: 管理パスワードの登録)、/login, /logout(フォーム POST。JS 無しで動く)
  ├─ ページ: / 状態, /players, /bans, /audit, /servers(ヘッダーで対象サーバーを選ぶ。15.5)
  ├─ /api/*: 読み取り(status / players / bans / maps / capabilities / audit / session / servers)
  │          書き込み(actions/prepare → actions/execute の二段階)、サーバー設定(servers の追加・変更・削除・接続テスト)
  ├─ D1「DB」(必須): admins / settings(instance_key)/ servers / audit_log / server_snapshots / login_throttle / settings_audit_log
  └─ fetch(選択中のサーバーへ。Authorization: Bearer <そのサーバーの RCON パスワード>、タイムアウト付き、リダイレクト非追従)
        │  平文 HTTP(C-1 要確認)。送信元 IP は固定されない(C-3)
        ▼
     RCON HTTP API(http://<ホスト名>:<ポート>。D1 servers に登録。IP アドレス直指定は不可)
     ゲームサーバー側: ServerSettings.ini の [/Script/WDRCON.WDRCONSettings](R-3, R-4 要確認)
```

ブラウザが RCON を直接叩くことはない。RCON パスワード(D1 の暗号文とその平文)、管理パスワードのハッシュ、`instance_key` と派生した鍵はブラウザに一切渡らない(クライアントバンドル・HTML・API 応答のいずれにも含めない)。画面から登録したサーバーのホスト名・ポートだけは、編集のためにログイン済みの運営者に表示する(15.2)。Worker Secrets は使わない(第 5 章)。

## 3. 技術構成とディレクトリ

| 項目 | 採用 | 根拠 |
|---|---|---|
| フレームワーク | Astro 7(`astro@^7.3.8`)+ `@astrojs/react@^7.0.1` + React 19 | 参考実装(`../wardogs.gmkz.jp`)と同系列。`@astrojs/cloudflare@14` の peer が `astro ^7.2.0` のため Astro 7 系になる(エージェント定義の「Astro 5 系」とは異なる。司令塔に報告済み) |
| アダプタ | `@astrojs/cloudflare@^14.3.4`、`output: 'server'` | 全ページにログイン判定を掛けるため、静的ページは作らない(静的アセットは middleware を通らない) |
| セッション機能 | Astro Sessions は無効(`session: false`) | 有効だと KV「SESSION」が自動作成される。KV 書き込み 1,000/日の枠と自動プロビジョニングの対象を増やさない |
| 画像 | `imageService: 'passthrough'` | Images バインディング・sharp を要求しない |
| Worker 設定 | `wrangler.jsonc`(`name: wardogs-ops`、`workers_dev: true`、`preview_urls: false`、`compatibility_date: 2026-09-01`、`nodejs_compat`) | 2024-09-02 以降で `allow_custom_ports` が既定有効(7776 等への fetch) |
| D1 | `database_id` 省略の自動プロビジョニング(`database_name: wardogs-ops-db`) | wrangler 4.45.0 以上(open beta)。本リポジトリは 4.151 |
| パッケージ管理 | pnpm 10 | 参考実装と同じ |

```
/
├─ astro.config.mjs / wrangler.jsonc / tsconfig.json / package.json
├─ db/
│  ├─ schema.sql              # 現行スキーマのまとめ(参照用)
│  └─ migrations/0001_init.sql, 0002_servers.sql(複数サーバー・管理者・設定。8 章)
├─ docs/                      # PLAN / ARCHITECTURE / API / research
└─ src/
   ├─ env.d.ts                # Cloudflare.Env と App.Locals の型付け
   ├─ middleware.ts           # 設定チェック、ヘッダ、認証、CSRF(backend)
   ├─ i18n/                   # 多言語化(第 13 章。architect が雛形、文言の追加は各担当)
   │  ├─ ja.ts                # 日本語カタログ(キーの正本。型で全キーを強制)。言語を足すときは en.ts 等
   │  └─ index.ts             # t(key, params?)、getTranslator、resolveLanguage、toLocale、formatDateTime 等
   ├─ types/
   │  ├─ api.ts               # API 契約(architect)
   │  └─ env.ts               # バインディング・vars の型、D1 に保存する認証情報の形式(architect)
   ├─ lib/                    # backend
   │  ├─ config.ts            # D1 の判定、SetupWarning、Features の判定、RCON の接続先の検証
   │  ├─ keys.ts              # instance_key の取得と HKDF による鍵の派生
   │  ├─ session.ts           # Cookie の発行・検証
   │  ├─ password.ts          # PBKDF2 によるハッシュ化・検証(定数時間比較)
   │  ├─ admins.ts            # 管理者の有無・取得・初期設定での登録(名前は backend が決めてよい)
   │  ├─ throttle.ts          # ログイン失敗のレート制限(D1)
   │  ├─ csrf.ts              # Origin / Sec-Fetch-Site 検査
   │  ├─ http.ts              # JSON 応答・エラー整形・本文の読み取り
   │  ├─ runtime.ts           # env・waitUntil など Worker ランタイムの取得
   │  ├─ auth.ts              # ログイン・ログアウトの処理(password / throttle / session / audit をまとめる)
   │  ├─ reads.ts             # 読み取り API の共通処理(RCON 呼び出し → 正規化 → 応答)
   │  ├─ actions.ts           # 書き込み操作の prepare / execute(検証、確認トークン、監査ログ、RCON 呼び出し)
   │  ├─ validate.ts          # 入力検証(Steam ID、文字数)
   │  ├─ confirm.ts           # 確認トークン
   │  ├─ audit.ts             # 監査ログ
   │  ├─ snapshots.ts         # 人数スナップショット
   │  ├─ servers.ts           # サーバーの検証・暗号化・CRUD・解決・接続テスト(第 15 章)
   │  └─ rcon/
   │     ├─ client.ts         # fetch、タイムアウト、エラー分類
   │     ├─ routes.ts         # 本パネルが使う RCON ルートの一覧(API.md 6 章)
   │     ├─ capabilities.ts   # /v1/capabilities の取得・解釈・キャッシュ
   │     └─ normalize.ts      # RCON 応答の正規化
   ├─ pages/                  # frontend-pages(API は backend)
   │  ├─ index.astro          # 状態
   │  ├─ players.astro / bans.astro / audit.astro / servers.astro / killfeed.astro(準備中。9.6)
   │  ├─ login.astro          # GET 表示 / POST 認証
   │  ├─ logout.ts            # POST のみ
   │  ├─ setup.astro          # 初期設定(管理パスワードの登録)/ D1 の不備の案内。GET 表示 / POST 登録
   │  └─ api/
   │     ├─ session.ts / status.ts / players.ts / bans.ts / maps.ts / capabilities.ts / audit.ts
   │     ├─ servers/index.ts(GET・POST)/ servers/[id].ts(PUT・DELETE)/ servers/[id]/test.ts(POST)
   │     └─ actions/prepare.ts / actions/execute.ts
   ├─ components/             # React アイランド(frontend-pages)
   └─ layouts/
```

### 3.1 担当の分担

- backend: `src/lib/*`、`src/middleware.ts`、`src/pages/api/*`、`src/pages/login.astro` と `src/pages/setup.astro` の POST 処理、`src/pages/logout.ts`。契約は `docs/API.md` と `src/types/*`。
- frontend-pages: 画面(9 章)、確認ダイアログ(4.3 / 7.3)、自動更新(9 章)、カタログへの文言の追加(13 章)。エラー表示は `code` でカタログを引き、`rconMessage` は補足としてそのまま出す。
- 契約(`src/types/*`、`src/i18n/index.ts` の関数の形、`db/*`、`wrangler.jsonc`、`docs/API.md`)の変更は architect 経由。

Worker 内のランタイム値は `import { env } from 'cloudflare:workers'`(参考実装と同じ)で取る。`src/env.d.ts` で `Cloudflare.Env` に `OpsEnv` を結び付けてあり、`env.DB` 等は型付きで参照できる(`tsc` で確認済み)。

## 4. データフロー

### 4.1 ログイン

```
GET /login ── フォーム(パスワード、操作者名[任意])。D1 の不備・管理者の未登録なら /setup へ 303(middleware)
POST /login(application/x-www-form-urlencoded)
  1. D1 の判定・管理者の登録の有無(middleware。5.1.1)。不備・未登録なら /setup へ 303
  2. Origin 検査(5.5)。不一致は 403
  3. 接続元キー = HMAC(ip-hash 鍵, CF-Connecting-IP)の先頭 16 桁(IPv6 は /64 に丸めてから)
  4. login_throttle を加算・判定。ロック中ならパスワードを評価せずにエラー表示(残り分数)
  5. admins(id 最小の行)の password_hash で PBKDF2 検証(5.2)。失敗 → 約 300 ms 待ってからエラー表示
  6. 成功 → 接続元キーの失敗回数を消去、反復回数が古ければハッシュを保存し直す(5.2)、
     Cookie 発行(admins.id と session_stamp に結び付ける。5.3)、audit_log に login を記録、古い行の掃除(8.4)
  7. 303 で / へ
```

### 4.2 読み取り(ポーリング)

```
React アイランド ──(30 秒ごと。タブが非表示の間は止める)── GET /api/status など
Worker: Cookie 検証 → RCON GET /v1/status(タイムアウト 5 秒)→ 正規化 → JSON
        └ /api/status のときだけ、成功したら server_snapshots に INSERT OR IGNORE(waitUntil で応答後に実行。4.4)
```

- 1 画面が叩く API は原則 1 本(状態画面は `/api/status`、プレイヤー画面は `/api/players`)に、サイドバーの `/api/status`(9.3。状態画面ではメインと共有して 1 本)を加える。1 リクエスト = RCON 1 回 + D1 0〜1 回で、サブリクエスト 50・同時接続 6 の上限に十分収まる。
- capabilities は画面表示時に `/api/capabilities` を 1 回取る(Worker 側で 10 分キャッシュ)。
- 応答は `Cache-Control: no-store`。Worker 側で RCON の結果はキャッシュしない(複数タブの同時更新でも RCON 側の上限 600/分〔R-13〕に遠い)。

### 4.3 書き込み(二段階)

```
1. 画面で操作を選ぶ(例: プレイヤー行の kick)
2. POST /api/actions/prepare { server, action, params }(server は対象サーバー。15.5)
   Worker: 入力検証 → capability 確認 → 対象の名前解決(RCON GET /v1/players、unban は監査ログ)
           → 正規化済み params・対象名・確認トークン(署名付き、120 秒、1 回限り)を返す(文言は返さない)
3. 画面: Worker が返した正規化済み params と対象名を、カタログの `confirm.<action>` で確認ダイアログの文にして表示。destructive なら強調し、ban / match_end は
   表示中の対象名(または「試合終了」)を再入力させる等の追加確認を frontend-pages が設計する
4. POST /api/actions/execute { action, params, confirmToken }
   Worker: トークン検証(署名・期限・セッション一致・action と params のハッシュ一致・対象サーバーと宛先の一致〔15.6〕)
           → audit_log に status=pending で INSERT(confirm_nonce は UNIQUE。重複は ALREADY_EXECUTED)
           → RCON の書き込みルートを 1 回だけ呼ぶ(再試行しない。タイムアウト 8 秒)
           → audit_log を succeeded / failed に UPDATE → 結果を返す
```

記録の範囲(2026-10-15 QA M-2 を受けた決定): execute のトークン検証失敗(`CONFIRM_INVALID` / `CONFIRM_EXPIRED`)と prepare の `CAPABILITY_MISSING` も `audit_log` に 1 行(`status=failed`、`error_code` 付き、`confirm_nonce` なし)残す。入力検証の失敗(400)と、D1 が使えないときにしか起きない `WRITES_DISABLED` は記録しない(後者は Workers Logs に操作種別・コード・sessionTag のみ出す)。ログイン失敗は `audit_log` に書かず、5.6 の `login_throttle` と `LOGIN_FAILURES_HIGH` 警告に任せる(D1 書き込み枠の節約)。

画面側(2026-10-15 QA M-1): execute の応答を受け取れなかった場合(`NETWORK` / `INTERNAL_ERROR` / `RCON_TIMEOUT`)は RCON 側で実行済みの可能性があるため「結果不明」と表示し、再実行ボタンは出さず操作ログで確認させる(新しい prepare は新しい nonce になり、二重実行を防げないため)。

**確認方式の決定: サーバー発行の確認トークンによる二段階(prepare → execute)**。根拠:

1. 確認ダイアログに出す内容(対象プレイヤー名・正規化済みの操作内容)を Worker が RCON の現在値から決めて返すので、「画面で見た内容」と「実行される内容」を params のハッシュで結び付けられる。クライアントだけの `confirm()` では保証できない。
2. 書き込みが必ず 2 回の意図的なリクエストになり、1 回の誤クリック・二重送信・リプレイでは実行されない(nonce の UNIQUE 制約で 1 回限り)。
3. 監査ログの行を「実行前に pending で作る」ため、RCON 呼び出し中に Worker が落ちても「実行しようとした記録」が残る(pending のまま 1 分以上の行は「結果不明」と表示)。
4. 状態を持たない署名トークンなので KV 等の追加リソースが要らない。1 回限りの保証は D1 の UNIQUE 制約で得る。

### 4.4 人数スナップショット

**決定: 読み取り時の間引き(Cron は使わない)**。`/api/status` が RCON から状態を取れたとき、`(server_id, bucket = floor(unix秒 / 300))` を主キーに `server_snapshots` へ `INSERT OR IGNORE` する。サーバーごとに 5 分に最大 1 行、誰かがパネルでそのサーバーを開いている間だけ記録される(複数サーバー対応で `status_snapshots` から切り替え。15.2)。

許容する副作用: `GET /api/status` は 5 分に最大 1 行を `INSERT OR IGNORE` で書く。冪等で、クロスサイトからは Cookie が付かないため悪用できない(2026-10-15 QA S-9)。

根拠: (1) Cron を Astro の Worker に同居させるにはカスタムエントリが必要で、`@astrojs/cloudflare@14` の公式ガイドに記載が無い(`./handler` の export は存在するが組み合わせは未検証、C-10)。(2) Cron はアカウントあたり 5 個までで、テンプレート利用者の既存 Worker と枠を取り合う。(3) 人数履歴グラフは PLAN で後回し。常時記録が必要になったら第 2 段階で Cron 化する(12 章)。

## 5. 認証の詳細

**決定(2026-10-16 ユーザー要望「ADMIN_PASSWORD や RCON_PASSWORD も DB に保存するようにしてほしい」): Worker Secrets を使わない**。管理パスワードは初回アクセス時の `/setup` で登録して D1 `admins` に PBKDF2 のハッシュで保存し、鍵はすべて D1 `settings` の `instance_key`(ランダム 32 バイト)から HKDF で派生する。RCON の接続先とパスワードは D1 `servers`(第 15 章)。

廃止したもの: Secrets `ADMIN_PASSWORD` / `RCON_URL` / `RCON_PASSWORD` / `SESSION_SECRET`(設定されていても読まない)、Secrets による既定サーバー(15.4)、暗号鍵の 2 系統(`s` / `a`)と自動再暗号化(15.3)、D1 が無くても動く段階(7.4)、`ADMIN_PASSWORD` との HMAC 比較(5.2)。

### 5.1 初期設定と鍵

#### 5.1.1 初期設定(`/setup`)

| 状態 | `/setup` | その他のページ(`/login` を含む) | `/api/*` |
|---|---|---|---|
| D1 が無い・マイグレーション未適用(7.4) | D1 の不備の案内だけ(フォームは出さない) | `/setup` へ 303 | 503 `NOT_CONFIGURED` |
| 管理者が未登録(`admins` が 0 行) | 管理パスワードの登録フォーム(9.1) | `/setup` へ 303 | 503 `SETUP_REQUIRED` |
| 登録済み | GET は `/login` へ 303(ログイン済みなら `/`)。POST は 409 `SETUP_ALREADY_DONE` | 通常 | 通常 |

登録の処理(`POST /setup`、`application/x-www-form-urlencoded`):

1. Origin 検査(5.5。`/setup` も対象)。
2. 入力検証: `password` が 16〜256 文字(コードポイント。`PASSWORD_TOO_SHORT` / `PASSWORD_TOO_LONG`)、`passwordConfirm` と完全一致(`PASSWORD_MISMATCH`)。前後の空白は除かない(入力どおりに扱う)。**登録サーバーの RCON パスワードとの同一判定は初期設定では行わない**(未認証者への情報漏えい防止。管理者 0 件・サーバー登録ありの間〔登録し直しの最中〕に判定すると、未認証者に「入力値が保存済みの RCON パスワードと同じか」を教えてしまうため。QA 2026-10-16 setup M-3)。同一値の拒否はログイン後のサーバー保存時(5.2 の `same_as_admin_password`)だけで行う。`PASSWORD_SAME_AS_RCON` は契約に残るが、現在は返さない。
3. `instance_key` を用意する(5.1.2。無ければ作る)。
4. ハッシュを計算し(5.2)、**条件付きの 1 文**で登録する:

   ```sql
   INSERT INTO admins (password_hash, session_stamp, created_at, updated_at)
   SELECT ?1, ?2, ?3, ?3 WHERE NOT EXISTS (SELECT 1 FROM admins)
   ```

   変更行数(`meta.changes`)が 0 なら、先に誰かが登録した(並行登録・二重送信)→ 409 `SETUP_ALREADY_DONE`。SQLite の 1 文は原子的で、D1 は 1 つのデータベースへの書き込みを直列に実行するため、並行した 2 つの登録が両方成功することは無い。UNIQUE 制約(例 固定値の列)を足す案は、将来の複数管理者と両立しないため採らない。
5. 成功したら `settings_audit_log` に `admin_register`(`ip_hash` 付き。`params` は `{}`)を記録し、`/login?registered=1` へ 303。記録は登録と同じトランザクションにしない(記録に失敗しても登録は取り消さない。Workers Logs にコードだけ出す)。**自動ログインはしない**(ログインの経路を 1 つにし、レート制限・監査ログを必ず通すため)。

初期設定の乗っ取り(第三者に先に登録される)への備え:

- 登録できるのは `admins` が 0 行のときだけ。登録後は `/setup` からは何もできない。
- デプロイ直後から登録までの間は、URL を知る人なら誰でも登録できる(workers.dev の URL は Worker 名とアカウントのサブドメインから推測され得る)。README 0 章で「デプロイしたらすぐ開いて登録する」「登録画面ではなくログイン画面が出たら、自分以外が登録した可能性があるので `admins` の行を消して登録し直す」と案内する。
- 登録には `admin_register` の記録が残る(操作ログの「設定変更」タブ。接続元はハッシュ)。
- 不採用案: デプロイ時に登録用のワンタイムコードを発行して Workers Logs やビルドログに出す → 非エンジニアには手順が重く、「Cloudflare 側の操作を最小にする」方針と合わないため採らない(受け入れるリスクは 12 章)。

#### 5.1.2 instance_key と鍵の派生

- `instance_key`: `crypto.getRandomValues` で 32 バイト(`INSTANCE_KEY_BYTES`)を作り、base64url で D1 `settings`(`key = 'instance_key'`)に保存する。**必要になった時点で `INSERT OR IGNORE` → `SELECT` で取得する**(並行しても最初に入った 1 つだけが使われる)。通常は初期設定のときに作られる。
- 一度作ったら変えない。**管理パスワードとは独立**しているので、管理パスワードを変えても(登録し直しても)鍵は変わらず、登録サーバーの RCON パスワードはそのまま読める(15.3)。
- isolate 内で 5 分キャッシュする(毎リクエストの D1 読み取りを避ける)。
- どの API・ページ・ログにも値を出さない。将来 `settings` を画面から編集できるようにしても、`instance_key` は返さない・変更させない(扱うキーは `SETTINGS_KEYS` で列挙する)。
- 行を手で消すと新しい `instance_key` が作られ、全員ログアウト・登録サーバーのパスワードは「再入力が必要」(15.3)になる。README で「消さない」と案内する。キャッシュのため、消した直後の最大 5 分は isolate ごとに新旧の鍵が混在し得る(手作業の誤操作時だけの問題として受け入れる)。

| 用途 | 鍵 |
|---|---|
| Cookie 署名(HMAC-SHA256) | `HKDF-SHA256(ikm = instance_key の 32 バイト, salt = "wardogs-ops/v1", info = "session")` |
| 確認トークン署名(HMAC-SHA256) | 同 `info = "confirm"` |
| 接続元 IP のハッシュ(HMAC-SHA256) | 同 `info = "ip-hash"` |
| 登録サーバーの RCON パスワードの暗号化(AES-256-GCM) | 同 `info = "server-password"`(15.3) |

派生した鍵はすべて `extractable: false`。旧方式の `password-compare` 鍵は廃止(5.2)。

### 5.2 パスワードの保存と検証

| 項目 | 決定 |
|---|---|
| 方式 | PBKDF2-HMAC-SHA256(Web Crypto の `deriveBits`)。導出値 32 バイト |
| salt | 16 バイトの乱数。登録・保存し直しのたびに新しく作る |
| 反復回数 | **10,000 回**(`PASSWORD_HASH_ITERATIONS`)。根拠は下記 |
| 保存形式 | `pbkdf2-sha256$<反復回数>$<salt>$<導出値>`(salt・導出値は base64url、パディング無し)。回数を値に含めるので、後から回数を変えても既存のハッシュを検証できる |
| 保存しないもの | 平文、HMAC 比較用の値、パスワードの長さ |
| 比較 | 入力から同じ salt・回数で導出し、32 バイト同士を定数時間で比較(`timingSafeEqualBytes`。Workers では `crypto.subtle.timingSafeEqual`) |
| 入力 | 256 文字(コードポイント)を超えた分は評価しない(登録時に 256 文字超を拒否するので、登録したパスワードは常に全体が評価される)。正規化(NFC 等)・前後の空白の除去はしない |
| 保存値の破損 | 形式不正・反復回数が 1,000〜100,000 の外 → 検証失敗として扱う(ログインできない。Workers Logs にはコード `PASSWORD_HASH_INVALID` だけ出す)。復旧は README 6 章の「登録し直し」 |
| 回数の引き上げ | ログイン成功時に、保存値の回数が現在の `PASSWORD_HASH_ITERATIONS` と違えば、新しい salt・回数で計算し直して `UPDATE admins SET password_hash = ?, updated_at = ? WHERE id = ? AND password_hash = <旧値>` する(`session_stamp` は変えない = ログイン中の人を追い出さない)。その 1 回のログインは旧回数 + 新回数分の CPU を使う |

反復回数の根拠(実測 2026-10-16、AMD Ryzen 9 5950X、パスワード 24 文字・salt 16 バイト・導出 32 バイト):

| 環境 | 1 万回 | 2.5 万回 | 5 万回 | 10 万回 |
|---|---|---|---|---|
| Node 24.15 の `crypto.subtle`(7 回の中央値) | 1.6 ms | 3.9 ms | 7.5 ms | 15.5 ms |
| ローカルの workerd(`wrangler dev` 4.151、5 回) | 約 4.4 ms(10 万回からの比例) | − | 21〜24 ms | 43〜51 ms |

1. 無料プランの Worker は CPU 時間が 10 ms/リクエスト。workerd の PBKDF2 は同じ機械の Node より約 3 倍遅く、目安だった 10 万回(約 44 ms)では上限を大きく超える。超えるとログインそのものができなくなる(Error 1102)ため、ログインの他の処理(HMAC、D1 の結果の処理、ページの描画)を含めて余裕を残せる 1 万回(約 4.4 ms)にした。
2. この設計で PBKDF2 が守るのは「D1 の中身が漏れたときに、管理パスワードの平文(他サービスでの使い回し)を知られにくくする」ことだけ。D1 を読める相手は `instance_key` も読めるので、パネル自体(Cookie の偽造、RCON パスワードの復号)は反復回数に関係なく守れない(12 章)。したがって回数より、16 文字以上の強制とランダム生成の推奨の方が効く。ランダムな英数字 16 文字(約 95 bit)なら、1 万回でもオフラインの総当たりは現実的でない。
3. 本番の Workers での CPU 時間は未実測(C-20)。Workers Logs の CPU 時間で確認し、余裕があれば値を上げる(上の「回数の引き上げ」で既存のハッシュも次のログインで移る)。Workers の PBKDF2 は 100,000 回を超える値を受け付けないとされる(ローカルの workerd では 100,001 回も通った。本番は未確認。C-20)ため、検証で受け付ける上限も 100,000 にしてある。

強度要件(Worker で強制):

- 管理パスワードは **16 文字以上・256 文字以下**(`ADMIN_PASSWORD_MIN_LENGTH` / `ADMIN_PASSWORD_MAX_LENGTH`)。README ではランダム 24 文字以上の生成手順を案内する。
- **管理パスワードと RCON パスワードは別の値**(旧 `ADMIN_PASSWORD_EQUALS_RCON_PASSWORD` の置き換え。警告ではなく、入力した時点で拒否する):
  - サーバーの追加・RCON パスワードの変更時: 入力した RCON パスワードを管理者のハッシュで検証し、一致したら `same_as_admin_password`(PBKDF2 1 回分の CPU。保存操作のときだけ)。管理者が複数行ある場合は全行と比べる。
  - 初期設定(登録し直し)時: 判定しない(5.1.1。未認証者への情報漏えい防止。QA 2026-10-16 setup M-3)。
- RCON パスワードは Worker から強制できないため、24 文字未満なら一覧で警告のみ(`passwordShort`)。README の推奨はランダム 32 文字以上。

### 5.3 Cookie の形式と有効期限

- 名前: `__Host-wo_session`(`Secure; HttpOnly; SameSite=Strict; Path=/`、Domain 属性なし)。開発時(`import.meta.env.DEV`)は `wo_session`、`Secure` なし(http://127.0.0.1 で `__Host-` が使えない場合に備える。C-14)。
- 値: `v2.<aid>.<sid>.<iat>.<exp>.<op>.<sig>`
  - `aid`: 管理者の `admins.id`(10 進)
  - `sid`: 16 バイト乱数の base64url(セッション ID。監査ログには先頭 8 文字の `sessionTag` だけ残す)
  - `iat` / `exp`: UTC epoch ミリ秒(10 進)。`exp = iat + 12 時間`
  - `op`: 操作者名(任意、最大 32 文字)の UTF-8 を base64url。空可
  - `sig`: `HMAC-SHA256(session 鍵, "v2.<aid>.<sid>.<iat>.<exp>.<op>." + <その管理者の session_stamp>)` の base64url。比較は定数時間
- 検証: 署名を確かめる前に `admins` から `aid` の行を主キーで読む(**キャッシュしない**)。行が無い(削除・登録し直し)・`session_stamp` が違う → 未ログイン扱い。鍵が管理パスワードから独立したため、旧方式の「ADMIN_PASSWORD を変えると全セッションが失効」を `session_stamp` で置き換える。`admins` の行を消して登録し直すと(新しい `id` と `session_stamp` になる)、その時点で既存の Cookie はすべて通らない。
- `v1` の Cookie(旧方式)は形式不正として扱う(鍵も違うので通らない)。
- 有効期限: **絶対 12 時間、延長しない**(Cookie の再発行 = 書き込みが毎リクエスト発生しない)。`Max-Age` も同じ値にする。
- 操作者名は自己申告で、なりすましは防げない(パスワード共有型の限界)。監査ログには sessionTag と ip_hash も併記して追跡の手掛かりにする。

### 5.4 ログアウト・全セッションの失効・パスワードを忘れたとき

- ログアウト: `POST /logout`(Origin 検査あり)で Cookie を消し、audit_log に logout を記録する。署名 Cookie は状態を持たないため、ログアウト前に Cookie を盗まれた場合は期限まで有効(12 時間)。
- 全セッションの強制失効: 現状は `admins` の行を削除して `/setup` で登録し直す(下記)。管理パスワードの変更画面と「全端末からログアウト」ボタンは第 2 段階(作るときは `session_stamp` を作り直し、`settings_audit_log` に `admin_password_change` を記録する。8.6)。
- **パスワードを忘れた・乗っ取られた**: Cloudflare ダッシュボード → Storage & Databases → D1 → `wardogs-ops-db` で `admins` の行を削除 → パネルの URL を開き `/setup` で登録し直す(README 6 章。ダッシュボードの操作手順の確定は C-21)。`instance_key`・登録サーバー・操作ログは残る。乗っ取りが疑われる場合は、登録サーバーの RCON パスワードもゲーム側と画面の両方で変える(相手は画面から RCON を操作できたため。保存済みのパスワードは画面に出ず、宛先の書き換えによる持ち出しは 15.6 で防いでいるが、念のため)。
- 行を削除してから登録し直すまでの間は、5.1.1 の「乗っ取り」と同じ状態になる(誰でも登録できる)。README で「削除したらすぐ登録する」と案内する。

### 5.5 CSRF 対策

- Cookie は `SameSite=Strict`(他サイトからのリクエストに付かない)。
- GET / HEAD 以外のすべて(`/setup`、`/login`、`/logout`、`/api/*`)で検査する:
  1. `Origin` があれば `new URL(request.url).origin` と完全一致を要求
  2. `Origin` が無い、または `null` なら `Sec-Fetch-Site: same-origin` を要求(Chrome は `Referrer-Policy: no-referrer` や sandbox 下のフォーム送信で `Origin: null` を送る。`Sec-Fetch-Site` は forbidden header でスクリプトから偽装できない。2026-10-15 のブラウザ確認で発見し修正)
  3. どちらも無ければ拒否(403 `FORBIDDEN_ORIGIN`。ページは 403 の簡易 HTML)
- `/setup` に掛ける理由: 他サイトに仕込んだフォームから、運営者のブラウザ経由で攻撃者のパスワードを登録させる(登録前の短い時間を狙う)ことを防ぐ。
- `/api/*` の POST は `Content-Type: application/json` を必須(他サイトの単純フォームからは送れない)。
- Astro 標準の origin 検査(`security.checkOrigin`)は**無効化**し、上記の middleware の検査に一本化する。標準検査はフォーム形式の POST だけが対象で JSON 等は見ず、middleware より先に本文を読まずに 403(セキュリティヘッダ無し)を返し、開発サーバーでは直後の同一接続のリクエストが 500 になるため(`docs/API_TEST.md` 4 章。本番は C-19)。middleware の検査は GET / HEAD 以外の全リクエストが対象で、拒否前に本文を読み捨てる。
- 許可オリジンを設定値で持たない(workers.dev でもカスタムドメインでも、リクエスト自身のオリジンと比較する)。

### 5.6 ログイン失敗のレート制限

**決定: D1 の `login_throttle` テーブル(固定窓)**。KV は書き込み 1,000/日で、総当たりを受けると枠を使い切って制限自体が働かなくなる。D1 は書き込み 10 万行/日で余裕があり、監査ログと同じデータベースなので自動プロビジョニングの対象も増えない。Rate Limiting バインディングは無料プランでの可否が未確認(`cloudflare-free-tier.md` 要確認 2)で、精度も「eventually consistent」のため採らない。D1 必須化(2026-10-16)により、D1 が無い場合のメモリ近似は廃止した。

| 規則 | 値 |
|---|---|
| 接続元ごと(`ip:<HMAC 先頭 16 桁>`。IPv6 は /64) | 15 分の窓で失敗 5 回 → その窓の終わりまでロック |
| ロック中 | パスワードを評価しない(PBKDF2 の CPU も使わない)。失敗回数も増やさない(書き込みを増やさない) |
| 全体(`global`) | 失敗回数を数えるだけ。1 時間に 200 回を超えたらその時間は D1 に書かずメモリで近似する(D1 書き込み枠の保護。最悪 9,600 行/日)。1 時間に 50 回を超えたら画面上部に警告(`SetupWarning` の `LOGIN_FAILURES_HIGH`、`/api/session` の `warnings`)。**全体ロックはしない**(第三者が運営者を締め出せてしまうため。総当たりへの備えは 16 文字以上のパスワードで行う) |
| 判定の順序 | 評価の前に試行回数を UPSERT で加算(`RETURNING`)し、上限超なら拒否、成功時に行を削除する(並行リクエストで回避されないよう原子的に。2026-10-15 QA M-3) |
| 失敗時の待ち | 約 300 ms(応答を遅らせる。Workers の CPU 時間には数えられない) |
| `/setup` | レート制限しない(登録は 0 行のときの 1 回だけで、総当たりの対象が無いため) |

### 5.7 その他のヘッダ・保護

- 全応答: `X-Frame-Options: DENY`、`Content-Security-Policy` に少なくとも `frame-ancestors 'none'; base-uri 'none'; form-action 'self'`、`Referrer-Policy: same-origin`(`no-referrer` だと同一オリジンのフォーム送信で `Origin: null` になり CSRF 検査に落ちる)、`X-Content-Type-Options: nosniff`、`X-Robots-Tag: noindex, nofollow`。HTML と API は `Cache-Control: no-store`。`script-src` を絞るかは Astro のアイランド用インラインスクリプトとの両立を確認してから決める(C-15)。
- 未ログインのページ要求は `/login` へ 303、API は 401 `UNAUTHENTICATED`。
- D1 の不備・管理者の未登録は 5.1.1 の表のとおり(ページは `/setup` へ 303、API は 503 `NOT_CONFIGURED` / `SETUP_REQUIRED`)。middleware の順序は「D1 の判定 → CSRF → 管理者の登録の有無 → ログイン Cookie → ヘッダ」。
- `/setup` は未ログインでも見られる。出すのは D1 の不備の種類(`D1_MISSING` / `D1_NOT_MIGRATED`)か登録フォームだけ。登録済みなら何も出さずに `/login` へ。
- ログ(`console.*`、Workers Logs)に出してよいのは、ルート名・HTTP ステータス・所要時間・エラーコードのみ。管理パスワード・RCON パスワード(平文・暗号文)・パスワードのハッシュ・`instance_key`・派生した鍵・Cookie・`Authorization`・RCON の接続先・生の IP・プレイヤーのメッセージ本文は出さない。

## 6. RCON 呼び出し

### 6.1 接続先の検証(ホスト名・ポート)

画面から登録するサーバーの「ホスト名 + ポート」(15.2)を `http://<ホスト名>:<ポート>` に組み立て、`parseRconUrl` で次の規則を確かめる(Secrets の `RCON_URL` は 2026-10-16 に廃止。下の `RCON_URL_*` は `parseRconUrl` の内部の判定値で、`SetupWarning` からは削除した)。

- `new URL()` で解釈できること。`protocol` は `http:` または `https:`(https は R-3 / R-5 次第。現状の非公式資料では平文 HTTP のみ)。
- ユーザー名・パスワードを含まないこと(`RCON_URL_HAS_CREDENTIALS`)。
- ホスト名が IPv4 / IPv6 リテラルでないこと(`RCON_URL_IS_IP_ADDRESS`)。Workers の fetch は IP アドレス直指定ができない(Cloudflare 公式 known-issues)。README に回避手順(自前ドメインの A レコード〔DNS only〕等)を書く。
- パスの末尾の `/` を除き、その後ろに `/v1/...` を付ける(パス接頭辞は許す。将来 TLS 終端プロキシの下に置く場合のため)。
- 検証に失敗しても値そのものは画面・ログに出さない。

### 6.2 fetch の方針

| 項目 | 値 |
|---|---|
| ヘッダ | `Authorization: Bearer <そのサーバーの RCON パスワード>`、`Accept: application/json`、本文がある場合は `Content-Type: application/json` |
| リダイレクト | `redirect: 'manual'`。3xx は `RCON_BAD_RESPONSE`(Bearer を別の宛先に送らない) |
| タイムアウト | 読み取り 5 秒、書き込み 8 秒(`AbortSignal.timeout`)。超過は `RCON_TIMEOUT` |
| 再試行 | しない(読み取りは次のポーリングで回復。書き込みは二重実行を避ける) |
| 応答サイズ | 512 KiB まで読む。超過は `RCON_BAD_RESPONSE` |
| キャッシュ | `cache: 'no-store'` |

### 6.3 エラーの整形

| RCON 側の結果 | API のエラーコード | 画面での意味 |
|---|---|---|
| DNS 失敗・接続拒否・TLS 失敗などの例外 | `RCON_UNREACHABLE` | 接続先に届かない(URL、ポート開放、DNS only を確認) |
| タイムアウト | `RCON_TIMEOUT` | 応答が遅い |
| 401 / 403 | `RCON_AUTH_FAILED` | RCON パスワード不一致、または AllowedHosts で拒否(区別できるかは R-15) |
| 404 | `RCON_ROUTE_NOT_FOUND` | このビルドにルートが無い。capabilities のキャッシュを破棄する |
| 429 | `RCON_RATE_LIMITED`(`Retry-After` を秒で `retryAfterSec` に) | RCON 側の上限 |
| 400 / 409 / 422 等その他 4xx | `RCON_REJECTED`(本文の `error`/`message` 文字列を 200 文字に切り詰め、制御文字を除いて `rconMessage` に) | 例: 対象がオフライン |
| 5xx | `RCON_ERROR` | サーバー内部エラー |
| JSON として解釈できない 2xx(読み取り) | `RCON_BAD_RESPONSE` | 形式が想定外 |
| 2xx(書き込み。本文が JSON でなくても・空でも) | 成功 | 書き込みの成否は HTTP ステータスで判断し、本文は解釈しない(実行済みの kick 等を失敗と記録しないため)。監査ログには `rcon_status` を残す |

エラー本文の形式は未検証(R-14)。書き込みの 2xx の本文形式も未検証のため、成功判定に本文を使わない(R-18)。`rconMessage` は JSON の文字列フィールドからだけ取り、HTML 等はそのまま返さない。

### 6.4 capabilities によるルート判定

- `GET /v1/capabilities` を Worker の isolate 内で 10 分キャッシュ(`RCON_ROUTE_NOT_FOUND` を受けたら即破棄)。KV / D1 には保存しない。キャッシュはサーバーごと(キー `${serverId}|${baseUrl}`。15.6)。
- `routes[]` の要素形式は未検証(R-1)。文字列(`"POST /v1/broadcast"` 等)と `{ method, path }` 形式の両方を受け付け、`"METHOD /path"` に正規化する。パスのパラメータ部(`{steamId}`、`:steamId` 等)は名前を無視して照合する。
- 判定(`CapabilityState`):
  - `available`: 該当ルートがある
  - `missing`: capabilities は解釈できたがルートが無い → **画面のボタンを無効化**し、prepare も `CAPABILITY_MISSING` で拒否
  - `unknown`: capabilities 自体が取れない(404・形式不明)→ ボタンは有効のまま「未確認」と表示し、実行時のエラーで判断
- 2026-09-14 のビルドで書き込み系ルートが廃止され設定ドキュメント経由に移ったとの記載がある(R-2)。該当する場合、kick 等は `missing` になり操作できない。設定経由の代替(`PUT /v1/config`)は第 2 段階。

### 6.5 Steam ID の扱い

- 形式: SteamID64(10 進 17 桁、`STEAM_ID_PATTERN`)を前提に検証する。RCON がこの形式かは未検証(R-9)。合わない ID の行は表示だけして操作ボタンを無効にする(定数 1 か所の変更で直せるようにしてある)。
- 画面: ログイン済みの運営者には全桁を表示する(BAN 解除・外部照会に必要)。ログイン前の画面・/setup・エラー応答には出さない。
- 保存: audit_log の `target_steam_id` と操作時点の名前 `target_name` を残す(BAN 一覧で名前を補完するため)。保持期間 365 日(8.4)。server_snapshots には人数とマップだけでプレイヤー情報は入れない。
- ログ: `console.*` に Steam ID・プレイヤー名・メッセージ本文を出さない。
- URL のパスに埋めるときは検証済みの値を `encodeURIComponent` してから使う。

## 7. 書き込み操作の範囲と段階的有効化

### 7.1 当初許可する操作

kick / ban / unban / broadcast / message / map 変更 / 試合終了(`WRITE_ACTIONS`)。対応する RCON ルートは `docs/API.md` 6 章。kill・陣営変更・試合再開・ライティング・設定(`PUT /v1/config`)は第 2 段階以降。

### 7.2 入力の上限(Worker で強制)

| 項目 | 上限 | 備考 |
|---|---|---|
| broadcast / message | 256 文字(コードポイント)、改行と制御文字は不可、前後の空白を除いて 1 文字以上 | RCON の上限 256 は未検証(R-6) |
| kick / ban の理由 | 200 文字、任意 | RCON 側の上限は不明(R-10) |
| map | `^[A-Za-z0-9_./-]{1,128}$`。catalog が取れた場合はその id に含まれること | id 形式は未検証(R-11) |
| ban | prepare 時に接続中一覧にいること(いなければ `VALIDATION_FAILED`) | オンライン必須は未検証(R-7) |

### 7.3 影響の大きい操作

`destructive: true` は ban / map / match_end。画面は確認ダイアログを強調し、追加の確認(対象名の再入力や確認チェック)を必須にする。kick / message / broadcast / unban は通常の確認ダイアログ。

### 7.4 段階的有効化(D1 必須)

2026-10-16 の Worker Secrets 廃止で、管理者・鍵・サーバーがすべて D1 にあるため **D1 は必須**になった。旧「段階 1(D1 が無くても読み取り専用で動く)」と「段階 1'(`AUDIT_REQUIRED="false"` でログ無しの書き込み)」は廃止。

| 段階 | 条件 | 動作 |
|---|---|---|
| 0. D1 の不備 | `env.DB` が無い(`D1_MISSING`)、または最新のマイグレーションの表が無い(`D1_NOT_MIGRATED`) | `/setup` に案内だけを表示(フォームなし)。ほかのページは `/setup` へ、API は 503 `NOT_CONFIGURED`。ログイン不可 |
| 1. 初期設定前 | D1 は使えるが `admins` が 0 行 | `/setup` で管理パスワードを登録(5.1.1)。ほかのページは `/setup` へ、API は 503 `SETUP_REQUIRED` |
| 2. 通常 | 登録済み | 全機能。`features` はすべて true |

- D1 の可否は「`env.DB` があり、最新のマイグレーション(0002)で作った表・列をすべて参照する 1 文が成功する」で判定し(15.8)、isolate 内で 5 分キャッシュする。D1 の例外を受けたらキャッシュを破棄する。
- 管理者の有無は毎リクエスト判定する(ログイン Cookie があれば 5.3 の `admins` の読み取りで兼ねる。無ければ `SELECT 1 FROM admins LIMIT 1`)。キャッシュしない(行を消した直後から `/setup` に誘導するため)。
- `D1_NOT_MIGRATED` を残す理由: `deploy` は「`wrangler deploy` → マイグレーション」の順(C-5)で、新しいコードが新しいマイグレーションより一瞬先に動く。また方法 B で Deploy command を誤ると、マイグレーションが適用されないまま動く。
- 動作中に D1 の呼び出しが失敗した場合(障害)は、その API が 500 `INTERNAL_ERROR`(書き込み操作は RCON を呼ばない。監査ログの pending 行を作れないため)。
- vars `AUDIT_REQUIRED` は効果が無くなった(値を読まない)。削除はユーザー確認後(14 章 U-12)。

## 8. D1 スキーマ

正本は `db/migrations/`(`0001_init.sql`、`0002_servers.sql`)。`db/schema.sql` は全マイグレーション適用後の参照用のまとめ。時刻はすべて UTC epoch ミリ秒。**本番稼働後のマイグレーションは追加のみ**(表・列・インデックスの追加。表の作り直し・列の削除・CHECK の変更はしない。C-5 のとおり新しいコードがマイグレーションより一瞬先に動くため)。

**0002 の書き換え(2026-10-16)**: 0002 はどの本番にも未適用(作者の本番は 0001 のみ)で利用者もまだいないため、複数サーバー(servers 等)に管理者(`admins`)と設定(`settings`)を足して 1 本に書き換えた。ローカルで旧 0002 を適用済みの D1 は作り直す(README「開発者向け」)。本番に適用した後は 0002 を変更しない。

### 8.1 audit_log

| 列 | 型 | 内容 |
|---|---|---|
| id | INTEGER PK AUTOINCREMENT | |
| created_at / finished_at | INTEGER | 受付時刻 / RCON の結果確定時刻 |
| event | TEXT CHECK | `kick` `ban` `unban` `broadcast` `message` `map` `match_end` `login` `logout` |
| status | TEXT CHECK | `pending` `succeeded` `failed` |
| operator / session_tag / ip_hash | TEXT | 自己申告名 / セッション ID 先頭 8 文字 / IP の HMAC 先頭 16 桁(生 IP は保存しない) |
| target_steam_id / target_name | TEXT | 対象プレイヤー(該当する操作のみ) |
| params_json | TEXT | 検証済みパラメータ。表示文言は保存しない(画面が event + params + target_name から言語に応じて組み立てる。13 章) |
| rcon_route / rcon_status / error_code | TEXT / INTEGER / TEXT | 例 `POST /v1/broadcast`(ホストは含めない)/ HTTP ステータス / API エラーコード |
| confirm_nonce | TEXT UNIQUE | 確認トークンの nonce(1 回限りの保証) |
| server_id | INTEGER(0002) | 対象サーバー(`servers.id`)。書き込み操作で NULL = 対象不明(0002 以前の行)。login / logout は常に NULL |
| server_name | TEXT(0002) | 操作時点のサーバーの表示名 |

インデックス: `created_at`、`(target_steam_id, created_at)`、`(server_id, id)`(0002。サーバーでの絞り込み用)。

`event` の CHECK に新しい値は足せない(SQLite は CHECK を ALTER できず、作り直しはしない)。サーバー設定の変更・管理者の登録は 8.6 の別表に記録する。`login` の行の扱いは従来どおり(ログイン成功ごとに 1 行。ログイン失敗は書かない)。今後 RCON の書き込み操作を足す場合も同じ制約があるため、そのときに設計する(M-6)。

### 8.2 server_snapshots(0002)/ status_snapshots(0001、以後は書かない)

- `server_snapshots`: `server_id`(`servers.id`)、`bucket`(`floor(unix秒/300)`)、`taken_at`、`players_current`、`players_max`、`map`。主キー `(server_id, bucket)`、インデックス `taken_at`。`INSERT OR IGNORE` でサーバーごとに 5 分に 1 行。`server_id = 0` は旧「既定サーバー」用に予約していた値で、現在は使わない。
- `status_snapshots`: 0001 の表(`bucket` が主キー)。複数サーバーでは同じ 5 分枠に 2 台分を入れられないため 0002 以降は書かない。掃除(8.4)で自然に空になる。理由は 15.2。

### 8.3 login_throttle

`key`(PK、`ip:<hash>` または `global`)、`window_start`、`failures`。窓が過ぎた行は次の書き込み時に上書き(UPSERT)。

### 8.4 保持と掃除

ログイン成功時に次を実行する(Cron を使わないため):

- audit_log: 365 日より古い行を削除
- settings_audit_log: 365 日より古い行を削除(0002)
- status_snapshots / server_snapshots: 90 日より古い行を削除
- login_throttle: `window_start` が 1 日より古い行を削除
- servers / admins / settings: 掃除しない(運営者が削除するまで残す。`settings` の `instance_key` は消さない)

いずれも定数としてコードに持つ(vars にはしない。利用者の設定項目を増やさない)。

### 8.5 servers(0002)

画面から登録したサーバー。詳細は 15.2・15.3。

| 列 | 型 | 内容 |
|---|---|---|
| id | INTEGER PK AUTOINCREMENT | `ServerId` の数値部分。削除した id は再利用しない |
| name | TEXT NOT NULL(UNIQUE) | 表示名(1〜32 文字) |
| host / port | TEXT / INTEGER(CHECK 1〜65535) | ホスト名(小文字、IP 不可)/ ポート。`(scheme, host, port)` は UNIQUE |
| scheme | TEXT(CHECK `http` / `https`、既定 `http`) | 当面 `http` 固定(画面に出さない) |
| rcon_password_enc | TEXT NOT NULL | `v2.<iv>.<ct>`(AES-256-GCM。鍵は `instance_key` から派生。15.3)。平文は保存しない |
| enabled | INTEGER(0 / 1) | 無効にすると選択肢から外れ、API は `SERVER_DISABLED` |
| sort_order | INTEGER | 並び順(小さい順、同じなら id 順) |
| last_test_at / last_test_result | INTEGER / TEXT | 直近の接続テスト(`ok` または `RCON_*`) |
| created_at / updated_at | INTEGER | |

### 8.6 settings_audit_log(0002)

パネル設定の変更の記録。`id`、`created_at`、`event`(CHECK なし。コードの `SETTINGS_EVENTS` で検証)、`operator` / `session_tag` / `ip_hash`(audit_log と同じ)、`server_id`、`server_name`(その時点の表示名)、`params_json`。インデックス `created_at`。

| event | 記録する時点 | server_id / server_name | params_json | 書き方 |
|---|---|---|---|---|
| `server_add` / `server_update` / `server_delete` | サーバーの追加・変更・削除 | 対象サーバー | 変更内容(name / host / port / enabled と `passwordChanged` の真偽) | D1 の変更と同じ `db.batch()` |
| `server_update_rejected` / `server_delete_rejected` | PUT の `reenter_required` / DELETE の `confirmName` 不一致(15.2) | 対象サーバー | `{ reason, … }` | 拒否の応答とは独立に INSERT(記録の失敗で応答は変えない) |
| `server_test` | `POST /api/servers/:id/test`(15.6) | 対象サーバー | `{ result: 'ok' \| RCON_* }` | `last_test_*` の更新と同じ `db.batch()` |
| `admin_register` | `/setup` での管理パスワードの登録(5.1.1) | NULL | `{}` | 登録の成功後に別に INSERT(`operator` / `session_tag` は NULL、`ip_hash` は登録した接続元) |
| `admin_password_change`(予定) | 管理パスワードの変更画面を作るとき(第 2 段階) | NULL | `{}` | 変更と同じ `db.batch()`。型(`SETTINGS_EVENTS`)には実装時に足す |

**パスワード・ハッシュ・暗号文・鍵は入れない**。

### 8.7 admins(0002)

管理者(パネルにログインする人)。

| 列 | 型 | 内容 |
|---|---|---|
| id | INTEGER PK AUTOINCREMENT | ログイン Cookie の `aid`(5.3)。削除した id は再利用しない(登録し直すと古い Cookie が通らなくなる) |
| password_hash | TEXT NOT NULL | `pbkdf2-sha256$<反復回数>$<salt>$<導出値>`(5.2) |
| session_stamp | TEXT NOT NULL | 16 バイト乱数の base64url。Cookie の署名に混ぜる(5.3)。登録時に生成し、将来のパスワード変更・全端末ログアウトで作り直す |
| created_at / updated_at | INTEGER | |

- 登録は `admins` が 0 行のときだけ、条件付きの INSERT で行う(5.1.1)。したがって通常は 0 行か 1 行。
- 複数行を許す形にしてあるが、複数管理者は未実装。現状のログインは id が最小の行で検証する。複数管理者を作るときは、ログインフォームに名前欄を足し、`admins` に名前の列を追加(0003)して引く。
- パスワードを忘れた・乗っ取られたときは、ダッシュボードでこの表の行を削除して登録し直す(5.4)。

### 8.8 settings(0002)

`key`(TEXT PK)、`value`(TEXT)、`updated_at`。現状のキーは `instance_key` だけ(5.1.2。`SETTINGS_KEYS`)。

- 将来 vars(`LANGUAGE` / `TIMEZONE`)を画面の「設定」に移すときもこの表に置く(値は非機密)。API で返すときは返してよいキーを列挙し、`instance_key` を決して含めない。
- `instance_key` を別表にする案は採らない(表を増やさず、キーの列挙で十分に区別できるため)。

## 9. 画面一覧

2026-10-17 ユーザー決定: ログイン後の画面を「**左に固定サイドバー + 上にヘッダータブ + 中央にメイン**」の構成にする(参考: WARDOGS 向けの既存 RCON デスクトップアプリ)。ログイン前の画面(`/setup`、`/login`)は従来どおりサイドバー・タブの無い 1 カラム(`narrow`)。

### 9.0 ページとタブの一覧

| パス | タブ(`tabs.*`) | 内容 | アイランド | 自動更新 |
|---|---|---|---|---|
| `/setup` | − | 初期設定(管理パスワードの登録)、または D1 の不備の案内(9.1) | なし(フォーム POST) | − |
| `/login` | − | パスワード、操作者名(任意)。ロック中は残り時間。`?registered=1` のときは「登録しました。ログインしてください」 | なし(フォーム POST) | − |
| `/` | 概要(Overview) | 状態の詳細とよく使う操作(9.4) | あり | 30 秒(サイドバーと共有。9.3) |
| `/players` | プレイヤー(Players) | 接続中一覧と行ごとの操作(9.4) | あり | 30 秒 |
| `/bans` | BAN(Bans) | BAN 一覧と解除(9.4) | あり | 手動更新 |
| `/audit` | 操作ログ(Audit) | 「操作」「設定変更」の切り替え、サーバーでの絞り込み(9.4、15.7) | あり | 手動更新 |
| `/servers` | 設定(Settings) | サーバーの一覧・追加・編集・有効/無効・接続テスト・削除(15.7)。将来はアプリ設定も(9.4) | あり | 手動更新 |
| `/killfeed` | キルフィード(Killfeed) | **枠だけ**。「準備中」の説明のみ(9.6) | なし | − |

- パスは変えない(既存のブックマーク・README の案内を壊さないため)。タブ名と URL が一致しないのは `/`(概要)と `/servers`(設定)だけ。
- サイドバーは、ログイン後のすべてのページ(上表の `/` 以下)に出す。「手動更新」のページでも、サイドバーの状態は 30 秒ごとに更新される(9.3)。
- 共通の規則(従来から変えない): `/`、`/players`、`/bans` は選択中のサーバーを表示し、0 台・見つからない・使えないときは `ServerGate`(15.4 / 15.5)の案内を出してアイランドを描画しない。`warnings`(`/api/session`)はメインの上部に出す(`SessionNotices`)。capabilities が `missing` のボタンは無効化して理由を示し、`unknown` は「未確認」表示。自動更新は `document.visibilityState === 'hidden'` の間止め、`POLL_MIN_INTERVAL_SEC`(30 秒)より短くしない。

### 9.1 `/setup` の画面仕様

(節番号は他章・API.md から参照されているため 9.1 のまま残す)

状態ごとに出すもの(判定は 5.1.1):

| 状態 | 表示 |
|---|---|
| D1 の不備 | 見出し「設定の確認」、`setup.warning.D1_MISSING` または `setup.warning.D1_NOT_MIGRATED` の文言、README の該当箇所(6 章)への案内。フォームは出さない |
| 管理者が未登録 | 下記の登録フォーム |
| 登録済み | 画面は出さない(GET は `/login` へ 303。POST は 409 で `setup.error.SETUP_ALREADY_DONE` だけを表示し、`/login` へのリンク) |

登録フォーム(JS 無しで動く `<form method="post" action="/setup">`):

- 説明: 「このパネルにログインするための管理パスワードを決めます。最初に登録した人だけが使えます。デプロイしたらすぐ登録してください」の趣旨(文言は frontend-pages がカタログに足す)。
- 項目: `password`(`type="password"`、`autocomplete="new-password"`、`minlength=16`、`maxlength=256`、必須)、`passwordConfirm`(同じ属性。確認用)。操作者名は無い(ログイン時に入れる)。
- 補足: 16 文字以上・推奨ランダム 24 文字以上・RCON パスワードとは別の値にすること。README 1 章の作り方への案内。パスワード管理ソフトの利用を勧める。
- 送信ボタン: 「登録する」。二重送信を防ぐため送信中は押せなくしてよい(JS がある場合のみ。無くても 2 回目は `SETUP_ALREADY_DONE` になるだけ)。
- エラー時: 該当の HTTP ステータス(`SETUP_FORM_ERROR_STATUS`)でフォームを再表示し、`setup.error.<SetupFormError>` を出す(`PASSWORD_TOO_SHORT` は `{min}`、`PASSWORD_TOO_LONG` は `{max}` を埋める)。**入力したパスワードは再表示しない**(両欄とも空に戻す)。
- 成功時: `/login?registered=1` へ 303。

### 9.2 レイアウト(サイドバー / タブ / メイン)

`src/layouts/OpsLayout.astro` を、`ctx`(ログイン後)があるときだけ次の 3 領域で組む。`ctx` が無いときは従来のヘッダー + 1 カラム。

```
┌────────────────┬─────────────────────────────────────────────┐
│ サイドバー      │ ヘッダー: アプリ名                            │
│ (幅 288px、    ├─────────────────────────────────────────────┤
│  固定。中だけ   │ タブ: 概要 | プレイヤー | BAN | 操作ログ | 設定 | キルフィード(準備中) │
│  縦スクロール)  ├─────────────────────────────────────────────┤
│ 1 サーバー切替  │ お知らせ(SessionNotices)                      │
│   + 追加        │ メイン(<main id="main">。各ページの slot)     │
│ 2 サーバーカード│                                             │
│ 3 試合の要点    │                                             │
│ 4 縦ナビ        │                                             │
│ 5 操作者・期限・│                                             │
│   ログアウト    │                                             │
└────────────────┴─────────────────────────────────────────────┘
```

- HTML の順序は「スキップリンク → ヘッダー → サイドバー(`<aside aria-label={t('sidebar.label')}>`)→ タブ(`<nav aria-label={t('tabs.label')}>`)→ お知らせ → `<main>`」。スキップリンクは `<main>` へ飛ぶ(サイドバーを読み飛ばせる)。見た目の配置は CSS Grid の `grid-template-areas` で決める(HTML の順序を見た目に合わせて崩さない)。
- デスクトップ(幅 1024px 以上): 2 列(`288px minmax(0, 1fr)`)。サイドバーは `position: sticky; top: 0; height: 100dvh; overflow-y: auto`(メインと独立にスクロール)。
- **サイドバーの上から順に**(文言は 13.8 の `sidebar.*`):
  1. **サーバー切り替え**: 現在ヘッダーにあるセレクトをそのまま移す(15.5 の GET フォーム、JS があれば選択で即送信、現在のパスを保つ、選択肢の印〔無効・要パスワード再入力・設定に不備〕も従来どおり)。その下に「サーバーを追加」リンク(`/servers?server=<現在の id>#add`。`ServersPanel` は `location.hash === '#add'` のとき追加フォームを開いて最初の欄にフォーカスする)。0 台のときはセレクトを出さず「サーバーを追加」だけ。
  2. **サーバーカード**: 表示名(運営者が付けた名前)、ゲーム内サーバー名(`status.serverName`)、現在のマップ(`status.map`。表示名はメインの概要タブだけで引く)、人数(現在 / 最大)、ゲームモード(`status.experiences` を「・」区切りで。空なら行ごと出さない)、**ホスト名:ポート**(`ServerSummary.host` / `port`。等幅、長いホスト名は折り返す。2026-10-17 ユーザー判断で表示可)、接続状態(9.3 の表)。
  3. **試合の要点**: 陣営スコア(先頭 `SIDEBAR_FACTION_LIMIT` = 3 陣営。超える分は「ほか {n} 陣営」。陣営名は RCON の生データ)、次のマップ(`rotation.nextMapName ?? rotation.nextMap`)、ローテーション位置(`rotation.nowIndex` を 1 始まりにして「{now} / {count}」。count が無ければ「{now} 番目」)。値が無い項目は行ごと出さない。全部無ければブロックごと出さない。
  4. **縦ナビ**: 状態 / プレイヤー / BAN / 操作ログ / サーバー設定。**タブと同じ定義**(`src/layouts/nav.ts` の 1 つの配列)から作り、ラベルも同じキー(`tabs.*`)を使う(タブと縦ナビで呼び名が食い違わないように)。リンクには `?server=<現在の id>`(15.5)。キルフィードは縦ナビには出さない(準備中のため)。
  5. **最下部**(`margin-top: auto` で下端に寄せる): 操作者名(`sidebar.session.operator` / `operatorAnonymous`)、ログインの有効期限(`formatDateTime`、タイムゾーンは vars `TIMEZONE`)、ログアウト(従来の `POST /logout` フォーム)。
- **サイドバーに置かないもの**: スポンサー画像・説明欄など金銭を連想させる要素、ホスティング業者の案内・広告、ゲームサーバー ID(非公開情報。`GET /v1/server-id` は呼ばない)、RCON パスワードやその長さ・`passwordShort`。
- **ヘッダー**: アプリ名(`/` へのリンク。`?server=` 付き)と、幅 1024px 未満のときだけサイドバーの開閉ボタン(9.5)。操作者名・期限・ログアウトはサイドバー最下部へ移したのでヘッダーには出さない。
- **タブ**: 概要 / プレイヤー / BAN / 操作ログ / 設定 / キルフィード。現在のページは `aria-current="page"`。キルフィードは「準備中」の小さな印(`tabs.comingSoon`)付きで `/killfeed` へのリンク(9.6)。タブはページ遷移で切り替える。ARIA の `tablist` / `tab` は使わない(各タブは別 URL の通常のリンクで、JS 無しでも動き、`?server=` の規則〔15.5〕をそのまま使えるため。`tablist` はページ内のパネル切り替え用の役割で、ページ遷移のリンクに付けると支援技術の操作説明と食い違う)。
- サイドバーの縦ナビとタブは同じ行き先の重複になる。要望どおり両方置くが、幅 1024px 未満では縦ナビを出さない(9.5)。重複を嫌う場合は `nav.ts` の `inSidebar` を外すだけで済む(要確認 U-16)。

### 9.3 サイドバーのデータ源と更新

**新しい API は作らない**。既存の `/api/status` の応答を広げるだけにする(`experiences`、`rotation.count` / `nextMap` / `nextMapName`。API.md 3 章、`src/types/api.ts` の `StatusResponse` / `StatusRotation`)。

| 項目 | データ源 | 取得のしかた |
|---|---|---|
| サーバー一覧・選択中のサーバー・表示名・ホスト名:ポート・有効/無効・`needsPassword` | `PageContext`(`ctx.servers` / `ctx.server`。中身は `/api/servers` と同じ `ServerSummary`) | **サーバー描画(SSR)のみ**。ページ遷移ごとに最新になる。サイドバーから `/api/servers` を呼ばない |
| 操作者名・ログインの有効期限 | `ctx.session`(`/api/session` の `session` と同じ値) | SSR のみ。セッションは 12 時間で延長しない(U-2)ので取り直す必要が無い |
| ゲーム内サーバー名・マップ・人数・ゲームモード・陣営スコア・次のマップ・ローテーション位置・最終更新時刻・RCON に届いているか | `/api/status` | 30 秒ごと(`POLL_MIN_INTERVAL_SEC`)。**メインと共有する**(下記) |
| 設定の警告(`warnings`) | `/api/session` | 従来どおり `SessionNotices` が表示後に 1 回(サイドバーでは扱わない) |

**二重取得の回避(決定: モジュール単位の共有ストア)**

- `src/components/lib/status-store.ts` を作り、`/api/status` の取得・30 秒ごとの更新・非表示中の停止・同時取得の抑止(取得中なら相乗り)を **サーバー id ごとに 1 つ**だけ持つ。購読者(アイランド)が 1 つ以上いる間だけ動き、0 になったら止める(参照カウント)。
- React からは `useSharedStatus(serverId)`(`useSyncExternalStore`)で使う。返す値は `useResource` と同じ形(`data` / `error` / `loading` / `updatedAt` / `refresh`)にし、`StatusPanel` の `useResource('/api/status')` をこれに置き換える。
- Astro のアイランドは別々の React ルートだが、**同じページで同じ URL の ES モジュールは 1 回だけ評価される**ため、`status-store.ts` のモジュール変数は両方のアイランドで共有される(Vite が共通チャンクに分ける)。`pnpm build` の出力と、実機の Network パネルで「概要タブで `/api/status` が 30 秒に 1 回」であることを確認する(要確認 I-6。共有されていなかった場合は、ストアの登録先を `globalThis` の 1 つのキーに置く)。
- 「更新」ボタン(`refresh`)はストア経由なので、メインで押せばサイドバーも同時に更新される。書き込み操作(マップ変更・試合終了・kick 等)の成功後もストアの `refresh` を呼ぶ(人数・マップがすぐ反映される)。
- 既存の `useResource` の取得・タイマー処理は、ストアと同じ実装(例 `createPoller(path, pollSec)`)に寄せ、似た処理を 2 系統持たない。
- 採らなかった案: (a) サイドバーとメインを 1 つのアイランドにまとめて props で渡す(全ページの構造を作り直すことになり、`ServerGate` などのサーバー描画を活かせない)、(b) サイドバー用の軽量 API(RCON の呼び出しは同じ 1 回で、Worker のリクエスト数も減らないため利点が無い)、(c) `BroadcastChannel` でブラウザのタブ間も共有(複数タブで別サーバーを開いていることがあり〔15.5〕、仕組みも増えるため)。

**取得しない条件**: サーバーが 0 台、`?server=` が見つからない(`serverNotFound`)、選択中のサーバーが `usable` でない(無効・パスワード再入力が必要)ときは、サイドバーのアイランドを描画しない(=ポーリングしない)。カードには SSR で表示名・ホスト名:ポート・理由と `/servers` への導線だけを出す。

**接続状態の表示**(サーバーカード。判定は上から順):

| 条件 | 表示(`sidebar.state.*`) | 補足 |
|---|---|---|
| `!server.enabled` | `disabled`(無効) | SSR。`/servers` への導線 |
| `server.needsPassword` | `needsPassword`(パスワードの再入力が必要) | SSR。`/servers` への導線 |
| 未取得(初回の取得中) | `loading`(確認中) | − |
| 直近の取得が成功 | `ok`(RCON に接続できています)+ `sidebar.updated`(最終更新 {time}) | `updatedAt` を時刻のみで整形 |
| `RCON_UNREACHABLE` / `RCON_TIMEOUT` | `unreachable`(RCON に届きません) | 前回の値は残し、`common.staleData` を添える |
| `RCON_AUTH_FAILED` | `authFailed`(RCON のパスワードが違います) | `/servers` への導線 |
| `RCON_RATE_LIMITED` | `rateLimited`(RCON の回数制限中) | `retryAfterSec` があれば添える |
| それ以外のエラー(他の `RCON_*`・`NETWORK`・`SERVER_*` 等) | `error`(状態を取得できません) | 詳細はメインの `ErrorView` に任せる(概要タブ以外では詳細を出さない) |

- 色だけで状態を伝えない(文言 + 記号)。`role="status"` にし、読み上げは状態の文言が変わったときだけ起きるようにする(30 秒ごとの「最終更新」の書き換えは読み上げ対象の外に置く)。
- 直近の接続テスト(`lastTest`)はサイドバーには出さない(ポーリングの結果の方が新しいため)。`/servers` の一覧で見る。
- `UNAUTHENTICATED`(セッション切れ)を受けたら、既存のアイランドと同じく `/login` への案内を出す(ストアはポーリングを止める)。

**無料枠への影響(11.1・15.9 への追加)**: 概要タブでは従来どおり 30 秒に 1 回(共有のため増えない)。プレイヤータブでは `/api/players` に加えてサイドバーの `/api/status` が 30 秒に 1 回増える(1 タブを 24 時間開くと 2,880 → 5,760 リクエスト/日)。BAN・操作ログ・設定タブは従来は自動更新が無かったが、サイドバーの分が 30 秒に 1 回になる。11.1 の「多め」(運営者 3 人 × 2 タブ × 12 時間)は、全タブがプレイヤータブだった最悪で約 17,800/日、上限の目安は「タブ 17 本を 24 時間」。無料枠内に収まるが、余裕は半分になる。`/v1/rotation` は 300 秒キャッシュのため RCON 呼び出しの増分は 1 サーバーあたり 5 分に 1 回で、`/api/status` のサブリクエストは最大 7(50 / 同時 6 に収まる。`/v1/rotation` は `/v1/status` の後に順に呼ぶ)。

### 9.4 各タブの内容

| タブ | メイン | 主なキー |
|---|---|---|
| 概要(`/`) | 状態の詳細(ゲーム内サーバー名、マップ〔表示名と id〕、人数、陣営スコア〔全陣営〕、ゲームモード、ローテーション位置、次のマップ、最終更新時刻と「更新」)。**よく使う操作**: 全体メッセージ(broadcast)、マップ変更、試合終了。各操作のボタン・フォームの直下に「何が起きるか」の短い説明(`action.help.<action>`) | `status.*`、`action.help.broadcast` / `map` / `match_end` |
| プレイヤー(`/players`) | 接続中一覧(名前、陣営、K/D、ping、Steam ID)。行ごとに kick / 個別メッセージ / BAN。一覧の上に 3 操作の説明を 1 回だけ出す(行ごとには出さない。モバイルで行が長くなるため) | `players.*`、`action.help.kick` / `message` / `ban` |
| BAN(`/bans`) | BAN 一覧(Steam ID、日時、理由、実行者、監査ログからの名前)。解除。一覧の上に解除の説明 | `bans.*`、`action.help.unban` |
| 操作ログ(`/audit`) | 従来どおり(「操作」「設定変更」の切り替え、サーバーでの絞り込み。既定は全サーバー〔U-9〕。サイドバーで選んだサーバーに自動では絞らない) | `audit.*` |
| 設定(`/servers`) | 従来の「サーバー設定」(15.7)。ページ見出しは「設定」、その下に「サーバー」の節を置く。将来アプリ設定(言語・タイムゾーン。D1 `settings`、8.8)を足すときは同じページに「アプリ」の節を足す(パスは `/servers` のまま。節が増えて長くなったら `/settings` を作り、`/servers` はそのサーバーの節として残す) | `servers.*`、`tabs.settings` |
| キルフィード(`/killfeed`) | 「準備中」の説明だけ(9.6)。API を呼ばない | `killfeed.*` |

**操作の説明(`action.help.*`)の規則**

- `action.help.<WriteAction>` を **全 `WRITE_ACTIONS` 分必須**にする(`confirm.<action>` と同じく `satisfies` で型検査。13.1)。
- 1〜2 文、60 文字程度まで。ボタン(または送信ボタン)の `aria-describedby` で結び付ける。確認ダイアログ(`ConfirmDialog`)の本文の下にも同じ説明を出す(押す前と実行前の 2 回読める)。
- RCON の挙動として**未検証のことを断定しない**。趣旨の例: 試合終了「現在の試合を終了します。通常はローテーションの次のマップに進みます(サーバーの設定によります)」、マップ変更「全員が新しいマップに移ります。進行中の試合は終わります」(いずれも要確認 R-20)、BAN「再接続できなくなります。解除は BAN タブから行えます」、kick「サーバーから退出させます。再接続はできます」、全体メッセージ・個別メッセージ「ゲーム内に表示されます。送った後は取り消せません」、BAN 解除「再び接続できるようになります」。

### 9.5 モバイル(375px)

- **幅 1024px 未満**ではサイドバーを左列に置かず、ヘッダーの直下に**折りたたみ式のパネル**として置く。ドロワー(画面の上に重ねる表示)は採らない: 重ね表示はフォーカスの閉じ込め・背景のスクロール固定・Esc で閉じる処理が要り、JS 無しで動かないため。
  - 閉じているとき: 1 行の要約(表示名・人数「現在 / 最大」・接続状態の記号と短い文言)と開閉ボタン(ハンバーガーの記号 + `sidebar.toggle.open` / `sidebar.toggle.close`。`aria-expanded`、`aria-controls`)。
  - 開いたとき: 9.2 の 1〜3 と 5(縦ナビは出さない。タブがあるため)。
  - JS が無い場合は常に開いた状態で表示する(`<html>` に `js` クラスが付いたときだけ閉じた状態から始める。開閉ボタンも JS があるときだけ出す)。開閉の状態は保存しない(ページ遷移ごとに閉じた状態に戻る)。
  - 0 台・使えないときの案内はメインの `ServerGate` にも出るので、要約だけでも状況が分かる。
- **タブ**: 1 行に並べ、**タブ列の中だけ横スクロール**(`overflow-x: auto`、`scroll-snap-type: x proximity`)。現在のタブは読み込み時に `scrollIntoView({ inline: 'nearest', block: 'nearest' })` で見える位置に寄せる。タップ領域は高さ 44px 以上。右端に続きがあることが分かるよう、端に薄いグラデーションを付けてよい。
- **ページ全体に横スクロールを出さない**(`body` の `overflow-x: hidden` で隠すのではなく、はみ出す要素を作らない。ホスト名・Steam ID・マップ id は `overflow-wrap: anywhere`、表は既存の 1 列表示〔`ops.css` の `max-width: 719px`〕を使う。グリッドの列は `minmax(0, 1fr)`)。
- 確認: 375×812 で、横スクロールが無いこと、開閉・タブ・サーバー切り替え・ログアウトが操作できることをスクリーンショットで確認する(QA)。

### 9.6 キルフィード(将来。枠だけ)

- 今回はタブと `/killfeed` ページだけを作り、「準備中」と理由の短い説明(`killfeed.*`)を出す。API・D1 の追加は無い。
- 理由: RCON HTTP API には接続・キルのイベントを取得するルートが無い。資料上、イベントはゲームサーバー側から外部へ送る `WDServerFeed` だけ(`docs/research/wardogs-rcon.md` 2.4。`killed` のみ、未検証)。
- 実現するには**別タスク**として次を決める(14 章 K-1〜K-5):
  1. Worker に受信エンドポイント(資料では `Url + /api/ingest/events` に Bearer トークン付きで約 2 秒ごとにバッチ POST)を足す。ログイン Cookie・Origin 検査の対象外にし、サーバーごとの受信用トークン(RCON パスワードとは別。D1 にハッシュで保存)で認証する。
  2. ゲームサーバーの設定(`[WDServerFeed] Url / Token`)に Worker の URL とトークンを入れる手順(設定ファイルの編集は第 2 段階の範囲)。
  3. 量の見積り: 2 秒ごとの POST は 1 台で最大 43,200 リクエスト/日になり、無料枠 10 万/日を 2〜3 台で使い切る。D1 の書き込みも同様。保存せず画面に流すだけにするか、間引くかを含めて決める。
  4. 画面への届け方(30 秒ポーリングで足りるか)。
- 上記が決まるまで、`/killfeed` はログイン済みの人にだけ見える静的な案内ページのままにする。

### 9.7 frontend-pages への引き継ぎ(ファイル単位)

| ファイル | 作業 |
|---|---|
| `src/layouts/nav.ts`(新規) | タブ・縦ナビの定義(`id`、`href`、`label: MessageKey`、`inSidebar`、`comingSoon`)を 1 つの配列で。`NavId` を `OpsLayout.astro` から移し、`killfeed` を追加 |
| `src/layouts/OpsLayout.astro` | 9.2 の 3 領域とタブ列。ヘッダーのサーバーセレクト・操作者・期限・ログアウトを `Sidebar.astro` へ移す。開閉ボタン、`<html>` の `js` クラス、セレクトの即送信、現在のタブを寄せるインラインスクリプト |
| `src/components/Sidebar.astro`(新規) | サイドバーの SSR 部分(切り替え・追加リンク・カードの静的項目と使えない理由・縦ナビ・最下部)。`usable` のときだけ `SidebarStatus` を `client:load` で置く |
| `src/components/SidebarStatus.tsx`(新規) | カードの動的項目(ゲーム内サーバー名・マップ・人数・ゲームモード・接続状態・最終更新)と試合の要点。`useSharedStatus`。props は `language` / `timeZone` / `serverId`。モバイルの要約行も同じアイランドで出す |
| `src/components/lib/status-store.ts`(新規) | 9.3 の共有ストアと `useSharedStatus` |
| `src/components/lib/hooks.ts` | `useResource` の取得・タイマー処理をストアと共通化 |
| `src/components/StatusPanel.tsx` | `useSharedStatus` に置き換え。ゲームモード・次のマップ・ローテーション件数の表示。`action.help.*`。操作の成功後に `refresh` |
| `src/components/PlayersTable.tsx` / `BansTable.tsx` | 一覧の上の操作の説明(`action.help.*`)。操作の成功後にストアの `refresh` |
| `src/components/ConfirmDialog.tsx` | 本文の下に `action.help.<action>` |
| `src/components/ServersPanel.tsx` | `#add` で追加フォームを開く。見出しを「設定」+「サーバー」の節に |
| `src/pages/killfeed.astro`(新規) | 準備中の案内(アイランドなし)。`active="killfeed"` |
| `src/pages/*.astro` | `active` の値とページタイトルのキーを `tabs.*` に |
| `src/styles/ops.css` | グリッド(1024px 以上で 2 列)、サイドバー、タブ列の横スクロール、折りたたみパネル。既存の `.site-nav` / `.header-session` / `.server-switch` を置き換え |
| `src/i18n/ja.ts` | 13.8 のキーを追加。`nav.*`・`header.operator*`・`header.sessionExpires`・`header.server*` を移し替えて削除 |
| `docs/screenshots/`(README 用) | 撮り直し。ホスト名はダミー(`rcon.example.com`)のみ |

backend の作業: `src/lib/rcon/normalize.ts`(`experiences` と `/v1/rotation` の正規化)、`src/lib/reads.ts` 周辺(`/v1/rotation` の取得・300 秒キャッシュ・失敗時 null と 60 秒の失敗キャッシュ・`map` / `match_end` 成功時の破棄。capabilities の `routes` に `GET /v1/rotation` が無ければ呼ばない。`CapabilitiesResponse.read` には足さない)、`src/lib/rcon/routes.ts`、テスト。済んだら architect が `StatusResponse.experiences` と `StatusRotation` の 3 項目の `?` を外す。

## 10. Secrets / vars

### 10.1 一覧

**Worker Secrets は使わない**(2026-10-16)。利用者が Cloudflare 側で入力する値は無い。

| 名前 | 種別 | 必須 | 内容 |
|---|---|---|---|
| `DB` | D1 バインディング | **必須** | 自動プロビジョニング(`wardogs-ops-db`)。管理者・鍵・サーバー・ログをすべて置く |
| `LANGUAGE` | vars(`wrangler.jsonc`) | 任意 | 表示言語の言語コード。既定 `"ja"`。`"auto"` で Accept-Language から選ぶ(13.2) |
| `TIMEZONE` | vars(`wrangler.jsonc`) | 任意 | 既定 `"Asia/Tokyo"`(IANA 名。13.4) |
| `AUDIT_REQUIRED` | vars(`wrangler.jsonc`) | − | **効果なし**(7.4)。削除はユーザー確認後(U-12) |

| 値 | 置き場所 |
|---|---|
| 管理パスワード | D1 `admins.password_hash`(PBKDF2 のハッシュ。5.2)。`/setup` で登録 |
| 鍵の元(`instance_key`) | D1 `settings`(5.1.2)。自動生成 |
| RCON の接続先・パスワード | D1 `servers`(パスワードは AES-256-GCM。15.3)。`/servers` で登録 |

- **vars も将来は画面の「設定」に移す前提**(D1 `settings` に置き、`wrangler.jsonc` の値は初期値として扱う。ダッシュボードの値が次のデプロイで戻る問題〔C-8 / I-4〕も無くなる)。今回は実装しない。
- 旧 Secrets(`ADMIN_PASSWORD` / `RCON_URL` / `RCON_PASSWORD` / `SESSION_SECRET`)が Cloudflare 側に残っていてもコードは読まない。README で「残っている場合は削除してよい」と案内する。

### 10.2 Deploy ボタンとローカル開発

| 項目 | 内容 |
|---|---|
| Deploy to Cloudflare ボタン | 入力するのは Worker 名と D1 の名前だけ。**`.dev.vars.example` は削除した**(ボタンはこのファイルの名前を Secrets の入力欄として出すため。コメントだけのファイルの扱いが未確認〔C-6〕なので、ファイル自体を置かない)。`package.json` の `cloudflare.bindings` は `DB` の説明だけ |
| ローカル開発 | `.dev.vars` は不要。`pnpm db:migrate:local` → `pnpm dev` → ブラウザで `/setup` を開いて登録。vars を開発時だけ変えたい場合は `.dev.vars` を手で作る(`.gitignore` 済み) |

`secrets.required`(wrangler 設定)は使わない(Secrets を使わないため)。

### 10.3 パスワードの変更と鍵

- 管理パスワード: 変更画面は第 2 段階。現状は「`admins` の行を削除 → `/setup` で登録し直す」(5.4。全セッション失効、サーバーと操作ログは残る)。
- 登録サーバーの RCON パスワード: ゲームサーバー側を変えた後、`/servers` の編集で入れ直す。漏洩が疑われるときは最優先で行う(RCON パスワードは読み書き全権)。
- `instance_key`: ローテーションしない(変えると全サーバーのパスワードの入れ直しが要る)。鍵の漏洩 = D1 の漏洩であり、そのときは RCON パスワードの変更で対処する(12 章)。

## 11. 無料枠の見積り

前提: Workers 10 万リクエスト/日、サブリクエスト 50/リクエスト、同時接続 6、D1 書き込み 10 万行/日・読み取り 500 万行/日(UTC 0 時リセット)。静的アセット(`/_astro/*`)はリクエスト数に数えない。

### 11.1 Worker リクエスト

自動更新は 30 秒間隔・非表示タブは停止。1 タブを開きっぱなしにすると `86400 / 30 = 2,880` リクエスト/日。

| 想定 | 計算 | リクエスト/日 |
|---|---|---|
| 通常(運営者 2 人 × 1 タブ × 8 時間) | 2 × 960 + ページ遷移・操作 約 200 | 約 2,100 |
| 多め(3 人 × 2 タブ × 12 時間) | 6 × 1,440 + 約 500 | 約 9,100 |
| 上限の目安 | 100,000 / 2,880 | タブ 34 本を 24 時間開き続けて到達 |

2026-10-17 のサイドバー(9.3)により、状態タブ以外を開いている間は `/api/status` が 30 秒に 1 回加わる(1 タブあたり最大 5,760/日。上の表は最大で約 2 倍、上限の目安はタブ 17 本を 24 時間)。

ログイン画面への総当たりはリクエスト数を消費する(5.6 のロックは CPU と D1 を守るが、リクエスト数そのものは減らせない)。無料枠を使い切ると当日 UTC 0 時(JST 9 時)まで Worker が止まる。対策が必要になったら WAF のレート制限ルール(Free は 1 ルール)を README の「困ったとき」で案内する。

### 11.2 サブリクエスト(1 リクエストあたり)

| API | RCON | D1 | 計 |
|---|---|---|---|
| `/api/status` | 1(+ capabilities 取得時 1、+ `/v1/rotation` 300 秒に 1 回。9.3) | 0〜1(スナップショット)+ D1 判定 0〜1 | 最大 5 |
| `/api/actions/prepare` | 1〜2(players、maps) | 0〜1(unban の名前) | 最大 3 |
| `/api/actions/execute` | 1 | 2(INSERT + UPDATE) | 3 |
| `POST /login` 成功 | 0 | 約 8(D1 判定・管理者の読み取り、throttle 加算・消去、audit、掃除 3。回数の引き上げ時は +1) | 約 8 |
| `POST /setup` | 0 | 約 4(管理者の有無、instance_key、条件付き INSERT、admin_register) | 約 4 |
| ログインが必要なリクエスト共通 | − | +1(Cookie の検証で admins を 1 行。5.3) | − |

いずれも 50 / 同時 6 に収まる。複数サーバー対応での増分(サーバーの解決で D1 読み取り +1)は 15.9。

### 11.3 D1

| 対象 | 計算 | 書き込み行/日 |
|---|---|---|
| server_snapshots(1 台あたり) | 5 分に 1 行 × 24 時間 = 288 行(インデックス更新を含めても 2 倍以内と見込む。C-17) | 最大 約 600 |
| audit_log | 1 操作 = INSERT + UPDATE + インデックス 2 本 ≒ 6 行相当 × 100 操作 | 約 600 |
| login_throttle | 失敗 1 回 = 2 行(ip + global)。ロック中は書かないので 1 接続元あたり 15 分に最大 5 回 | 接続元ごとの上限だけだと 100 接続元が 24 時間続けて 100 × 96 × 5 × 2 = 96,000 で上限に近い。global の上限(下記、1 時間 200 回)で頭打ちにし、最悪 200 × 2 × 24 = 9,600 行(インデックス更新が数えられても約 2 万行、上限の 2 割以内) |
| 合計(通常) | | 約 1,500(上限の 1.5%)。複数サーバーでの増分は 15.9(最悪でも上限の約 12% 増) |

login_throttle の最悪値が上限に近いため、**global の失敗が 1 時間に 200 回を超えたら以後その時間は throttle を書かない**(`GLOBAL_D1_WRITE_LIMIT`。2026-10-15 QA S-11 で 1,000 から引き下げ)(ロック判定はメモリ近似に切り替える)実装とする。読み取りは監査ログ 50 件 × 閲覧回数程度で 500 万行/日に遠い。ストレージは 1 年で数十 MB 以内(5 GB に遠い)。

## 12. 撤回した旧方針とトレードオフ

2026-10-15 午前の方針(Cloudflare Access のメール認証 + Worker での JWT 検証、Cloudflare Tunnel、自宅 PC / VPS の中継プロキシに RCON パスワードを置き許可ルートを列挙)は、非エンジニアには設定が重すぎるため撤回した。さらに 2026-10-16 に Worker Secrets も廃止し、管理パスワード(ハッシュ)・鍵・RCON パスワード(暗号化)をすべて D1 に置いた(第 5 章)。現方針で受け入れるリスク:

| 項目 | 旧方針 | 現方針(受け入れるリスク) | 緩和策 |
|---|---|---|---|
| RCON パスワードの置き場所 | 中継プロキシの機械のみ | **D1 に、同じ D1 にある `instance_key` から作った鍵で暗号化して置く**。鍵と暗号文が同じ場所にあるので、**D1 を読める相手(Cloudflare アカウントの乗っ取り、D1 への API トークンの漏洩)には復号できる**。暗号化は「D1 のエクスポート・バックアップ・画面表示やログの閲覧で平文が目に入らない」ための措置で、D1 の窃取そのものには効かない。Worker の改ざんでも同じく kick / ban / 設定置換が可能になる | **Cloudflare アカウントの 2 要素認証(README で必須扱い)**、D1 への API トークンを作らない・広い権限で作らない、RCON パスワードの定期変更。漏洩が疑われたら RCON パスワードを変える(ゲーム側と `/servers`) |
| 管理パスワードの置き場所 | Access(メール認証) | D1 に PBKDF2(1 万回)のハッシュ。平文は復元できないが、D1 を読める相手は `instance_key` で Cookie を偽造できるので、パネル自体は守れない。ハッシュが守るのは「他サービスで使い回したパスワード」だけ | 16 文字以上の強制、ランダム生成の推奨、使い回さないことの案内 |
| 初期設定 | − | **デプロイ直後から管理パスワードを登録するまでの間、URL を知る誰でも先に登録できる**(5.1.1) | README で「デプロイしたらすぐ登録」と案内、登録画面が出なければ `admins` を消してやり直す手順、`admin_register` の記録。ワンタイムコード方式は手順が重いため不採用 |
| 許可ルートの限定 | 中継プロキシが列挙したルートのみ | Worker のコードが許可リストを持つだけ(Worker が改ざんされれば無効) | `routes.ts` の固定リスト + capabilities |
| RCON ポート | Tunnel 経由でインターネットに出さない | **RCON ポートがインターネットから到達可能である必要**。平文 HTTP のため経路上でパスワードが読まれ得る(C-1、R-5) | 強いパスワード、`PasswordHash` で ini に平文を残さない、TLS が使えるなら https(R-3) |
| 接続元の制限 | AllowedHosts に中継機の IP 1 つ | **Workers の送信元 IP は固定されず公式に列挙できないため、AllowedHosts で絞れない**(C-3)。全許可にするしかない可能性が高い(書式・挙動は R-4) | パスワードの強度(32 文字以上推奨)、RCON 側の監査ログ `/v1/audit` での AUTH_FAIL の確認(第 2 段階で画面化) |
| パネルの入口 | Access の前段で遮断 | workers.dev 上のログイン画面がインターネットに公開される | 16 文字以上のパスワード、接続元ごとのロック、`preview_urls: false` |

Secrets 廃止前(2026-10-16 午前)との比較: 以前は RCON パスワードが Worker Secret(または ADMIN_PASSWORD / SESSION_SECRET 由来の鍵で暗号化した D1)にあり、「D1 だけが漏れた」場合は平文を得られなかった。現方針ではその場合も復号できる。一方で、Cloudflare アカウントを乗っ取られた場合は以前も Secrets ごと漏れていたため、守れる範囲の差は「D1 だけが漏れる」場合に限られる。利用者が Cloudflare 側で値を入力・管理しなくてよい簡単さを優先した(ユーザー決定)。

将来の選択肢(実装しない。短く記録するだけ): (a) 利用者が自前ドメインを持つ場合に Cloudflare Access をログインの前段に追加する、(b) RCON 側で TLS が使える場合の https 化、(c) 中継プロキシを任意オプションとして復活させ AllowedHosts を絞る、(d) Cron による常時スナップショット、(e) `PUT /v1/config` による設定変更(第 2 段階)、(f) 任意の Secret(例 `KEY_ENCRYPTION_SECRET`)を設定した場合だけ `instance_key` をそれで包む(D1 だけの漏洩に備えたい上級者向け)。

## 13. 多言語化

2026-10-15 ユーザー決定(CLAUDE.md「多言語化」): **当面は日本語(`ja`)のみ。後から言語を足せる設計にする**。外部ライブラリは追加せず、自前の軽量な `t()` で足りる前提とする(補間は `{name}` の置換だけ。複数形などが必要になったら標準の `Intl.PluralRules` を使う。それでも足りずに依存を増やす場合は理由を要確認に書く。現時点で追加する依存は無い)。

### 13.0 命名

| 名前 | 使う場所 | 値の例 | 定義 |
|---|---|---|---|
| **Language(言語)** | 利用者が触る名前。vars `LANGUAGE`、カタログのファイル名、README・画面のラベル「言語 / Language」 | `ja`、`en`(言語コード) | `src/i18n/index.ts` の `SUPPORTED_LANGUAGES` / 型 `Language` |
| **locale** | コード内部で `Intl` に渡す値だけ | `ja-JP`、`en-US` | 型 `Locale`。`LANGUAGE_TO_LOCALE`(`ja` → `ja-JP`、将来 `en` → `en-US`)で Language から引く |

利用者向けの文書(README、画面の文言)では「ロケール」という語を使わない。

### 13.1 メッセージカタログ

- 画面の文言(Astro ページ、React アイランド、ログインフォームのエラー、/setup の警告、確認ダイアログ、操作ログの表示)はすべて `src/i18n/<言語コード>.ts` のカタログに集約し、`t(key, params?)` 経由で参照する。**コンポーネント・Astro ページに文言を直書きしない**(`<title>` や `aria-label` も含む)。
- `src/i18n/ja.ts` がキーの正本。キーはドット区切りのフラットな文字列(例 `login.title`、`error.RCON_TIMEOUT`)。`MessageKey = keyof typeof ja`、他の言語は `Catalog = Record<MessageKey, string>` で作るので **キーの過不足は型エラーになる**。
- `error.<ApiErrorCode>` と `validation.<ValidationIssue>` は `satisfies` で全コード分を必須にしてある(コードを `src/types/api.ts` に足すとカタログが型エラーになり、訳し漏れを防ぐ。キーを 1 つ消すと tsc がエラーになることを確認済み)。`SetupWarning` の `setup.warning.<コード>`、確認ダイアログの `confirm.<action>`、操作の説明の `action.help.<action>`(9.4)、操作ログの `audit.event.<event>` も、実装時に同じ方法で全コード必須にする。
- 補間: `{name}` を params の値で置換する。値は文字列化するだけで HTML エスケープはしない(Astro / React の通常の出力でエスケープされる。`set:html` / `dangerouslySetInnerHTML` にカタログの文字列を渡さない)。
- **翻訳しないもの**: RCON から返る生データ(サーバー名、マップ名・displayName、陣営名、プレイヤー名、BAN の理由・実行者、`rconMessage`)と、運営者が入力した文字列(broadcast の本文、kick の理由、操作者名、登録サーバーの表示名・ホスト名)。そのまま表示する。

### 13.2 言語の決め方

**決定: vars `LANGUAGE` で固定(既定 `"ja"`)→ `LANGUAGE` が `"auto"` のときだけ `Accept-Language` → どれにも当たらなければ `ja`**(`resolveLanguage(env.LANGUAGE, Accept-Language)`)。

根拠:

1. 運営パネルは同じ運営チームが共有するもので、利用者ごとに言語が変わるより、運営者が「このパネルは何語」と決められる方が分かりやすい。操作ログの読み方も揃う。
2. `Accept-Language` は既定にしない。ブラウザの設定次第で表示が変わり、問い合わせ時に画面の説明が食い違うため。多言語の運営チーム向けに `"auto"` で選べるようにしておく。照合は言語コード単位(`ja-JP` → `ja`)。
3. ログイン後の手動切り替え(Cookie への保存)は**第 2 段階**。追加するときは「Cookie の値 → `LANGUAGE` の規則」の順にし、Cookie はログイン Cookie とは別の非機密 Cookie にする。
4. **URL に言語を含めない**(`/ja/...` にしない)。ログイン必須の管理画面で SEO が不要なうえ、ルーティングと middleware の判定が単純なまま保てる。
5. 対応していない値(例 カタログ追加前に `"en"` を設定)は `ja` に戻す。設定ミスでも画面が壊れない。

`<html lang>` には決まった言語コードを入れる。`Intl` には `toLocale(language)` の locale を渡す。

### 13.3 サーバーとクライアントでのカタログの共有

- **言語とタイムゾーンはサーバー(Astro ページ)で 1 回だけ決め、アイランドには props で渡す**(例 `<StatusPanel client:load language={language} timeZone={timeZone} />`)。アイランドは `env`(Worker の vars)や `Accept-Language` を自分で読まない。locale はアイランド内で `toLocale(language)` で求める。
- アイランドもサーバーも **同じ `src/i18n/` を import** し、`getTranslator(language)` で `t` を作る。`src/i18n/` は Worker 固有の API(`cloudflare:workers` 等)に依存させない(サーバー・ブラウザの両方で動くこと。現状の雛形はそうなっている)。
- **カタログの送り方の決定: 当面は全言語を静的 import(クライアントバンドルに全部入る)**。言語が `ja` 1 つのうちは「全部」=「必要な分だけ」で、仕組みが最も単純(非同期読み込み・ちらつきが無い)。日本語カタログは数 KB の見込み。
- 言語を足して全カタログの合計が大きくなったら(目安: 圧縮後 20 KB 超)、`index.ts` の `CATALOGS` を動的 import(`import('./en')`)に替え、必要な言語の分だけ読み込む(Vite が言語ごとに分割する)。その場合も呼び出し側(`getTranslator(language)` の形)は変えない方針で、非同期化は `index.ts` の内側に閉じる(要確認 I-2)。
- カタログを props で HTML に埋め込む方式(サーバーが選んだ言語の分だけ JSON で渡す)は採らない。アイランドごとに同じ文言が HTML に重複し、キーの型検査も効かなくなるため。

### 13.4 日時・数値

- 日時・数値は必ず `formatDateTime(epochMs, locale, timeZone)` / `formatNumber(value, locale)`(中身は `Intl.DateTimeFormat` / `Intl.NumberFormat`)で整形する。**`Asia/Tokyo` や「+9 時間」を表示コードに直書きしない**(既定値は `src/i18n/index.ts` の `DEFAULT_TIMEZONE` の 1 か所だけ)。
- タイムゾーンは vars `TIMEZONE`(既定 `Asia/Tokyo`)。`resolveTimeZone()` で検証し、`Intl` が受け付けない値なら既定に戻す。
- API・D1 の時刻は常に UTC epoch ミリ秒(タイムゾーンを持たない)。変換は表示の直前だけ。
- 相対時刻(「3 分前」)が要る場合は `Intl.RelativeTimeFormat` を使う。

### 13.5 API とエラー

- API は**表示用の文言を返さない**。エラーは `error.code`(`ApiErrorCode`)と、検証エラーの `fields`(項目名 → `ValidationIssue`)で返し、画面がカタログ(`error.<code>`、`validation.<issue>`)で文言を引く。`error.message` は開発者向けの英語固定の短い説明で任意、**画面には出さない**。
- 確認ダイアログ・操作ログの文も Worker では作らない。prepare は正規化済み params と対象名を、audit は event・params・target_name を返し、画面が `confirm.<action>` / `audit.event.<event>` で組み立てる。D1 にも文言を保存しない(言語を変えても過去のログが読める)。
- ログインフォーム(`POST /login` の再表示)と /setup はサーバー描画なので、サーバー側で同じカタログを引く。
- ネットワーク断など API 応答が得られない場合の文言はカタログの `error.NETWORK`(API の `ApiErrorCode` には含めない)。

### 13.6 README

`README.md` の先頭に言語リンク欄を置く(現在は日本語のみ)。英語版を足すときは `README.en.md` を作り、両方の先頭の欄に相互リンクを書く。

### 13.7 言語を足す手順(例: 英語 `en`)

1. `src/i18n/en.ts` を作り、`export const en: Catalog = { ... }` として `ja.ts` の全キーを訳す(キーの過不足は型エラーになる)。
2. `src/i18n/index.ts` の 4 か所に追加する: `SUPPORTED_LANGUAGES` に `'en'`、型 `Locale` に `'en-US'`、`LANGUAGE_TO_LOCALE` に `en: 'en-US'`、`CATALOGS` に `en`。
3. `pnpm check` と `pnpm build` を通し、クライアントバンドルの増分を確認する(大きければ 13.3 の動的 import に切り替える)。
4. 利用者は vars `LANGUAGE` を `"en"`(または `"auto"`)にする。README に「言語 / Language」の設定方法を書き足す。
5. `README.en.md` を足し、`README.md` と相互に言語リンク欄でつなぐ。

### 13.8 画面構成(サイドバー + ヘッダータブ)のキー(2026-10-17)

9 章の画面構成で frontend-pages が足すキーの名前空間。値の例は趣旨で、正確な文言は frontend-pages がカタログに書く。

| 名前空間 | キー | 用途 |
|---|---|---|
| `tabs.*` | `label`、`overview`、`players`、`bans`、`audit`、`settings`、`killfeed`、`comingSoon` | ヘッダータブとサイドバーの縦ナビ(同じキーを使う)。ページタイトルもこれを使う。`nav.*` はこれに移して削除する |
| `sidebar.*` | `label`、`toggle.open`、`toggle.close`、`summary`(要約行。例 `{name} {current}/{max}`) | サイドバー全体とモバイルの開閉 |
| `sidebar.switcher.*` | `label`、`submit`、`addServer`、`optionDisabled`、`optionNeedsPassword`、`optionUnusable` | サーバー切り替え(`header.server*` から移す) |
| `sidebar.card.*` | `title`、`displayName`、`gameName`、`map`、`players`、`playersValue`、`mode`、`endpoint`、`endpointValue`(`{host}:{port}`) | サーバーカード |
| `sidebar.state.*` | `disabled`、`needsPassword`、`loading`、`ok`、`unreachable`、`authFailed`、`rateLimited`、`error` | 接続状態(9.3 の表)。`sidebar.updated`(最終更新 {time}) |
| `sidebar.match.*` | `title`、`scores`、`moreFactions`(ほか {n} 陣営)、`nextMap`、`rotation`、`rotationValue`({now} / {count})、`rotationIndexOnly`({now} 番目) | 試合の要点 |
| `sidebar.session.*` | `operator`、`operatorAnonymous`、`expires` | 最下部(`header.operator*`・`header.sessionExpires` から移す)。ログアウトは既存の `logout.submit` |
| `action.help.*` | `<WriteAction>` の 7 つ(`kick` `ban` `unban` `broadcast` `message` `map` `match_end`) | 操作の直下と確認ダイアログの「何が起きるか」(9.4)。`satisfies` で全操作必須 |
| `killfeed.*` | `title`、`comingSoon`、`why` | `/killfeed` の準備中の案内(9.6) |
| `status.*`(追加) | `mode`、`nextMap`、`rotationCountValue` | 概要タブで足す項目 |

- RCON の生データ(ゲーム内サーバー名・マップ id・`experiences`・陣営名)と運営者が入力した表示名・ホスト名は翻訳しない(13.1)。
- 削除するキー(移し替え後): `nav.label` / `nav.status` / `nav.players` / `nav.bans` / `nav.audit` / `nav.servers`、`header.operator` / `header.operatorAnonymous` / `header.sessionExpires`、`header.server` / `header.serverSwitch` / `header.serverNeedsPassword` / `header.serverDisabled` / `header.serverUnusable`。
- `server.notFound.help` の「上のメニューでサーバーを選び直してください」は、サイドバー(モバイルでは上部のパネル)に合う言い方に直す。

## 14. 要確認一覧

確度の区別は `docs/research/wardogs-rcon.md`(確定 / 未検証 / 推測)と `docs/research/cloudflare-deploy-button.md` に従う。本設計はいずれも「確認できなくても壊れない」側に倒してあるが、実機で確定させること。

### RCON(非公式資料ベース。実サーバーで確認する)

- **R-1** 実在ルートと `GET /v1/capabilities` の応答形式(`routes[]` の要素が文字列か `{method, path}` か、パラメータ表記)。6.4 の正規化はこの確認後に確定する。
- **R-2** 2026-09-14 のビルド(CL-501228)で書き込み系ルートが廃止され設定ドキュメント経由に移ったという記載の真偽。真なら kick 等が使えず、設定経由の代替設計が必要。
- **R-3** `BindAddress=0.0.0.0` に TLS と `PasswordHash` が必要という記述の真偽。TLS が必要な場合、Workers の fetch は証明書を検証するため自己署名証明書では接続できない可能性が高い(推測)。有効な証明書の用意方法を含め要確認。
- **R-4** AllowedHosts の書式(IP / ホスト名 / CIDR)、空・未設定時の挙動(全許可か全拒否か)、AllowedOrigins との違い。Workers から使う場合に「全許可」にできるか。
- **R-5** HTTPS を拒否する(平文 HTTP のみ)という記述の真偽。
- **R-6** broadcast / message の上限が 256 文字か(上限の存在は確定、値は未検証)、改行の可否。
- **R-7** ban は対象がオンラインである必要があるか。オフラインの Steam ID を BAN する手段の有無。unban の応答。
- **R-8** `/v1/status` の各フィールド(`factionScores` の要素形式、`players.max` が予約枠を引いた値か、`rotation` の意味)。
- **R-9** `steamId` の形式(SteamID64 の 17 桁か)。
- **R-10** kick / ban の `reason` の上限と省略可否。
- **R-11** `/v1/catalog/maps` のルート名と `id` の形式、`POST /v1/match/map` で `experiences` 等が必須か。
- **R-12** `POST /v1/match/end` の本文の要否(空 JSON `{}` を送るか、本文無しか)。
- **R-13** レート制限(600 リクエスト/分/IP、429 + `Retry-After`)の真偽。Workers の送信元 IP が他の利用者と共有される場合の影響。
- **R-14** エラー応答の形式(JSON のフィールド名、ステータスの使い分け)。
  - 書き込み系の 404 を `RCON_ROUTE_NOT_FOUND` に決め打ちしている(QA S-8)。対象プレイヤーの退出時の 404 と区別するには、エラー本文の形式の確認が要る。
  - `rconMessage` をそのまま画面に表示している(QA S-10)。内部情報(パス等)が含まれないかを実機で確認してから、表示の可否を決める。
- **R-15** 認証失敗(パスワード違い)と AllowedHosts による拒否のステータスの違い、失敗が続いたときのロックアウトの有無(送信元を共有する他者の失敗に巻き込まれないか)。
- **R-16** サーバーの提供元ごとに、RCON ポートをインターネットに公開できるか(運営者ごとの確認事項。README で案内)。
- **R-17** 開発元による公式ドキュメント・RCON の外部利用に関する規約(未確認)。
- **R-19** `/v1/status` の `experiences[]` が「ゲームモード」を表すか(要素の形式・値の例)。`/v1/rotation` の `entries[]` の要素の形式(マップ id のフィールド名、表示名の有無)と `enabled: false` の意味。違っていた場合、サイドバーのゲームモードは非表示にし、次のマップは `rotation.nextIndex` だけに戻す(9.3)。
- **R-20** `POST /v1/match/end` の後にローテーションの次のマップへ進むか、`POST /v1/match/map` が進行中の試合をどう扱うか。操作の説明(`action.help.*`。9.4)の文言はこれを断定しない形にしてあり、確認後に直す。
- **R-18** 書き込みルートの成功時の応答(ステータスが 200 / 204 のどちらか、本文の有無と形式)。現在は 2xx なら本文に関係なく成功とする。

### Cloudflare(一次資料で未確定、または実機確認が必要)

- **C-1** `http://ホスト名:7776` への fetch が https に書き換えられず平文のまま届くか。
- **C-2** IP アドレス直指定不可(known-issues)が workers.dev のみの利用でも当てはまるか。README の回避策(自前ドメインの A レコード〔DNS only〕、IP をホスト名に埋め込む型のワイルドカード DNS サービス、ダイナミック DNS)で実際に届くか。
- **C-3** Workers の fetch の送信元 IP を公式に列挙する資料は無い(AllowedHosts に書けない前提で設計した)。
- **C-4** Deploy to Cloudflare ボタンが無料プランで使えるか(Workers Builds は Free 可と確定)。
- **C-5** ボタン経由で D1 が自動作成され、`database_id` 省略の設定で動くか。ボタンが作成した ID をコピー先リポジトリに書き戻すか。**`wrangler d1 migrations apply DB --remote` は D1 が存在しないと失敗する(wrangler 4.151 のソースで確認: "Couldn't find a D1 DB named ...")** ため、`deploy` スクリプトは「`wrangler deploy`(ここで作成)→ マイグレーション」の順にした(指示の順序と逆。理由は本項)。新しいコードが新しいマイグレーションより一瞬先に動くため、マイグレーションは追加のみ(列・テーブルの追加)とし、コードはテーブル・列が無い場合は `D1_NOT_MIGRATED` として `/setup` の案内で止める(7.4。D1 必須化前は「段階 1」として読み取り専用で動かしていた)。
  - **実機確認(2026-10-16、CLI 経由)**: `wrangler deploy`(4.151)で `database_id` 省略の D1 が自動作成・バインドされ、`wrangler.jsonc` は書き換えられなかった(ID は Cloudflare 側で保持)。続く `wrangler d1 migrations apply DB --remote` も成功。Secrets 未設定の状態でトップが `/setup` に誘導されることも確認。**ボタン経由**の自動作成は未確認のまま(Secrets 入力フォームは 2026-10-16 の Secrets 廃止で不要になった)。
- **C-6**(2026-10-16 に不要)ボタンのフォームで入力した Secrets の扱い。Secrets を廃止し `.dev.vars.example` を削除したため確認不要。残る確認は「`.dev.vars.example` が無いとき、ボタンの設定画面に Secrets の入力欄が出ないこと」だけ(C-4 と合わせて確認)。
- **C-7** ボタンの設定画面で Worker 名を変えた場合に、`wrangler.jsonc` の `name` との一致(Workers Builds の要件)が保たれるか。
- **C-8** `wrangler.jsonc` の `vars`(`LANGUAGE` / `TIMEZONE`)がダッシュボードで設定した値をデプロイ時に上書きするか。vars を画面の設定(D1 `settings`)に移せば不要になる(10.1)。
- **C-9** Cron 実行が 10 万リクエスト/日に含まれるか(第 2 段階で Cron 化する場合)。
- **C-10** `@astrojs/cloudflare@14` のカスタムエントリ(`@astrojs/cloudflare/handler` の `handle` は export されていることを確認済み)に `scheduled` を同居させられるか。
- **C-11** RCON のホスト名がプロキシ(オレンジクラウド)だと 7776 番が使えない。DNS only(グレークラウド)必須であることの実機確認。
- **C-12** `redirect: 'manual'` の挙動と、無料プランでの個別サブリクエストの実際のタイムアウト。
- **C-13** ボタン / Workers Builds が `package.json` の `deploy` スクリプトをどう実行するか。pnpm には組み込みの `pnpm deploy` コマンドがあり、`pnpm deploy` と書くとスクリプトではなく組み込みが動く。手動設定では `pnpm run deploy` と書く(README に記載)。
- **C-14** 開発時(http://127.0.0.1)に `Secure` / `__Host-` Cookie が使えるか(使えない前提で開発時は別名にする)。
- **C-15** CSP の `script-src` を絞った場合に Astro 7 のアイランドのインラインスクリプトが動くか(Astro の CSP 機能の有無を含む)。QA S-5 の補足: 現状 CSP に `script-src` / `default-src` が無い。React は文字列をエスケープしており XSS の経路は確認できていないが、インラインスクリプトのハッシュまたは nonce 指定で絞れるかを実機で確認する。`Strict-Transport-Security` はカスタムドメイン利用時のみ必要(workers.dev は HSTS プリロード済み)。
- **C-16** `@astrojs/cloudflare@14` で `waitUntil` を取る方法(`cloudflare:workers` の `waitUntil` か、locals 経由か)。
- **C-17** D1 の「書き込み行数」にインデックス更新が数えられるか(11.3 の見積りの余裕)。
- **C-18** Workers Logs(`observability.enabled`)の無料枠と保持期間。
- **C-20** 本番の Workers での PBKDF2-SHA256 の CPU 時間(1 万回で何 ms か。ローカルの workerd では約 4.4 ms)と、無料プランの 10 ms の扱い(超過時に即 Error 1102 になるか、多少の超過が許されるか)。Workers の PBKDF2 が 100,000 回を超える値を拒否するか(ローカルの workerd では 100,001 回も通った)。Workers Logs の CPU 時間で確認し、余裕があれば `PASSWORD_HASH_ITERATIONS` を上げる(5.2)。
- **C-21** D1 のダッシュボード(Storage & Databases → D1 → データベース)で、非エンジニアが `admins` の行を削除できる具体的な画面操作(テーブル表示から行を削除できるか、Console で `DELETE FROM admins;` を実行する必要があるか)。README 6 章の手順をこれで確定する。
- **C-19** 本文を読まずに返した応答の直後、同じ接続の次のリクエストが 500 になる事象(開発サーバーで観測。`docs/API_TEST.md` 4 章)が本番の Workers でも起きるか。Astro 標準の origin 検査は無効化し、middleware と API は拒否前に本文を読み捨てる対策をしたが、他の早期応答(アダプタ・アセット等)で起きないかを含めて確認する。

### 多言語化(13 章)

- **I-1** Astro 7 + `@astrojs/react` で、ページから React アイランドに渡した props(`language`、`timeZone`)の扱いと、アイランドが `src/i18n/` を import したときのクライアントバンドルの大きさ(実装後に `pnpm build` の出力で確認)。
- **I-2** 2 つ目の言語を動的 import にする場合、`getTranslator` を同期のまま保てるか(サーバーは先読み、アイランドは読み込み完了まで待つ等。追加時に決める)。
- **I-3** Workers の実行環境(workerd)とブラウザで `Intl.DateTimeFormat` の `timeZone` 指定・`ja-JP` の書式が揃うか(サーバー描画とアイランドで日時の表記がずれないか)。
- **I-4** vars `LANGUAGE` / `TIMEZONE` をダッシュボードで変えた値が、次のデプロイで `wrangler.jsonc` の値に戻るか(C-8 と同じ問題。戻る場合はフォーク側の `wrangler.jsonc` を書き換える手順を README に書く)。
- **I-6** 同じページの複数の React アイランドが `src/components/lib/status-store.ts` のモジュール変数を共有するか(Astro 7 + Vite のチャンク分割。9.3)。`pnpm build` の出力と、実機の Network パネルで `/api/status` の回数を確認する。
- **I-5** `Accept-Language` の照合は言語コード単位(`ja-JP` → `ja`)の簡易実装。地域で文言を分けたい言語(例 `pt-BR` と `pt-PT`)を足す場合は、`LANGUAGE` の値の形式と照合規則を見直す。

### 複数サーバー(第 15 章)

- **M-1** D1 の本番で `ALTER TABLE ... ADD COLUMN` が稼働中のデータベースに問題なく適用できるか(ローカルの SQLite では 0001 → 0002 の適用と既存行の保持を確認済み。本番の適用は次のデプロイで確認する)。
- **M-2** D1 の `db.batch()` が 1 トランザクション(途中で失敗したら全体が取り消される)であること。Cloudflare の資料に記載があるとされるが、本設計の範囲では未確認。サーバーの変更と `settings_audit_log` の INSERT の原子性はこれに依存する。
- **M-3** 同じ Worker から多数の異なるホストへ fetch したときの制限の有無(1 リクエストは 1 台にしか接続しないため、問題にならない見込み)。
- **M-4** RCON 側のレート制限・ロックアウト(R-13 / R-15)がサーバー(提供元)ごとに違うか。台数が増えても 1 台あたりの呼び出し回数は変わらない。
- **M-5**(2026-10-16 に不要)Deploy ボタンのフォームから `RCON_URL` / `RCON_PASSWORD` を外す件。Secrets の廃止で `.dev.vars.example` ごと削除した。
- **M-6** `audit_log.event` の CHECK により、第 2 段階で RCON の書き込み操作(kill・陣営変更など)を足すと audit_log に記録できない。そのときは CHECK の無い新しい操作ログ表への移行(旧表は読み取り専用で残す)を設計する。
- **M-7** AES-256-GCM の復号コスト(1 行あたり)の実測。15.3 の見込み(十数マイクロ秒)を本番の Workers で確認する。初期設定の登録し直し(5.1.1)では全サーバー分(最大 20 行)を復号する。

### キルフィード(9.6。将来の別タスク)

- **K-1** `WDServerFeed` の送信仕様(`Url + /api/ingest/events`、Bearer、約 2 秒ごとのバッチ、イベントは `killed` のみ)の真偽と本文の形式。接続・切断イベントが無いこと。
- **K-2** 受信エンドポイントの認証(サーバーごとのトークンの発行・保存・差し替え)と、ログイン Cookie・Origin 検査の対象外にする範囲。
- **K-3** 受信のリクエスト数(1 台で最大 43,200/日)と D1 の書き込みが無料枠に収まる方法(間引き・保存しない・集約)。
- **K-4** ゲームサーバーの設定ファイルに URL とトークンを入れる手順(設定の編集は第 2 段階)と、サーバーの提供元が設定を許すか。
- **K-5** 画面への届け方(30 秒ポーリング、または別の仕組み)と保持期間。

### 設計上の判断(ユーザー確認事項)

以下は 2026-10-15 にユーザーが「推奨どおり」で確定した(以後は決定事項として扱う)。

- **U-1(確定 → 2026-10-16 に置き換え)** D1 が無い・テーブルが無いときは書き込み操作を止める(既定 `AUDIT_REQUIRED="true"`)。→ D1 必須化で「D1 が無い・テーブルが無いときはログイン自体を止める」に置き換わった(7.4)。
- **U-2(確定)** セッションは 12 時間で失効し延長しない。ログイン失敗は接続元ごとに 15 分で 5 回までロック。全体ロックは行わない(第三者による締め出しを防ぐ)。
- **U-3(確定)** Steam ID はログイン後の画面で全桁表示する。監査ログは 365 日保持する。
- **U-4(確定)** 利用手順は「ボタンで複製(方法 A)」と「フォーク + ダッシュボードで取り込み(方法 B)」の 2 通りを README に残す。ボタンがリポジトリを複製する仕様のため、先にフォークしてからボタンを押すと 2 つできる可能性がある点は要確認のまま(C-5 系)。
- **U-5(確定)** IP アドレスしか無い運営者には「自前ドメイン推奨、第三者のワイルドカード DNS サービスは自己判断」と案内する(README 4.3 のまま)。

以下は 2026-10-16 の複数サーバー対応で architect が決めた点(ユーザー確認待ち。推奨どおりなら決定事項として扱う)。

- **U-6** 接続テストに失敗してもサーバーを保存する(結果は一覧に出す)。登録できる台数は 20 台まで。
- **U-7**(2026-10-16 に置き換え)Deploy ボタンのフォームを `ADMIN_PASSWORD` だけにする件 → Secrets を廃止し、フォームの入力は無くなった(U-11)。
- **U-8** 画面から登録したサーバーのホスト名・ポートは、ログイン済みの運営者には一覧に表示する(編集に必要なため。パスワードは表示しない)。
- **U-9** サーバー設定の変更ログは、操作ログ画面の別タブ「設定変更」に出す(D1 の制約で別テーブルのため、操作と同じ一覧には混ぜない)。操作ログの既定は全サーバー表示。
- **U-10**(2026-10-16 に不要)SESSION_SECRET を README で「推奨」に上げる件 → SESSION_SECRET ごと廃止(鍵は `instance_key`。5.1.2)。

以下は 2026-10-17 の画面構成(サイドバー + ヘッダータブ。9 章)で architect が決めた点(ユーザー確認待ち。推奨どおりなら決定事項として扱う)。

- **U-16** サイドバーの縦ナビとヘッダータブは同じ行き先を重複して持つ。要望どおり両方置き、幅 1024px 未満では縦ナビを出さない。ラベルは両方 `tabs.*` で揃える(タブ「概要」とナビ「状態」のような呼び名の違いを作らない)。推奨: このまま。重複が気になれば縦ナビを外す(`nav.ts` の 1 か所)。
- **U-17** モバイルのサイドバーはドロワーではなく、ヘッダー直下の折りたたみパネル(JS 無しでは常に開く)。キルフィードはタブだけ出し、押すと準備中の案内ページ(`/killfeed`)を開く。
- **U-18** サイドバーの状態(30 秒ごと)は BAN・操作ログ・設定タブでも動く。そのため Worker のリクエスト数が最大で約 2 倍になる(9.3。無料枠内)。推奨: このまま(どのタブでも人数と接続状態が見える方を優先)。

以下は 2026-10-16 の Worker Secrets 廃止に関するもの。U-11 はユーザー決定、U-12 以降は architect が決めた点(ユーザー確認待ち。推奨どおりなら決定事項として扱う)。

- **U-11(確定)** Worker Secrets を使わない。管理パスワードは `/setup` で登録して D1 にハッシュで保存し、RCON パスワードは D1 に暗号化して保存する。鍵と暗号文が同じ D1 にあるため、D1 を読める相手には RCON パスワードが復号できること(12 章)を受け入れる。
- **U-12** vars `AUDIT_REQUIRED` を削除する(D1 必須化で効果が無くなったため。現在は `@deprecated` で値を読まない)。推奨: 削除。残すと README・`wrangler.jsonc` に意味の無い設定が残り、非エンジニアを迷わせる。
- **U-13** PBKDF2 の反復回数は 1 万回(5.2)。目安の 10 万回は無料プランの CPU 上限を大きく超えると実測したため。本番で余裕が確認できたら引き上げる(C-20)。
- **U-14** 初期設定の乗っ取り(デプロイ直後に第三者が先に登録する)の対策は README の案内(すぐ登録する、先に登録されていたら `admins` を消してやり直す)と `admin_register` の記録だけにし、ワンタイムコード等の仕組みは入れない(5.1.1)。
- **U-15** 初期設定の後は自動ログインせず、ログイン画面に進ませる(5.1.1)。管理パスワードと RCON パスワードの同一値は、警告ではなく入力時に拒否する(5.2)。

## 15. 複数サーバー

2026-10-16 ユーザー要望: 「自分が持っているサーバーの数だけ追加できるようにしてほしい。DB にホスト名とポート番号を置き、環境変数がわからない人でも触れるように」。本章が正本で、8・10 章などの該当箇所は本章を参照する。同日の Worker Secrets 廃止(第 5 章・第 16 章)で、Secrets による既定サーバーと暗号鍵の 2 系統を削除した。

### 15.1 方針

- サーバーはすべて画面 `/servers` から追加し D1 `servers` に保存する(**登録サーバー**)。Secrets(`RCON_URL` / `RCON_PASSWORD`)による「既定サーバー」は 2026-10-16 の Worker Secrets 廃止で削除した(15.4)。
- 画面から入力するのは「表示名 / ホスト名 / ポート / RCON パスワード」の 4 項目だけ。Cloudflare のダッシュボードで環境変数を触らずにサーバーを足せる。
- 一度に扱うのは**選択中の 1 台**だけ。全サーバーへの一括操作(全台に broadcast など)や一覧画面での全台同時表示はしない(第 2 段階。サブリクエスト・RCON 呼び出しが台数倍になるため)。

### 15.2 データモデル

テーブル定義は `db/migrations/0002_servers.sql`(8 章に要約)。サーバーの識別子は API・URL・Cookie では文字列の `ServerId`(`servers.id` の 10 進)に統一し、D1 では次のように対応させる。

| 場面 | 登録サーバー(例 id 3) |
|---|---|
| API・URL のクエリ・Cookie・セレクトの値(`ServerId`) | `"3"` |
| `audit_log.server_id`(書き込み操作の行) | `3`(NULL は 0002 以前の行 = 対象不明。API では `serverId: null`) |
| `audit_log.server_id`(login / logout の行) | 常に `NULL`(サーバーに関係しない) |
| `server_snapshots.server_id` | `3` |
| `settings_audit_log.server_id` | `3`(`admin_register` は NULL) |

決定と根拠:

1. **`status_snapshots` は ALTER せず、複合主キーの新テーブル `server_snapshots`(`PRIMARY KEY (server_id, bucket)`)に切り替える**。旧表は `bucket` 単独が主キーのため、列を足しても同じ 5 分枠に 2 台目の行が入らない(`INSERT OR IGNORE` で捨てられる)。作り直しは本番稼働中のため不可。旧表は以後書かず、既存の掃除(90 日)で自然に空になる。旧表の行は新表へコピーしない(履歴グラフは未実装で読む画面が無く、どのサーバーの行かも分からないため)。
2. **`server_snapshots.server_id` は NOT NULL**。SQLite の主キー(rowid 表)は `NULL` 同士を別物として扱い、`INSERT OR IGNORE` の重複判定が効かないため。`0` は旧「既定サーバー」用に予約していた値で、現在は使わない。
3. **サーバー設定の変更ログは別テーブル `settings_audit_log`**。`audit_log.event` の CHECK 制約は SQLite では ALTER できず、表の作り直しは禁止。代替案の検討: (a) `PRAGMA writable_schema` で CHECK を書き換える → D1 では使えない前提で、破損の危険もあるため不採用、(b) 既存の event 値(`login` 等)に相乗りして params で区別する → ログの意味が壊れ、CHECK の保護も無意味になるため不採用、(c) CHECK 無しの新しい汎用監査表に全面移行 → 既存行の移行が必要で範囲が大きいため不採用。`settings_audit_log.event` には CHECK を付けず、コード側の `SETTINGS_EVENTS` で検証する(今後の設定イベント〔`admin_register` 等〕をマイグレーション無しで足せるようにするため)。拒否と接続テストも記録する(QA M-2): `server_update_rejected`(宛先変更での `reenter_required`。保存済みパスワードの持ち出しの試行)、`server_delete_rejected`(`confirmName` 不一致)、`server_test`(保存済みのパスワードを外へ送る操作。`params.result` に `ok` / `RCON_*`)。表に status 列は足さず、API が event と params から `status`(`succeeded` / `failed`)と `errorCode` を決める(docs/API.md 3 章)。D1 への変更と変更ログの INSERT は `db.batch()` で 1 トランザクションにする(片方だけ残らない。M-2)。
4. **`servers.id` は AUTOINCREMENT**(削除した id を再利用しない)。`audit_log.server_id` / `server_snapshots` / `settings_audit_log` が削除後も古い id を指すため、別のサーバーが同じ id を引き継ぐと履歴が混ざる。
5. **外部キーは張らない**。削除後もログは残すため。
6. **削除は行の物理削除**(暗号化済みパスワードも消える)。ログ・スナップショットは残し、各ログに残した `server_name` で後から読める。スナップショットは 90 日の掃除に任せる(削除時に消すと最大 2.6 万行の書き込みになるため)。
7. **`audit_log` に `server_name` 列も足す**。サーバーを改名・削除した後も、操作ログの「どのサーバーか」が読めるようにする(`target_name` と同じ考え方)。
8. 一意性: 表示名(`idx_servers_name`)と、`(scheme, host, port)`(`idx_servers_endpoint`)。重複は 400 `VALIDATION_FAILED`(`fields.name` / `fields.host` = `duplicate`)。

#### 入力の検証(ホスト名・ポート)

`parseRconUrl` と同じ規則を使う(6.1)。手順:

1. ホスト名: 前後の空白を除き小文字にする。末尾の `.` は除く。1〜253 文字。空白・`/` `?` `#` `@` `:` `[` `]` `\` を含めば `invalid_format`(`http://` やポートまで貼り付けた入力もここで弾く。画面は「ホスト名だけを入力」と案内する)。
2. ポート: 1〜65535 の整数。数値でなければ `invalid_format`、範囲外・小数は `out_of_range`。
3. `parseRconUrl()` に `"http://" + ホスト名 + ":" + ポート` を渡す。IP アドレス → `ip_address`、形式不正・認証情報付き → `invalid_format`。成功したら `new URL()` が正規化した `hostname`(国際化ドメイン名は punycode)を保存する。`parseRconUrl` の失敗理由は内部の判定値(旧 `SetupWarning` の `RCON_URL_*` から外したため、backend が `config.ts` などに局所的な型を持つ)。
4. 表示名: 前後の空白を除いて 1〜32 文字(コードポイント)、改行・制御文字不可(`invalid_characters`)。
5. パスワード: 1〜256 文字。管理パスワードと同じなら `same_as_admin_password`(5.2。管理者のハッシュで検証する)。24 文字未満は保存できるが一覧で `passwordShort`。

### 15.3 RCON パスワードの暗号化

2026-10-16 に単純化した(鍵を `instance_key` の 1 系統にし、`s` / `a` の 2 系統・自動再暗号化・Secrets 変更時の再入力を廃止)。

| 項目 | 決定 |
|---|---|
| 方式 | AES-256-GCM(Web Crypto)。IV は 12 バイトの乱数を毎回生成 |
| 鍵 | `HKDF-SHA256(ikm = instance_key, salt = "wardogs-ops/v1", info = "server-password")` で AES-GCM 256 bit 鍵を派生(`extractable: false`。5.1.2) |
| 保存形式 | `v2.<iv>.<ct>`。`iv` は 12 バイト、`ct` は Web Crypto の出力(暗号文 + 認証タグ 16 バイト)。いずれも base64url(パディング無し)。最大約 400 文字。旧形式 `v1.<k>.<iv>.<ct>` はどこにも保存されていない(0002 が本番未適用のため)ので読まない |
| 追加認証データ(AAD) | `UTF-8("wardogs-ops/server-password/v2|" + scheme + "://" + host + ":" + port)`。暗号文を別の行(別の宛先)にコピーしても復号できない(15.6 のパスワード持ち出し対策と同じ考え方) |
| 復号の失敗 | 形式不正・GCM の認証失敗。**通常は起きない**(管理パスワードの変更・登録し直しでは鍵が変わらないため)。起きるのは `settings` の `instance_key` を手で消した・書き換えた場合や、行を手で編集・コピーした場合だけ。その行は `needsPassword: true` として一覧に出し、そのサーバーへの読み取り・操作は 409 `SERVER_NEEDS_PASSWORD`。1 台でもあれば警告 `SERVER_PASSWORDS_UNREADABLE`(ログインは止めない)。パスワードを入れ直せば解消する |
| 平文の扱い | 平文は RCON への fetch の直前、または管理パスワードとの同一判定(5.1.1)のときにメモリ上でだけ復号する。API 応答・ログ・エラーに出さない。保存後に画面へ返さない(編集時は「変更しない場合は空欄」) |

根拠:

1. 鍵を管理パスワードから独立させたので、パスワード変更のたびに全サーバーのパスワードを入れ直す手間(旧 15.3 の表)が無くなる。
2. 復号失敗の扱い(`needsPassword`)を残すのは、手作業の誤操作・データ破損で起きたときに、表示名・ホスト名・ポートを残したまま復旧できるようにするため(画面・API は複数サーバー対応で実装済み)。
3. 脅威の整理は 12 章(鍵と暗号文が同じ D1 にあるため、D1 を読める相手には復号できる)。
4. CPU: AES-GCM の復号は 1 行あたり十数マイクロ秒程度の見込みで、一覧(最大 20 行)でも無料プランの 10 ms/リクエストに影響しない。鍵の派生は isolate 内でキャッシュする(5.1.2)。

### 15.4 サーバー 0 台と設定の判定

- **既定サーバーは廃止**(2026-10-16)。`ServerId` の `"default"`、`ServerSummary` の `source` / `secretsIssue`、`ServersResponse` の `manageable`、エラー `SERVER_READ_ONLY` / `SERVERS_UNAVAILABLE`、警告 `RCON_URL_*` / `RCON_PASSWORD_*` を削除した。
- ログインを止めるのは D1 の不備と管理者の未登録だけ(7.4、5.1.1)。
- **サーバーが 0 台**でもログインできる。状態・プレイヤー・BAN の画面は「サーバーを追加してください」の案内と `/servers` へのリンクを出し、RCON を呼ぶ API は 409 `NO_SERVERS`。

### 15.5 サーバーの選択と切り替え

ページでの決め方(上から順に、見つかった時点で決定):

1. クエリ `?server=<ServerId>`。形式が `SERVER_ID_PATTERN`(`servers.id` の 10 進)に合い、そのサーバーがあればそれ。**指定されたのに無い(削除済み等)・形式不正なら、ほかのサーバーに切り替えずに「見つかりません」(`SERVER_NOT_FOUND`)を表示する**(別のサーバーを操作してしまう取り違えを防ぐため)。
2. Cookie `__Host-wo_server`(開発時は `wo_server`)。指す先が無ければ無視して Cookie を消す。
3. 表示順で最初の `usable` なサーバー。
4. それも無ければ表示順の先頭(使えない理由を表示)。0 台なら 15.4 の案内。

- 1 で決まったときは、ページの応答で Cookie を発行する(`HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=2592000`〔30 日〕。開発時は `Secure` なし)。**署名しない**: 値はサーバーの id だけで、毎回 D1 と照合する。書き換えられてもログイン済みの人が元々使えるサーバーに切り替わるだけで、署名しても守るものが無い。ログアウト時に消す。
- **サイドバーの最上部**にサーバーのセレクト(有効なサーバー。`needsPassword` は印を付けて表示)と「サーバーを追加」リンク(9.2。2026-10-17 にヘッダーから移した)。JS 無しでも動くよう、`?server=` を送る GET フォーム + 送信ボタンにする(JS があれば選択で即送信)。現在のパスを保つ。モバイル幅では折りたたみパネルの中に入る(9.5)。
- ヘッダータブ・サイドバーの縦ナビ・アプリ名のリンクには `?server=<現在の id>` を付ける(複数タブで別々のサーバーを開いていても、Cookie の書き換えで他のタブが別サーバーに変わらないように)。
- サイドバーのサーバーカード(9.2・9.3)は選択中のサーバーを表す。切り替えはページ遷移なので、カードとメインが別のサーバーを指すことは無い。
- React アイランドは選択中の `serverId` を props で受け取り、**すべての API 呼び出しに明示して送る**。切り替えはページ遷移(全体の再読み込み)で行い、アイランド内の状態を持ち越さない。`/api/status` の共有ストア(9.3)もサーバー id ごとに分ける。

API での決め方:

- GET はクエリ `server`、POST は本文の `server`。
- 読み取り API(`status` / `players` / `bans` / `maps` / `capabilities`)で `server` が無い場合は、Cookie → 最初の `usable` の順で決める(更新前から開いていたタブとの互換のため)。
- **書き込み(`actions/prepare` / `actions/execute`)は `server` 必須**(無ければ 400 `VALIDATION_FAILED`、`fields.server = required`)。
- 形式不正は 400(`fields.server = invalid_format`)、無い → 404 `SERVER_NOT_FOUND`、無効 → 409 `SERVER_DISABLED`、復号不可 → 409 `SERVER_NEEDS_PASSWORD`、0 台 → 409 `NO_SERVERS`。

### 15.6 RCON 呼び出し・確認トークン・キャッシュ(サーバーごと)

- **サーバーの解決**: RCON を呼ぶ API は毎回 D1 から対象の 1 行を主キーで読み、復号して `RconConfig`(`baseUrl`、`password`)を作る。**isolate 内にサーバー設定をキャッシュしない**(削除・無効化・パスワード変更を、別の isolate でも即時に効かせるため。D1 の読み取り 1 行/リクエストは無料枠に十分収まる)。
- **確認トークン**(4.3、`src/lib/confirm.ts`): payload に `sv`(ServerId)と `sh`(`SHA-256(baseUrl)` の先頭 128 bit の base64url)を追加して署名する。execute の検証は「1 署名・形式 → 2 セッション一致 → 3 action と params のハッシュ → **3' `sv` が本文の `server` と一致し、`sh` が現在の baseUrl と一致** → 4 期限」。3' の不一致は 400 `CONFIRM_INVALID`(4.3 の規則どおり監査ログに 1 行残す)。`sh` を含めるのは、prepare から execute までの 120 秒の間にサーバーのホスト名・ポートが変更された場合に、確認画面で見た宛先と違う宛先へ実行しないため。デプロイ前に発行された `sv` 無しのトークンは `CONFIRM_INVALID`(有効期間 120 秒のため実害は小さい)。
- execute の時点でもサーバーを解決し直し、無い・無効・復号不可なら `SERVER_*` で拒否する(監査ログに `status=failed`・`error_code` 付きで 1 行残す。`CAPABILITY_MISSING` と同じ扱い)。
- **監査ログ**: 書き込み操作の行に `server_id` と `server_name`(その時点の表示名)を残す。`recordRejected` も同じ。
- **capabilities のキャッシュ**(6.4): 単一のキャッシュを、キー `${serverId}|${baseUrl}` の Map に変える(最大 `MAX_SERVERS` 件。超えたら古いものから捨てる)。`?refresh=1` の 1 分 1 回の制限もサーバーごと。`RCON_ROUTE_NOT_FOUND` を受けたとき・そのサーバーの更新・削除・接続テストのときは、そのサーバーの分だけ破棄する。
- **人数スナップショット**(4.4): `server_snapshots` に `(server_id, bucket)` で `INSERT OR IGNORE`。isolate 内の「記録済み bucket」もサーバーごと(Map)。記録されるのは誰かが画面で開いているサーバーだけ。
- **BAN 一覧の名前補完・unban の対象名**(`knownBanNames` / `lastKnownName`): サーバーで絞らず全サーバーの監査ログから引く(Steam ID は全サーバー共通で、名前の手掛かりとして有用なため)。
- **接続テスト**: RCON `GET /v1/status`(タイムアウト 5 秒、6.2 の fetch 方針どおり)。成功なら RCON のサーバー名と人数を返す。結果は `servers.last_test_at` / `last_test_result` に保存する。同じサーバーへのテストは isolate 内で 5 秒に 1 回まで(超えたら 429 `RATE_LIMITED`)。
- **保存は接続テストに失敗しても行う**。根拠: ゲームサーバーが停止中・再起動中だったり、ポート開放を後から行ったりすることがあり、テスト成功を保存の条件にすると設定の順序を強制してしまう。結果は応答と一覧に出し、失敗の理由(`RCON_*` のコード)ごとに対処を案内する。
- **ホスト名・ポートを変えるときはパスワードの再入力を必須にする**(`fields.password = reenter_required`)。根拠: ログイン Cookie を盗んだ者が宛先だけを自分のサーバーに書き換え、保存済みのパスワードを `Authorization: Bearer` で受け取る(パスワードの持ち出し)ことを防ぐ。AAD に宛先を含めているため、再暗号化の点でも新しいパスワードが必要になる。
- 接続先の安全性: 登録できるのはログイン済みの運営者だけ。宛先の規則は 6.1(IP 直指定不可、認証情報不可)。リダイレクトは追わない(6.2)ので、Bearer が登録した宛先以外に送られることは無い。

### 15.7 画面 `/servers`

- ログイン後のナビゲーションに「サーバー設定」を追加する(2026-10-17 以降はヘッダータブの「設定」と、サイドバーの縦ナビの「サーバー設定」。9.2・9.4)。
- 一覧: 表示名、ホスト名:ポート、有効 / 無効、直近の接続テストの結果と時刻、「パスワードの再入力が必要」「パスワードが短め」の表示、操作(編集・接続テスト・有効化/無効化・削除)。
- 追加・編集フォーム: 表示名 / ホスト名 / ポート / RCON パスワード の 4 項目だけ。編集時のパスワード欄は空(「変更しない場合は空欄」。ホスト名かポートを変えたときは必須)。保存すると接続テストの結果を表示する。
- 削除: 確認ダイアログで表示名を入力させ、`confirmName` として送る(Worker で現在の表示名と照合)。削除と変更ログは同じトランザクション。
- D1 必須化(7.4)により、ログインできていれば常に追加・変更・削除できる(旧 `features.servers` / `SERVERS_UNAVAILABLE` の表示は削除)。
- 操作ログ(`/audit`)は「操作」(audit_log)と「設定変更」(settings_audit_log)を切り替えるタブにする(`kind`)。「操作」はサーバーで絞り込める(既定は全サーバー。`server=all`)。各行にサーバー名を出す。

### 15.8 段階的有効化(7.4)との関係

D1 必須化(2026-10-16)で、登録サーバーが使えない段階は無くなった。D1 の不備・管理者の未登録の間はログインできず、ログインできれば登録サーバーの管理も使える。

- D1 の判定(`probeD1`)は、0002 で作った表・列(`audit_log.server_id` / `server_name`、`servers`、`server_snapshots`、`settings_audit_log`、`admins`、`settings`)と 0001 の `login_throttle` をすべて参照する 1 文で行い、失敗したら `not_migrated`。根拠: `deploy` は「`wrangler deploy` → マイグレーション」の順(C-5)で、新しいコードが 0002 より一瞬先に動く。その間に 0002 の表への書き込みが失敗して `INTERNAL_ERROR` になるより、`/setup` の案内で止める方が安全(fail closed)。
- `Features` はすべて true(`servers` は削除)。

### 15.9 無料枠への影響(11 章への追加)

- Worker リクエスト: 変わらない(画面が叩くのは選択中の 1 台分だけ)。`/servers` は一覧 1 回 + 必要なときの接続テスト。
- サブリクエスト: RCON を呼ぶ API はサーバーの解決で D1 読み取りが 1 回、ログイン Cookie の検証(5.3)で 1 回増える。`/api/status` は最大 7(RCON 3〔status・capabilities・rotation。9.3〕+ D1 判定 1 + 管理者 1 + サーバー 1 + スナップショット 1)、`/api/actions/execute` は 5〜6。いずれも 50 / 同時 6 に収まる。
- D1 書き込み: スナップショットは「開いているサーバー 1 台につき 5 分に 1 行」。全 20 台を 24 時間開き続けた最悪でも `20 × 288 = 5,760` 行/日(インデックス更新を含めて約 1.2 万行、上限の 12%)。設定変更・接続テストは 1 回 1〜2 行。
- D1 読み取り: 管理者 1 行 + サーバーの解決 1 行/リクエスト、一覧は最大 20 行。500 万行/日に遠い。
- ストレージ: `servers` は 1 行 1 KB 未満。

### 15.10 モック RCON(仕様。実装は backend)

- 環境変数 `MOCK_RCON_PORTS`(カンマ区切り。例 `7776,7777`)で、1 つのプロセスが複数のポートで待ち受ける。ポートごとに状態(プレイヤー・BAN)を独立に持ち、サーバー名は `Mock Server <ポート>` にする(画面でどちらに繋がっているか見分けるため)。
- 従来の `MOCK_RCON_PORT`(1 つ)はそのまま使える(`MOCK_RCON_PORTS` が優先)。パスワードは全ポート共通で `MOCK_RCON_PASSWORD`(既定は公開のダミー値)。ポートごとに変えたい場合は `MOCK_RCON_PASSWORDS`(カンマ区切り、`MOCK_RCON_PORTS` と同じ順)。
- 別の方法として `MOCK_RCON_PORT` を変えて `pnpm mock:rcon` を 2 回起動してもよい(現状のままで可能)。
- ローカルでは `/servers` から ホスト名 `localhost`・ポート `7777` などで追加する(`127.0.0.1` は IP 直指定のため不可)。README・テストに書く値はダミーのみ。

### 15.11 多言語化(13 章との関係)

- architect がカタログに足したもの(型で必須のため): `error.SERVER_*` / `error.NO_SERVERS`、`validation.out_of_range` など 6 つ、`setup.warning.SERVER_PASSWORDS_UNREADABLE`、`audit.event.server_add` / `server_update` / `server_delete`。
- frontend-pages が足すもの: `nav.servers`、`servers.*`(一覧・フォーム・削除確認)、`header.server*`(セレクト。2026-10-17 に `sidebar.switcher.*` へ移す。13.8)、`field.name` / `field.host` / `field.port` / `field.password` / `field.server` / `field.confirmName`、`audit.kind.*`・`audit.serverFilter.*`、`audit.param.*`(設定変更の内容)、確認ダイアログのサーバー名表示。
- 運営者が入力した表示名・ホスト名は翻訳しない(13.1 の「翻訳しないもの」に含める)。
- Secrets 廃止に伴うカタログの変更は 16.3。

### 15.12 実装の分担

複数サーバー対応の実装(2026-10-16、コミット 1f35328 / 36c58f9)は完了。既定サーバーの削除などの追従は第 16 章。

## 16. Worker Secrets の廃止(2026-10-16)— 変更点と実装の分担

本章は第 5 章・7.4・8 章・10 章・15 章の変更をまとめた引き継ぎ用。契約(`src/types/*`、`db/migrations/0002_servers.sql`、`db/schema.sql`、`docs/API.md`)は architect が確定済み。`pnpm check` は実装が追従するまで失敗する(下記の削除による型エラー)。

### 16.1 契約の変更(architect、済み)

- `src/types/env.ts`: `OpsEnv` から `ADMIN_PASSWORD` / `RCON_URL` / `RCON_PASSWORD` / `SESSION_SECRET` を削除。`AUDIT_REQUIRED` は `@deprecated`(効果なし)。`REQUIRED_SECRETS` / `LOGIN_REQUIRED_SECRETS` / `DEFAULT_SERVER_SECRETS` / `SESSION_SECRET_MIN_LENGTH` を削除。`ADMIN_PASSWORD_MIN_LENGTH` は `src/types/api.ts` へ移動。追加: `PASSWORD_HASH_*`、`INSTANCE_KEY_BYTES`、`SESSION_STAMP_BYTES`、`SETTINGS_KEYS`。
- `src/types/api.ts`: 追加 `SETUP_REQUIRED`(503)、`SETUP_FORM_ERRORS` / `SetupFormError` / `SETUP_FORM_ERROR_STATUS`、`ADMIN_PASSWORD_MIN_LENGTH` / `ADMIN_PASSWORD_MAX_LENGTH`、`SETTINGS_EVENTS` に `admin_register`。削除 `SERVER_READ_ONLY` / `SERVERS_UNAVAILABLE`、`DEFAULT_SERVER_ID`、`ServerSource`、`ServerSummary.source` / `secretsIssue`、`ServersResponse.manageable`、`Features.servers`、`SetupWarning` の Secrets 系と `AUDIT_DISABLED_WRITES_ALLOWED`。`SERVER_ID_PATTERN` から `default` を除外。`ServerSummary` の `name` / `host` / `port` / `createdAt` / `updatedAt` を非 null に。複数サーバー対応で「実装後に必須化」としていた `?`(`AuditResponse.kind`、`AuditEntry.serverId` / `serverName`、`PrepareRequest.server`、`PrepareResponse.server`、`ExecuteRequest.server`、`ExecuteResponse.server`)を外し、`ExecuteResponse.auditId` を非 null に。
- `db/migrations/0002_servers.sql`: `admins`・`settings` を追加し、`rcon_password_enc` の形式を `v2` に(8 章)。
- 削除: `.dev.vars.example`。`package.json` の `cloudflare.bindings` は `DB` だけ。`wrangler.jsonc` のコメント。
- カタログ・`DEV_MESSAGES`: 16.3。

### 16.2 backend

- `src/lib/keys.ts`: `instance_key` の取得(`INSERT OR IGNORE` → `SELECT`、5 分キャッシュ)と HKDF の派生(`session` / `confirm` / `ip-hash` / `server-password`)。`password-compare`、`ServerKeyId`、`ServerPasswordKeys`、`getServerPasswordKeys` の 2 系統を削除。鍵の取得は D1 が要るので `getKeys(env)` → `getKeys(db)` 等にシグネチャが変わる。
- `src/lib/password.ts`: PBKDF2 のハッシュ化・検証・保存形式の解析・回数の引き上げ判定(5.2)。
- 新規(名前は任意。例 `src/lib/admins.ts`): 管理者の有無・取得、条件付き登録(5.1.1)、`admin_register` の記録、ハッシュの保存し直し。
- `src/lib/session.ts`: Cookie `v2`(`aid` と `session_stamp`。5.3)。
- `src/lib/config.ts`: Secrets の検証・`checkConfig`・`getDefaultServerState`・`auditRequired`・`BLOCKING` を削除。`probeD1` に `admins` / `settings` を追加。`getFeatures` はすべて true(D1 が `ok` のとき)。`collectWarnings` は `LOGIN_FAILURES_HIGH` / `SERVER_PASSWORDS_UNREADABLE` のみ。`parseRconUrl` の失敗理由は局所的な型に。
- `src/middleware.ts`: 「D1 の判定 → CSRF → 管理者の有無 → Cookie → ヘッダ」(5.7)。`/setup` は D1 不備・未登録のときだけ中身を出し、登録済みなら `/login` へ。
- `src/pages/setup.astro`(POST の処理)・`src/lib/auth.ts`: 登録(5.1.1)とログイン(4.1、5.2)。`not_configured` の結果は D1 不備と未登録に分ける。
- `src/lib/throttle.ts`: D1 が無い場合のメモリ近似(`MemoryThrottleStore` を D1 の代わりに使う経路)を削除。global の上限超のメモリ近似は残す。
- `src/lib/servers.ts`: 既定サーバー(`DEFAULT_SERVER_ID`、Secrets、`SERVER_READ_ONLY`、既定サーバーの `lastTest` のメモリ)を削除。暗号化を `v2`(1 系統、AAD の接頭辞 `v2`)に。自動再暗号化を削除。`same_as_admin_password` は管理者のハッシュで検証(5.2)。`SERVERS_UNAVAILABLE` / `manageable` を削除。
- `src/lib/audit.ts`: `server_id` が NULL の書き込み行は `serverId: null`(`'default'` にしない)。`?server=default` は形式不正(400)。`settings` の一覧に `admin_register` を含める。
- `src/lib/actions.ts`: `auditId` は常に number。D1 無しの書き込み(`AUDIT_REQUIRED="false"`、確認トークンのメモリ近似)を削除。
- `src/lib/runtime.ts`・`src/layouts/page-context.ts`・`src/pages/servers.astro`・`src/pages/api/servers/index.ts`: `features.servers` / `manageable` の参照を削除。
- `src/lib/http.ts`: `DEV_MESSAGES.NOT_CONFIGURED` の文言を「D1 unavailable or not migrated」に直す(architect は追加・削除のみ行った)。
- `src/lib/testing/sqlite-d1.ts` とテスト: Secrets を env に入れているテスト(`config.test.ts`、`servers.test.ts`、`session.test.ts`、`actions.test.ts`、`throttle.test.ts`、`validate.test.ts`)を、D1 の `admins` / `settings` を使う形に書き換える。PBKDF2 のテストは回数を小さくできるよう、回数を引数で受け取る関数にしておく。
- `scripts/mock-rcon.mjs`: コメントの `RCON_PASSWORD` の記述を「`/servers` で入力するパスワード」に直す(動作は変えない)。

### 16.3 frontend-pages

- `/setup` の画面(9.1)。既存の `setup.intro` / `setup.missingTitle` / `setup.readme` / `setup.configured` / `setup.toLogin` 等は Secrets 前提の文言なので、登録フォーム用に作り直す(カタログのキーの追加・削除は frontend-pages)。`setup.error.*`(architect が追加済み)を使う。
- `/login`: `?registered=1` のときの案内。
- `/servers`・ヘッダー・各アイランド: 既定サーバーの表示(`server.defaultName`、`server.unusable.secrets`、`servers.endpointHidden`、`servers.state.secretsIssue`、`servers.state.readOnly`、`servers.unavailableHelp`)と `source` / `secretsIssue` / `manageable` / `features.servers` / `error.SERVERS_UNAVAILABLE` の参照を削除。
- 操作ログ: `serverId: null` の書き込み行は「不明」、`admin_register` の行(「設定変更」タブ)。
- architect がカタログで変えたもの: 追加 `error.SETUP_REQUIRED`、`setup.error.*`(6 つ)、`audit.event.admin_register`。削除 `error.SERVER_READ_ONLY`、`error.SERVERS_UNAVAILABLE`、`setup.warning.*` の Secrets 系 10 個と `AUDIT_DISABLED_WRITES_ALLOWED`。文言の変更(意味が変わったため)`error.NOT_CONFIGURED`、`validation.same_as_admin_password`、`setup.warning.D1_MISSING` / `D1_NOT_MIGRATED` / `LOGIN_FAILURES_HIGH` / `SERVER_PASSWORDS_UNREADABLE`。

### 16.4 architect(残り)

- README の 1〜6 章の詳細(見出しと概要は済み)を、frontend の `/setup` 完成後に画面の文言に合わせて書く。
- `AUDIT_REQUIRED` の削除(U-12 の確認後)。
