# wardogs-ops 構成(正本)

作成日: 2026-10-15(JST)/ 更新: 2026-10-17(キルフィード第 2 段階: 正規化・保存・集計・画面、17.10・8.14。第 1 段階の契約は変えず追加のみ)、2026-10-17(スコア記録とキルフィードの観測モード、第 17 章。Cron の同居、受信エンドポイントの認証の例外 5.8)、2026-10-17(画面構成をサイドバー + ヘッダータブに。第 9 章・13.8・15.5)、2026-10-16(複数サーバー対応、第 15 章。Worker Secrets の廃止、第 5 章・第 16 章)/ 担当: architect
上位の正本: `docs/PLAN.md`(2026-10-15 改訂版)。契約: `docs/API.md`、`src/types/api.ts`、`src/types/env.ts`、`db/schema.sql`、`db/migrations/`、`wrangler.jsonc`。
RCON の仕様は非公式資料ベース(`docs/research/wardogs-rcon.md`)。本書の「未検証」「要確認」は第 14 章の番号(R-n / C-n / I-n / M-n / K-n / U-n)で参照する。

## 1. 目的と設計目標

- 任意の WARDOGS コミュニティサーバー運営者が、**フォーク(またはボタンで複製)→ Deploy to Cloudflare → パネルの URL を開いて管理パスワードを登録(`/setup`)→ サーバー側で RCON を有効化 → パネルの画面でサーバー(ホスト名・ポート・RCON パスワード)を追加** だけで使える運営パネル。**Cloudflare 側で Secrets・環境変数を入力する手順は無い**(2026-10-16。第 5 章)。サーバーは何台でも追加できる(上限 20 台。第 15 章)。
- 運営者 1〜数人が 1 つの管理パスワードを共有して使う規模を想定する。アカウント管理・権限分離はしない(D1 `admins` は将来に備えて複数行を許す形だけ用意する。8.7)。
- Cloudflare 無料プラン(Workers / D1)の範囲で動かす。KV・R2・Access・Tunnel は使わない(第 2 段階の選択肢は 12 章)。Cron は 1 本だけ使う(1 分ごと。スコア記録。2026-10-17、第 17 章)。
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
  ├─ /api/*: 読み取り(status / players / bans / maps / capabilities / audit / session / servers / matches / feed/raw)
  │          書き込み(actions/prepare → actions/execute の二段階。スコア記録の開始・停止を含む)、サーバー設定(servers の追加・変更・削除・接続テスト・受信用トークン)
  ├─ /api/ingest/events: キルフィードの受信(ゲームサーバーから。ログイン・CSRF 検査の対象外、サーバーごとの受信用トークンで認証。17.6)
  ├─ scheduled(Cron、1 分ごと): 記録中のサーバーだけ RCON の status / players を取りサンプルを保存(17.3)
  ├─ D1「DB」(必須): admins / settings(instance_key)/ servers / audit_log / server_snapshots / login_throttle / settings_audit_log
  │                  / match_recordings / match_samples / server_feeds / feed_raw_events / feed_daily(0003)
  └─ fetch(選択中のサーバーへ。Authorization: Bearer <そのサーバーの RCON パスワード>、タイムアウト付き、リダイレクト非追従)
        │  平文 HTTP(C-1 要確認)。送信元 IP は固定されない(C-3)
        ▼
     RCON HTTP API(http://<ホスト名>:<ポート>。D1 servers に登録。IP アドレス直指定は不可)
     ゲームサーバー側: ServerSettings.ini の [/Script/WDRCON.WDRCONSettings](R-3, R-4 要確認)

ゲームサーバー(WDServerFeed。設定した場合のみ)
  │  POST https://<パネルのホスト名>/api/ingest/events(Authorization: Bearer <受信用トークン>。約 2 秒ごと。K-1 要確認)
  ▼
Cloudflare Worker「wardogs-ops」の /api/ingest/events(上と同じ Worker)
```

ブラウザが RCON を直接叩くことはない。RCON パスワード(D1 の暗号文とその平文)、管理パスワードのハッシュ、`instance_key` と派生した鍵はブラウザに一切渡らない(クライアントバンドル・HTML・API 応答のいずれにも含めない)。画面から登録したサーバーのホスト名・ポートだけは、編集のためにログイン済みの運営者に表示する(15.2)。Worker Secrets は使わない(第 5 章)。

## 3. 技術構成とディレクトリ

| 項目 | 採用 | 根拠 |
|---|---|---|
| フレームワーク | Astro 7(`astro@^7.3.8`)+ `@astrojs/react@^7.0.1` + React 19 | 参考実装(`../wardogs.gmkz.jp`)と同系列。`@astrojs/cloudflare@14` の peer が `astro ^7.2.0` のため Astro 7 系になる(エージェント定義の「Astro 5 系」とは異なる。司令塔に報告済み) |
| アダプタ | `@astrojs/cloudflare@^14.3.4`、`output: 'server'` | 全ページにログイン判定を掛けるため、静的ページは作らない(静的アセットは middleware を通らない) |
| セッション機能 | Astro Sessions は無効(`session: false`) | 有効だと KV「SESSION」が自動作成される。KV 書き込み 1,000/日の枠と自動プロビジョニングの対象を増やさない |
| 画像 | `imageService: 'passthrough'` | Images バインディング・sharp を要求しない |
| Worker 設定 | `wrangler.jsonc`(`name: wardogs-ops`、`main: ./src/worker.ts`、`workers_dev: true`、`preview_urls: false`、`compatibility_date: 2026-09-01`、`nodejs_compat`、`triggers.crons: ["* * * * *"]`) | 2024-09-02 以降で `allow_custom_ports` が既定有効(7776 等への fetch)。`main` と Cron は 17.4 |
| D1 | `database_id` 省略の自動プロビジョニング(`database_name: wardogs-ops-db`) | wrangler 4.45.0 以上(open beta)。本リポジトリは 4.151 |
| パッケージ管理 | pnpm 10 | 参考実装と同じ |

```
/
├─ astro.config.mjs / wrangler.jsonc / tsconfig.json / package.json
├─ db/
│  ├─ schema.sql              # 現行スキーマのまとめ(参照用)
│  └─ migrations/0001_init.sql, 0002_servers.sql(複数サーバー・管理者・設定)、0003_recordings.sql(スコア記録・キルフィード。8 章・17.1)
├─ docs/                      # PLAN / ARCHITECTURE / API / research
└─ src/
   ├─ env.d.ts                # Cloudflare.Env と App.Locals の型付け
   ├─ worker.ts               # Worker のエントリ(fetch は Astro の handle に委譲、scheduled = Cron。17.4)
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
   │  ├─ recordings.ts        # スコア記録の開始・停止・終了・サンプル・一覧(17.2・17.5)
   │  ├─ cron.ts              # scheduled の本体(17.3・17.7)
   │  ├─ feed.ts              # キルフィードの受信・トークン・生データ(17.6)
   │  └─ rcon/
   │     ├─ client.ts         # fetch、タイムアウト、エラー分類
   │     ├─ routes.ts         # 本パネルが使う RCON ルートの一覧(API.md 6 章)
   │     ├─ capabilities.ts   # /v1/capabilities の取得・解釈・キャッシュ
   │     └─ normalize.ts      # RCON 応答の正規化
   ├─ pages/                  # frontend-pages(API は backend)
   │  ├─ index.astro          # 状態
   │  ├─ players.astro / bans.astro / audit.astro / servers.astro / killfeed.astro(スコア推移と受信した生データ。17.9)
   │  ├─ login.astro          # GET 表示 / POST 認証
   │  ├─ logout.ts            # POST のみ
   │  ├─ setup.astro          # 初期設定(管理パスワードの登録)/ D1 の不備の案内。GET 表示 / POST 登録
   │  └─ api/
   │     ├─ session.ts / status.ts / players.ts / bans.ts / maps.ts / capabilities.ts / audit.ts
   │     ├─ servers/index.ts(GET・POST)/ servers/[id].ts(PUT・DELETE)/ servers/[id]/test.ts(POST)
   │     ├─ servers/[id]/feed.ts(GET・PUT)/ servers/[id]/feed-token.ts(POST・DELETE)
   │     ├─ matches/index.ts(GET)/ matches/[id]/samples.ts(GET)/ feed/raw.ts(GET)
   │     ├─ ingest/events.ts(POST。ゲームサーバーからの受信。ログイン不要・トークン認証)
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

**2026-10-17 の追記**: スコア記録(第 17 章)のために Cron を 1 本使うことになった(カスタムエントリの方法は Astro 公式ガイドで確認し、ローカルで動作を確認した。17.4)。それでも人数スナップショットは**この節の方式のまま**とし、スコア記録の `match_samples` とは併存させる(17.1 の 1。粒度・保持・始まり方が違い、常時の Cron 記録にすると 1 台あたり 1 日 1,440 回の RCON 呼び出しが記録の有無に関係なく発生するため)。

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
- **例外: `POST /api/ingest/events`**(キルフィードの受信。2026-10-17)。ゲームサーバーが送るため `Origin` も `Sec-Fetch-Site` も無い。この 1 つのパスだけ CSRF 検査とログイン Cookie の検査を行わず、受信用トークンで認証する(5.8)。Cookie を使わないので CSRF の対象にならない(他サイトから送らせても、トークンを知らなければ 401)。

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
- D1 の不備・管理者の未登録は 5.1.1 の表のとおり(ページは `/setup` へ 303、API は 503 `NOT_CONFIGURED` / `SETUP_REQUIRED`)。middleware の順序は「D1 の判定 → CSRF → 管理者の登録の有無 → ログイン Cookie → ヘッダ」。`/api/ingest/events` は「D1 の判定 → ヘッダ」だけ(5.8)。
- `/setup` は未ログインでも見られる。出すのは D1 の不備の種類(`D1_MISSING` / `D1_NOT_MIGRATED`)か登録フォームだけ。登録済みなら何も出さずに `/login` へ。
- ログ(`console.*`、Workers Logs)に出してよいのは、ルート名・HTTP ステータス・所要時間・エラーコードのみ。管理パスワード・RCON パスワード(平文・暗号文)・パスワードのハッシュ・`instance_key`・派生した鍵・Cookie・`Authorization`・RCON の接続先・生の IP・プレイヤーのメッセージ本文は出さない。

### 5.8 受信エンドポイントの認証(`/api/ingest/events`。2026-10-17)

| 項目 | 決定 |
|---|---|
| 対象 | 正規化したパス(末尾の `/` を除く)が **`/api/ingest/events` と完全一致**するリクエストだけ。前方一致・大文字小文字の違い・`//api/...` は対象外(通常の `/api/*` として扱い、Cookie が無ければ 401)。定数 `FEED_INGEST_PATH` |
| middleware で行うこと | D1 の判定(不備なら 503 `NOT_CONFIGURED`)とセキュリティヘッダだけ。**CSRF 検査・管理者の有無・ログイン Cookie の検査はしない**(`locals.session` は常に null) |
| エンドポイントで行うこと | 17.6 の順序(メソッド → トークンの形式 → D1 の 1 行と定数時間の比較 → レート制限 → `Content-Type` → サイズ → JSON → 保存の判定) |
| トークン | サーバーごと。`wof1.<ServerId>.<32 バイトの乱数>`。D1 には SHA-256 のハッシュだけ。発行時に 1 回だけ表示(17.6) |
| レート制限 | サーバーごとに 1 分 90 回(isolate 内)。トークンの検証の後で数える(形式不正・不一致のリクエストで正しいサーバーの枠を使わせないため) |
| ログ | トークン・`Authorization`・本文・接続元 IP を出さない(5.7) |

ログイン画面と同じく、誰でもリクエストを送れること(Worker のリクエスト数を消費させられること)は防げない。トークンが漏れても RCON・パネルの操作はできず、観測データを汚されるだけ(再発行で止める)。

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

正本は `db/migrations/`(`0001_init.sql`、`0002_servers.sql`、`0003_recordings.sql`、`0004_killfeed.sql`)。`db/schema.sql` は全マイグレーション適用後の参照用のまとめ。時刻はすべて UTC epoch ミリ秒。**本番稼働後のマイグレーションは追加のみ**(表・列・インデックスの追加。表の作り直し・列の削除・CHECK の変更はしない。C-5 のとおり新しいコードがマイグレーションより一瞬先に動くため)。

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
- 0003 の表(match_recordings / match_samples / feed_raw_events / feed_daily / server_feeds)はログイン時ではなく、試合の終了時と Cron の毎時 17 分に掃除する(17.7)

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

### 8.9 0003 で既存の表に足した列

- `servers.score_cap`(INTEGER、NULL 可、CHECK 1〜100,000): スコア記録の上限の設定値。NULL = 既定 100(17.5)。
- `settings_audit_log.confirm_nonce`(TEXT、UNIQUE 索引 `idx_settings_audit_log_nonce`): `record_start` / `record_stop` の確認トークンの nonce(17.2)。他の行は NULL。8.6 の event に `record_start` / `record_stop` / `record_end` / `feed_token_issue` / `feed_token_revoke` / `feed_settings_update` が加わる(`SETTINGS_EVENTS`。トークンの値・ハッシュは `params_json` に入れない)。

### 8.10 match_recordings(0003)

試合 1 つ = 1 行。`id`(AUTOINCREMENT)、`server_id`・`server_name`(開始時点)、`status`(`recording` / `ended`、CHECK)、`started_at`・`ended_at`、`end_reason`(`MATCH_END_REASONS`、CHECK なし)、`map`(開始時点。マップ変更の検出用)、`score_cap`・`score_cap_source`、`empty_since`、`last_scores_json`(終了時の陣営スコア)、`created_at`・`updated_at`。索引: 部分 UNIQUE `(server_id) WHERE status = 'recording'`(1 サーバー 1 記録中)、`(server_id, id)`。

### 8.11 match_samples(0003、WITHOUT ROWID)

主キー `(recording_id, bucket_minute)`(`bucket_minute = floor(unix 秒 / 60)`)。`taken_at`、`map`、`players_current`・`players_max`、`faction_scores_json`(`FactionScore[]`)、`cash_total`(REAL)、`faction_stats_json`(`FactionStat[]`: 陣営ごとの人数と cash の合計)。プレイヤー名・Steam ID は入れない。

### 8.12 server_feeds(0003)

`server_id`(PK)、`token_hash`(`sha256$<base64url>`)、`token_hint`(末尾 4 文字)、`token_created_at`、`enabled`、受信の状況(`last_received_at`・`last_stored_at`・`last_rejected_at`・`last_rejected_reason`・`last_dropped_at`・`last_dropped_reason`。1 分に 1 回までの間引き更新)、`created_at`・`updated_at`。

### 8.13 feed_raw_events / feed_daily(0003)

- `feed_raw_events`: `id`、`server_id`、`received_at`、`bytes`、`event_count`、`recording_id`(受信時に記録中だった試合)、`body`(受けた JSON 文字列のまま。最大 64 KiB)。索引 `(server_id, id)`、`received_at`。保持 7 日。**Steam ID・プレイヤー名を含み得る**ため、ログイン済みの運営者にだけ返す。
- `feed_daily`(WITHOUT ROWID): 主キー `(server_id, day)`(`day` = UTC の日。`server_id = 0` は全体)、`batches`、`bytes`。1 日の上限の判定用(17.6)。

### 8.14 feed_kills と 0004 で足した列(キルフィード第 2 段階。17.10)

- `feed_kills`: 正規化したキル 1 件 = 1 行。`id`(INTEGER PRIMARY KEY、AUTOINCREMENT なし)、`server_id`、`recording_id`(受信時に記録中だった試合。**0 = 記録外**)、`received_at`、`event_at`、`game_time_sec`、キラー・被害者の `name`・`steam_id`・`faction`・`faction_source`、`weapon_id`・`weapon_name`、`vehicle_id`・`vehicle_name`、`flags`(ビット)、`distance_m`。索引は `(server_id, recording_id, received_at)` の 1 本。**Steam ID・プレイヤー名を含む**ためログイン済みの運営者にだけ返す。
- トリガー: `trg_match_recordings_delete_kills`(試合の削除でその試合のキルを消す)、`trg_servers_delete_unrecorded_kills`(サーバーの削除で記録外のキルを消す)。
- `match_samples.roster_json`: 陣営の付与用の観測(Steam ID → 陣営の添字。名前は入れない)。
- `server_feeds.raw_enabled`(既定 1): 生データも保存するか(0 でもキルは保存する)。
- `feed_daily` の `kills`・`other_events`・`incomplete`・`dropped_kills`: 正規化の件数(`kills` は 1 日の上限の判定にも使う)。

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
| `/killfeed` | キルフィード(Killfeed) | 試合の選択・スコア / cash の推移のグラフ・受信した生データ(観測モード)(9.6、17.9) | あり | 記録中の試合は 60 秒、生データは手動更新 |

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
  4. **縦ナビ**: 状態 / プレイヤー / BAN / 操作ログ / サーバー設定。**タブと同じ定義**(`src/layouts/nav.ts` の 1 つの配列)から作り、ラベルも同じキー(`tabs.*`)を使う(タブと縦ナビで呼び名が食い違わないように)。リンクには `?server=<現在の id>`(15.5)。キルフィードは縦ナビには出さない(準備中のため。2026-10-17 の第 17 章で縦ナビにも出すことにした。17.9)。
  5. **最下部**(`margin-top: auto` で下端に寄せる): 操作者名(`sidebar.session.operator` / `operatorAnonymous`)、ログインの有効期限(`formatDateTime`、タイムゾーンは vars `TIMEZONE`)、ログアウト(従来の `POST /logout` フォーム)。
- **サイドバーに置かないもの**: スポンサー画像・説明欄など金銭を連想させる要素、ホスティング業者の案内・広告、ゲームサーバー ID(非公開情報。`GET /v1/server-id` は呼ばない)、RCON パスワードやその長さ・`passwordShort`。
- **ヘッダー**: アプリ名(`/` へのリンク。`?server=` 付き)と、幅 1024px 未満のときだけサイドバーの開閉ボタン(9.5)。操作者名・期限・ログアウトはサイドバー最下部へ移したのでヘッダーには出さない。
- **タブ**: 概要 / プレイヤー / BAN / 操作ログ / 設定 / キルフィード。現在のページは `aria-current="page"`。キルフィードは `/killfeed` へのリンク(2026-10-17 の第 17 章で「準備中」の印を外す。9.6)。タブはページ遷移で切り替える。ARIA の `tablist` / `tab` は使わない(各タブは別 URL の通常のリンクで、JS 無しでも動き、`?server=` の規則〔15.5〕をそのまま使えるため。`tablist` はページ内のパネル切り替え用の役割で、ページ遷移のリンクに付けると支援技術の操作説明と食い違う)。
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
| 概要(`/`) | 状態の詳細(ゲーム内サーバー名、マップ〔表示名と id〕、人数、陣営スコア〔全陣営〕、ゲームモード、ローテーション位置、次のマップ、最終更新時刻と「更新」)。**よく使う操作**: 全体メッセージ(broadcast)、マップ変更、試合終了。各操作のボタン・フォームの直下に「何が起きるか」の短い説明(`action.help.<action>`)。**スコア記録**の節(記録を開始 / 停止、記録中の状態。17.9) | `status.*`、`action.help.broadcast` / `map` / `match_end` / `record_start` / `record_stop`、`recording.*` |
| プレイヤー(`/players`) | 接続中一覧(名前、陣営、K/D、ping、Steam ID)。行ごとに kick / 個別メッセージ / BAN。一覧の上に 3 操作の説明を 1 回だけ出す(行ごとには出さない。モバイルで行が長くなるため) | `players.*`、`action.help.kick` / `message` / `ban` |
| BAN(`/bans`) | BAN 一覧(Steam ID、日時、理由、実行者、監査ログからの名前)。解除。一覧の上に解除の説明 | `bans.*`、`action.help.unban` |
| 操作ログ(`/audit`) | 従来どおり(「操作」「設定変更」の切り替え、サーバーでの絞り込み。既定は全サーバー〔U-9〕。サイドバーで選んだサーバーに自動では絞らない) | `audit.*` |
| 設定(`/servers`) | 従来の「サーバー設定」(15.7)。ページ見出しは「設定」、その下に「サーバー」の節を置く。2026-10-17: 選択中のサーバーの「スコア記録」(上限)と「キルフィード(観測モード)」(受信用トークン・ini の案内・受信の状況)の節を足す(17.9)。将来アプリ設定(言語・タイムゾーン。D1 `settings`、8.8)を足すときは同じページに「アプリ」の節を足す(パスは `/servers` のまま。節が増えて長くなったら `/settings` を作り、`/servers` はそのサーバーの節として残す) | `servers.*`、`tabs.settings`、`settings.recording.*`、`feed.*` |
| キルフィード(`/killfeed`) | 試合の選択(現在 / 直近 5 試合)、スコア / cash の推移のグラフ(SVG)、試合の要約、受信した生データ(観測モード)。17.9 | `killfeed.*`、`chart.*`、`match.endReason.*`、`feed.*` |

- 要確認 U-22(2026-10-17、実装しない): 実サーバーの陣営名・陣営ごとの人数は `players[].faction` から集計できる見込み(スコア記録のサンプルでは集計する。17.1)。サイドバーの「試合の要点」に陣営ごとの人数を足すか(足すなら `/api/status` に `/v1/players` の呼び出しが 30 秒ごとに増える)。

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

### 9.6 キルフィード(2026-10-17 に第 17 章で設計を確定)

- 2026-10-17 までは「準備中」の案内だけのページだった(RCON HTTP API にはキル・接続のイベントを取るルートが無く、資料上はゲームサーバーから外部へ送る `WDServerFeed` だけのため。`docs/research/wardogs-rcon.md` 2.4、未検証)。
- 2026-10-17 のユーザー決定で、キルフィードタブは (1) スコア記録の推移のグラフ(17.9)と、(2) キルフィードの**第 1 段階: 観測モード**(受信した生データをそのまま表示。17.6)になった。キル数・ヘッドショット率などの集計は**第 2 段階**で、実サーバーで形式を確かめた後に設計する(17.10)。
- 旧版の検討事項(受信エンドポイント、ゲーム側の設定、量の見積り、届け方)は 17.6・17.8・17.9 で決めた(14 章 K-1〜K-5 の更新を参照)。
- 2026-10-17 のユーザー要望(参考パネルのキルフィード画面と同等の表示)で、**第 2 段階**(キルの正規化・保存・集計・画面)を 17.10 で確定した。届く本文の項目名は未確認のまま、候補名の対応表で読む。

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

スコア記録とキルフィードの受信(2026-10-17)による増分は 17.8(受信を 2 台以上で常時続けると Worker のリクエスト数が無料枠を超え得る)。

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
| キルフィードの受信(2026-10-17) | − | **`/api/ingest/events` はログイン不要でインターネットに公開される**(ゲームサーバーから送るため)。トークンが漏れると観測データに偽の行を入れられる。誰でもリクエスト数を消費させられる。ゲームが 2 秒ごとに送ると、それだけで 1 台 1 日約 4.3 万リクエストを使う | サーバーごとのトークン(ハッシュで保存、再発行・取り消し可)、64 KiB・1 分 90 回・1 日の上限、受信は 1 台ずつ・確認が済んだら ini の `Url` を消す案内(17.6・17.8) |

Secrets 廃止前(2026-10-16 午前)との比較: 以前は RCON パスワードが Worker Secret(または ADMIN_PASSWORD / SESSION_SECRET 由来の鍵で暗号化した D1)にあり、「D1 だけが漏れた」場合は平文を得られなかった。現方針ではその場合も復号できる。一方で、Cloudflare アカウントを乗っ取られた場合は以前も Secrets ごと漏れていたため、守れる範囲の差は「D1 だけが漏れる」場合に限られる。利用者が Cloudflare 側で値を入力・管理しなくてよい簡単さを優先した(ユーザー決定)。

将来の選択肢(実装しない。短く記録するだけ): (a) 利用者が自前ドメインを持つ場合に Cloudflare Access をログインの前段に追加する、(b) RCON 側で TLS が使える場合の https 化、(c) 中継プロキシを任意オプションとして復活させ AllowedHosts を絞る、(d) Cron による常時スナップショット(Cron 自体はスコア記録で使うようになった。17.3)、(e) `PUT /v1/config` による設定変更(第 2 段階)、(f) 任意の Secret(例 `KEY_ENCRYPTION_SECRET`)を設定した場合だけ `instance_key` をそれで包む(D1 だけの漏洩に備えたい上級者向け)。

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
  - 2026-10-18: 運営者の確認により現行のマップは Zestafona / Ozeti / Bakurani の 3 つ。`src/lib/rcon/known-maps.ts` に既知の一覧として持ち、カタログが取得できない・空のときに `GET /api/maps` が `source: 'builtin'` で返す(表示名を id として使う。実 id の形式は未確認のまま)。
- **R-12** `POST /v1/match/end` の本文の要否(空 JSON `{}` を送るか、本文無しか)。
- **R-13** レート制限(600 リクエスト/分/IP、429 + `Retry-After`)の真偽。Workers の送信元 IP が他の利用者と共有される場合の影響。
- **R-14** エラー応答の形式(JSON のフィールド名、ステータスの使い分け)。
  - 書き込み系の 404 を `RCON_ROUTE_NOT_FOUND` に決め打ちしている(QA S-8)。対象プレイヤーの退出時の 404 と区別するには、エラー本文の形式の確認が要る。
  - `rconMessage` をそのまま画面に表示している(QA S-10)。内部情報(パス等)が含まれないかを実機で確認してから、表示の可否を決める。
- **R-15** 認証失敗(パスワード違い)と AllowedHosts による拒否のステータスの違い、失敗が続いたときのロックアウトの有無(送信元を共有する他者の失敗に巻き込まれないか)。
- **R-16** サーバーの提供元ごとに、RCON ポートをインターネットに公開できるか(運営者ごとの確認事項。README で案内)。
- **R-17** 開発元による公式ドキュメント・RCON の外部利用に関する規約(未確認)。
- **R-19** `/v1/status` の `experiences[]` が「ゲームモード」を表すか(要素の形式・値の例)。`/v1/rotation` の `entries[]` の要素の形式(マップ id のフィールド名、表示名の有無)と `enabled: false` の意味。違っていた場合、サイドバーのゲームモードは非表示にし、次のマップは `rotation.nextIndex` だけに戻す(9.3)。**添字の起点も未検証**: 画面は `nowIndex` / `nextIndex` を 0 始まりとみなして +1 表示し、次のマップを `entries[nextIndex]` で引いている(モックも 0 始まり)。実機が 1 始まりなら表示と次のマップが 1 つずれるため、確定までは推定表示(QA 2026-10-17 layout M-1)。
- **R-20** `POST /v1/match/end` の後にローテーションの次のマップへ進むか、`POST /v1/match/map` が進行中の試合をどう扱うか。操作の説明(`action.help.*`。9.4)の文言はこれを断定しない形にしてあり、確認後に直す。
- **R-21** `/v1/status` の `scoreCap` / `matchSeconds` の有無(ビルド依存と資料にある)・意味・型。`factionScores[].score` が上限に向かって**増える**方式か(減っていく方式ならスコア記録の `score_cap` の判定〔17.5〕を「0 に達したら」等に直す)。
- **R-22** `/v1/players` の `players[].cash` の意味(所持している額か、試合の累計か)と型、`players[].faction` の表記が `status.factionScores[].faction` と一致するか(違うと陣営ごとの cash・人数のグラフの線がスコアの線と別名になる。17.1)。`/v1/players` が無いビルドの有無。
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
- **C-9** Cron 実行が 10 万リクエスト/日に含まれるか(2026-10-17 から 1 分ごとの Cron を使う。数えられても 1,440/日。17.8)。
- **C-10** `@astrojs/cloudflare@14` のカスタムエントリに `scheduled` を同居させられるか。**2026-10-17 更新**: Astro 公式ガイドの「Custom entrypoint API」(`main: ./src/worker.ts` + `handle` の委譲)で方法を確認し、ローカル(`pnpm build`、`wrangler dev --test-scheduled` の `/cdn-cgi/handler/scheduled`)で動作を確認した(17.4)。残りは**本番(Workers Builds・Deploy ボタン)で Cron が 1 分ごとに起動すること**の確認。
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
- **C-22** Cron Triggers の環境(`env.gmkz`)への引き継ぎの有無(引き継がない前提で両方に書いた)と、配送の性質(同じ分に 2 回起き得るか・取りこぼしがあるか。どちらでも壊れない設計。17.3)。設定の反映に最大 15 分かかる(公式)ため、デプロイ直後の数分は Cron が動かないことがある。
- **C-23** 本番の D1 で `WITHOUT ROWID` の表・部分 UNIQUE 索引(`WHERE status = 'recording'`)・`INSERT ... ON CONFLICT DO UPDATE ... WHERE ... RETURNING` が使えること(ローカルでは確認済み)。`db.batch()` の各文が「Worker 呼び出し 1 回あたりのクエリ数 50」に 1 つずつ数えられるか(数えられる前提で上限を決めた。17.3)。
- **C-24** 本番での Cron 1 回の CPU 時間(記録中 8 台で 10 ms に収まるか)と、受信 1 件の CPU 時間(64 KiB の JSON.parse を含む)。
- **C-25**(第 2 段階)D1 で `INSERT ... SELECT ... FROM json_each(?)` が使えるか、バインドする JSON 文字列の大きさの上限(1 バッチ 100 キルで 40 KB 程度)。使えない場合は 1 文あたりのバインド変数 100 個に収まるよう 4 行ずつの複数行 INSERT を `db.batch` で送る(クエリ数が増えるため、1 バッチの上限を下げる)。
- **C-26**(第 2 段階)`wrangler d1 migrations apply` と D1 本番でトリガー(`CREATE TRIGGER ... BEGIN ...; END;`)が作れて動くか。トリガー内の削除の行数が書き込み行数に数えられること。動かない場合の代わりは 17.10.9。
- **C-27**(第 2 段階)受信 1 件の正規化(長い整数の走査 + `JSON.parse` + 対応表の照合)の CPU 時間。`GET /api/killfeed/kills` で 3,000 行を返すときの CPU 時間と応答の大きさ。
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

### キルフィード・スコア記録(第 17 章)

- **K-1**(未検証のまま。観測モードで確かめる)`WDServerFeed` の送信仕様(`Url + /api/ingest/events`、Bearer、約 2 秒ごとのバッチ、イベントは `killed` のみ)の真偽と本文の形式(配列か `events` を持つオブジェクトか、各イベントの項目。17.10 の表)。接続・切断イベントが無いこと。`Content-Type` が `application/json` か(違えば 415 で拒否され、設定タブに `content_type` と出る。その場合は受け付ける形式を広げる)。
- **K-2**(2026-10-17 に決定 → 17.6・5.8)サーバーごとのトークン(`wof1.<ServerId>.<乱数>`、SHA-256 のハッシュで保存、発行時に 1 回だけ表示、再発行・取り消し)。ログイン Cookie・CSRF 検査の対象外は `/api/ingest/events` の完全一致だけ。
- **K-3**(方針は決定、量は要確認)空のバッチは D1 に書かず 204。1 日の保存の上限(サーバーごと 1,000 件・4 MiB、全体 4,000 件・16 MiB)と保持 7 日。**ゲームが「イベントが無いときも 2 秒ごとに送る」か**で Worker のリクエスト数が大きく変わる(送るなら 1 台 1 日約 4.3 万。17.8)。観測で確認し、送る場合は「観測は 1 台ずつ、確認が済んだら `Url` を消す」の案内を強める。
- **K-4** ゲームサーバーの設定の書き方: セクション名(`[WDServerFeed]` そのものか、`[/Script/...]` 形式か)、キー名(`Url` / `Token`)、`Url` の末尾の `/` の扱い、変更の反映に再起動が要るか、サーバーの提供元が設定を許すか。
- **K-5**(2026-10-17 に決定 → 17.9)生データは手動更新(最新 20 件)。スコアの推移は記録中の試合だけ 60 秒ごと。保持は生データ 7 日、試合は直近 5 試合・30 日。
- **K-6** 受信に 4xx / 5xx を返したときのゲームの挙動(再送するか、間隔を空けるか、送信をやめるか)。設計は「上限・無効で捨てるときも 204」にしてある(17.6)。429(1 分 90 回超)・401(トークン違い)で再送が増えないかを確認する。
- **K-7** ゲームの送信が HTTPS(workers.dev の証明書)に対応しているか。HTTP で送ってくる場合に workers.dev・カスタムドメインがどう応答するか(リダイレクトに従わない送信元だと届かない)。
- **K-8** 1 回の送信の大きさ(64 KiB で足りるか)と頻度(約 2 秒か。1 分 90 回の上限で足りるか)。
- **K-9**(第 2 段階。17.10.2)`killed` イベントの実際の項目名と値の形(キラー・被害者・武器・乗り物・印・距離・時刻)。17.10.2 の対応表の候補はすべて推測。特に**距離の単位**(m か、Unreal Engine の既定の cm か)と、キルごとの得点が含まれるか。観測で確かめ、`src/lib/killfeed/fields.ts` を直す。
- **K-10** Steam ID が文字列か数値か。数値(17 桁)で届く場合は `JSON.parse` で桁が落ちるため、16 桁以上の整数を文字列として読む前処理を入れてある(17.10.2 の 1)。前処理で囲んだ数(`bigIntegersQuoted`)で確かめる。
- **K-11** イベントに陣営(チーム)が含まれるか。含まれない場合はプレイヤー一覧の観測から付ける(記録中のみ。17.10.4)。含まれる場合、`/v1/players` の `faction` と同じ表記か(違えばチームキルの判定は出所が同じものだけで行う)。
- **K-12** 自殺・環境による死亡・チームキルの表し方(キラーが空か、被害者と同じか、専用の項目があるか)。
- **K-13** ゲーム内時刻(参考パネルの `GAME 52:31`)の項目と意味(試合開始からの経過か、残り時間か)。
- **K-14** `killed` 以外の種類のイベントが届くか、届くならその量(キル以外は保存せず件数だけ数える。17.10.2)。

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

以下は 2026-10-17 のスコア記録とキルフィード(第 17 章)で architect が決めた点(ユーザー確認待ち。推奨どおりなら決定事項として扱う)。

- **U-19** 記録の開始・停止・自動終了と受信用トークンの発行・取り消しは、操作ログの「**設定変更**」タブ(`settings_audit_log`)に出す。`audit_log.event` の CHECK に値を足せないため(M-6)。推奨: このまま(ゲームサーバーを変える操作ではなく、パネルの状態を変える操作として扱う)。タブ名が合わなければ「設定・記録」等に変える(カタログ 1 か所)。
- **U-20** 試合が終わった後、次の試合を自動では記録しない(毎回「記録を開始」を押す)。推奨: このまま(無料枠と、意図しない記録を避けるため)。連続記録は要望があれば第 2 段階。
- **U-21** 画面・グラフの「cash」の表記。RCON の項目名(ゲーム内の通貨)をそのまま使う想定だが、「金銭を連想させる表記を出さない」規則との関係を確認したい。推奨: ゲーム内の値であることが分かる表記(例「ゲーム内 cash」)にし、スポンサー等の意匠とは無関係であることを保つ。
- **U-22** サイドバーの試合の要点に陣営ごとの人数を足すか(9.4 の注記。今回は実装しない)。
- **U-23** サイドバーに「記録中」の印を出すか(出すと `/api/matches` の取得が 30 秒ごとに増える。今回は出さない。17.9)。
- **U-24** 同時に記録できるのは 8 台まで(Cron 1 回の D1 クエリ数の上限から。17.3)。キルフィードの生データの保存上限(サーバーごと 1 日 1,000 件・4 MiB、全体 4,000 件・16 MiB、7 日)。

以下は 2026-10-17 のキルフィード第 2 段階(17.10)で architect が決めた点(ユーザー確認待ち。推奨どおりなら決定事項として扱う)。

- **U-25** 集計はブラウザで行い、集計用・JSON 出力用の API は作らない(キルの一覧の API 1 本。17.10.6)。推奨: このまま(リクエストが少なく、画面と JSON の数字が必ず一致する)。
- **U-26** 正規化したキルを受信時に `feed_kills` に保存し、生データの保存は別のスイッチで止められる(既定オン)。推奨: 形式を確かめたら生データの保存をオフにする(書き込み・容量の節約)。
- **U-27** 陣営は「イベントの値 → 記録中のサンプルのプレイヤー一覧(3 分以内)」の順で付け、記録外のキルは陣営不明(「?」)。推奨: このまま(記録外でも陣営を付けるには Cron が常にプレイヤー一覧を取る必要があり、RCON とクエリが増える)。
- **U-28** 記録外のキルは直近 500 件・7 日だけ見せる。試合に属するキルは試合と同じ保持(直近 5 試合 + 記録中・30 日)。
- **U-29** キルの保存の上限: 1 バッチ 100 件、1 日サーバーごと 3,000 件・全体 8,000 件(超えた分は捨てて件数だけ数える)。
- **U-30** 現在のスコアはサイドバーと共有の 30 秒ごとの取得を使う(参考パネルの約 15 秒ごとより遅い)。キルの差分も 30 秒ごと。推奨: このまま(リクエスト数を増やさない)。
- **U-31** 対応表を直した後に、保存済みの生データ(7 日以内)からキルを作り直す機能は入れない(必要なら第 3 段階。書き込みが一度に増えるため、上限と確認の設計が要る)。

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

## 17. スコア記録とキルフィード(2026-10-17)

2026-10-17 ユーザー決定。本章が正本で、5・8・9・11・14 章の該当箇所は本章を参照する。契約は `src/types/api.ts`(スコア記録・キルフィードの節)、`src/types/env.ts`(Cron の節)、`db/migrations/0003_recordings.sql`、`wrangler.jsonc` の `triggers`、`docs/API.md` 4.1・8〜10 章。

### 17.0 決定の要約

| 項目 | 決定 |
|---|---|
| スコア記録の開始 | 概要タブの「記録を開始」。**書き込み操作と同じ二段階**(`prepare` → `execute`、確認ダイアログ)。操作の種類は `RecordingAction`(`record_start` / `record_stop`。`WriteAction` とは別系列。17.2) |
| 記録の中身 | 開始時に 1 回、以後 **Cron(1 分ごと)** が記録中のサーバーだけ `GET /v1/status` と `GET /v1/players` を取り、1 分 1 行(陣営スコア・人数・マップ・cash の合計・陣営別の人数と cash)を `match_samples` に保存 |
| 終了 | いずれかの陣営スコアが上限に達したら自動終了。保険: 「記録を停止」、マップの変化、人数 0 が 10 分、開始から 3 時間、サーバーの削除・無効化(17.5) |
| 保持 | サーバーごとに記録中 1 + 終了済み 5 試合。それより古い試合・30 日より古い試合はサンプルごと削除(17.7) |
| 人数スナップショットとの関係 | **併存**(`server_snapshots` は変えない。17.1) |
| Cron の置き場所 | **Astro の Worker に同居**(`src/worker.ts` を `main` にし、`fetch` は Astro の `handle` に委譲、`scheduled` を足す。17.4) |
| キルフィード | **第 1 段階: 観測モード**。`POST /api/ingest/events`(サーバーごとのトークンで認証。ログイン・CSRF 検査の対象外)で受けた本文を、上限付きでそのまま `feed_raw_events` に 7 日保存し、キルフィードタブで最新の生データを見せる。集計(第 2 段階)は 17.10 で確定(本文の項目名は未確認のまま、候補名の対応表で読む。第 1 段階の契約は変えず追加のみ) |
| 操作の記録先 | `record_start` / `record_stop` / 自動終了 / トークンの発行・取り消しは `settings_audit_log`(操作ログの「設定変更」タブ)。`audit_log.event` の CHECK に値を足せないため(8.1、M-6。要確認 U-19) |

### 17.1 データモデル(0003)

テーブル定義は `db/migrations/0003_recordings.sql`(8.9〜8.13 に要約)。外部キーは張らない(15.2 と同じ。サーバーを削除しても記録は保持期間まで残す)。

| 変更 | 目的 |
|---|---|
| `servers.score_cap`(ALTER ADD COLUMN、NULL = 既定 100) | 設定タブで変えるスコア上限 |
| `settings_audit_log.confirm_nonce`(ALTER ADD COLUMN + UNIQUE 索引) | `record_start` / `record_stop` の確認トークンを 1 回限りにする(`audit_log.confirm_nonce` と同じ役割) |
| `match_recordings`(新規) | 試合 1 つ = 1 行。部分 UNIQUE 索引 `(server_id) WHERE status = 'recording'` で 1 サーバー 1 記録中を D1 が保証する |
| `match_samples`(新規、`WITHOUT ROWID`) | 1 分 1 行。主キー `(recording_id, bucket_minute)` で `INSERT OR IGNORE`(Cron の二重実行でも 1 行) |
| `server_feeds`(新規) | サーバーごとの受信用トークン(SHA-256 のハッシュ)・有効/無効・受信の状況 |
| `feed_raw_events`(新規) | 受信した本文(JSON 文字列のまま)。7 日保存 |
| `feed_daily`(新規、`WITHOUT ROWID`) | 1 日(UTC)の保存件数・バイト数。サーバーごとと全体(`server_id = 0`) |

決定と根拠:

1. **`server_snapshots` とは併存**。`server_snapshots` は「誰かがパネルを開いている間、5 分に 1 行・90 日」の人数の履歴で、Cron を使わずに長期の傾向を見るためのもの。`match_samples` は「記録を開始した試合の間だけ、1 分に 1 行・直近 5 試合」で、粒度・保持・始まり方が違う。統合すると (a) 人数の履歴のために Cron を常時動かすことになる(4.4 の判断が変わる)、(b) 保持の規則が混ざる。統合の利点(表が 1 つ減る)より分けておく方が単純。Cron が記録中のサーバーの `server_snapshots` も書く案は採らない(書き込みが増えるだけで、読む画面が無い)。
2. **陣営ごとの値は列ではなく JSON**(`faction_scores_json`、`faction_stats_json`)。陣営の数・名前はマップやモードで変わり得る(実サーバーでは 3 陣営と聞いているが、資料上は未検証)。グラフは 1 試合分(最大 181 行)を読んで画面で描くだけなので、SQL での陣営別の集計は要らない。
3. **`match_samples` は `WITHOUT ROWID`**。主キー以外の索引を持たない表で、通常の表だと「行 + 主キーの自動索引」の 2 つを書くことになるため(行数の数え方は C-17)。
4. **スコア上限の設定値は `servers` の列**。サーバーごとに 1 つの値で、`servers` の 1 行の読み取り(15.6 のサーバーの解決)で一緒に取れる。
5. **キルフィードの設定は別表 `server_feeds`**。受信は 2 秒ごとに来得るため、`servers` の行(暗号化した RCON パスワードを含む)に受信の状況を書き込まない。トークン未発行のサーバーは行が無い。
6. **終了理由・受信の拒否理由には CHECK を付けない**(コードの `MATCH_END_REASONS` / `FEED_*_REASONS` で検証)。理由を足すときにマイグレーション(CHECK は変更不可。8 章)を要らなくするため。`match_recordings.status` は 2 値で増えない見込みのため CHECK を付けた。
7. 実機確認(2026-10-17、wrangler 4.151 のローカル D1): 0001 → 0002 → 0003 の適用、部分 UNIQUE 索引による 2 件目の「記録中」の拒否、`INSERT OR IGNORE` の重複無視、`score_cap` の CHECK、Cron の一覧取得が部分索引を使うこと(`EXPLAIN QUERY PLAN` で `USING COVERING INDEX idx_match_recordings_active`)。本番の D1 での `WITHOUT ROWID`・部分索引は C-23。

### 17.2 記録の開始・停止(二段階)

記録操作の失敗(入力検証、`RECORDING_ALREADY_ACTIVE` 等の状態競合、確認トークンの不一致)は RCON を呼ばず D1 も変えないため、`settings_audit_log` には記録しない(QA 2026-10-17 killfeed M-4 での決定。書き込み操作の `audit_log` とは扱いが異なる)。成功した開始・停止・自動終了は必ず 1 行残す。

既存の `POST /api/actions/prepare` / `execute`(4.3)に乗せる。確認トークンの形式・検証の順序(署名 → セッション → action と params のハッシュ → 対象サーバーと宛先 `sv` / `sh` → 期限)は同じで、`a` に `record_start` / `record_stop` を許す(`src/lib/confirm.ts` の `isWriteAction` を `ConfirmableAction` の判定に広げる)。`destructive` は常に false(ゲームサーバーに何も書き込まないため。通常の確認ダイアログ)。capabilities の判定はしない(`write` の対象外)。

**prepare**

| action | 処理 | 失敗 |
|---|---|---|
| `record_start`(params `{}`) | サーバーの解決(15.6)→ そのサーバーが記録中なら拒否 → 全体の記録中が `MAX_ACTIVE_RECORDINGS`(8)以上なら拒否 → RCON `GET /v1/status`(5 秒)で現在のマップと `scoreCap` を読み、上限を決める(17.5)→ 確認トークン | `RECORDING_ALREADY_ACTIVE` / `RECORDING_LIMIT_REACHED`(409)、`RCON_*`(届かないサーバーの記録は始めない) |
| `record_stop`(params `{ recordingId }`) | サーバーの解決 → `recordingId` がそのサーバーの記録中の試合か確認 → 確認トークン(RCON は呼ばない) | `RECORDING_NOT_ACTIVE`(409)、形式不正は 400(`fields.recordingId`) |

応答は `RecordingPrepareResponse`(マップ・上限・止める試合。確認ダイアログの文はカタログ `confirm.record_start` / `confirm.record_stop`)。

**execute**

- `record_start`: トークン検証 → RCON `GET /v1/status`(5 秒)→ 成功したら `GET /v1/players`(5 秒。失敗しても続ける。cash と陣営別の値が null / 空になるだけ)→ 次を **1 つの `db.batch()`** で書く(M-2):
  1. `INSERT INTO match_recordings (...)`(status `recording`、`map` = 開始時の `status.map`、上限と出所)
  2. `INSERT OR IGNORE INTO match_samples (...)`(`recording_id` は `(SELECT id FROM match_recordings WHERE server_id = ? AND status = 'recording')`、`bucket_minute = floor(実行時刻 / 60000)`)
  3. `INSERT INTO settings_audit_log (event = 'record_start', confirm_nonce, params_json = json_object('recordingId', <1 の id>, 'map', ...))`
  - 部分 UNIQUE 索引の違反 → `RECORDING_ALREADY_ACTIVE`、`confirm_nonce` の違反 → `ALREADY_EXECUTED`(どちらも batch 全体が取り消される)。D1 のエラーの区別は例外の文言に含まれる索引名・列名で行う(backend。文言は外に出さない)。
  - RCON `status` が失敗したら記録を始めず `RCON_*` を返す。**失敗は記録しない**(ゲームに影響せず、`audit_log` の「実行前に pending を作る」理由〔実行されたか不明になる〕が無いため)。nonce は使われていないので、同じトークンで期限内にやり直せる。
  - 全体の上限(`MAX_ACTIVE_RECORDINGS`)は prepare と execute で数えるが、並行した開始で 1〜2 件超えることは許す(Cron は古い順に上限件数だけ処理する。17.3)。
- `record_stop`: トークン検証 → 1 つの `db.batch()` で
  1. `INSERT INTO settings_audit_log (event = 'record_stop', confirm_nonce, ...) SELECT ... WHERE EXISTS (SELECT 1 FROM match_recordings WHERE id = ? AND server_id = ? AND status = 'recording')`
  2. `UPDATE match_recordings SET status = 'ended', ended_at = ?, end_reason = 'manual', last_scores_json = (最後のサンプル), updated_at = ? WHERE id = ? AND server_id = ? AND status = 'recording'`
  - 2 の変更行数が 0 → `RECORDING_NOT_ACTIVE`(既に終わっていた。1 も 0 行)。nonce の違反 → `ALREADY_EXECUTED`。成功後に 17.7 の「終了時の削除」。
- 応答は `RecordingExecuteResponse`(`auditKind: 'settings'`、開始・停止した `MatchSummary`)。画面は応答を受け取れなかった場合も `GET /api/matches` を取り直せば状態が分かる(`audit_log` の「結果不明」の扱いは要らない)。
- **このパネルの `map` / `match_end` の execute が成功したら**、そのサーバーの記録中の試合を `match_action` で終える(`src/lib/actions.ts`。17.5 の終了処理と同じ関数)。

### 17.3 Cron(1 分ごと)

`wrangler.jsonc` の `triggers.crons: ["* * * * *"]`(UTC。最上位と `env.gmkz` の両方。環境が `triggers` を引き継ぐかは C-22)。1 回の実行(`scheduledTime` = T)の手順:

1. **記録中の一覧を 1 文で読む**: `SELECT r.*, s.name, s.host, s.port, s.scheme, s.rcon_password_enc, s.enabled, s.score_cap FROM match_recordings r LEFT JOIN servers s ON s.id = r.server_id WHERE r.status = 'recording' ORDER BY r.id LIMIT 8`。
   - 例外(D1 が無い・0003 未適用)→ Workers Logs にコードだけ出して終える(何も書かない)。
   - **0 行なら RCON を呼ばずに終える**(D1 の読み取り 1 回のみ。毎時 17 分だけ 17.7 の掃除を続けて行う)。
2. 鍵(`instance_key` から `server-password` 鍵。5.1.2 の isolate 内キャッシュ)を用意し、各行の RCON パスワードを復号する(AAD は宛先。15.3)。
3. 各記録を **同時に 3 台まで**(`CRON_RCON_CONCURRENCY`。同時接続 6 の内側)処理する。1 台の手順:
   1. サーバーが無い(削除済み)・無効・復号できない → `server_unavailable` で終える(RCON は呼ばない)
   2. `T - started_at >= 3 時間` → `max_duration` で終える(RCON は呼ばない)
   3. RCON `GET /v1/status`(5 秒)。失敗 → この分は何もしない(次の分に任せる。再試行しない)
   4. `status.map` が文字列で、記録の `map` と違う → `map_changed` で終える(**このサンプルは保存しない**。新しいマップの値で前の試合の推移を汚さないため)
   5. RCON `GET /v1/players`(5 秒)。失敗しても続ける(cash・陣営別は null / 空)
   6. サンプルを保存: `INSERT OR IGNORE INTO match_samples (...) SELECT ... WHERE EXISTS (SELECT 1 FROM match_recordings WHERE id = ? AND status = 'recording')`(`bucket_minute = floor(T / 60000)`。手動停止と同じ分に動いても終了後の行を作らない)
   7. 上限の判定(17.5): いずれかの陣営スコア ≥ 実効の上限 → `score_cap` で終える
   8. 人数の判定: `players.current === 0` で `empty_since` が NULL なら T を書く。0 のまま `T - empty_since >= 10 分` → `empty` で終える。1 以上で `empty_since` が NULL でなければ NULL に戻す(**書くのは変化したときだけ**。毎分の UPDATE はしない)
4. **終える処理**(共通。`src/lib/recordings.ts` の 1 関数): `UPDATE match_recordings SET status = 'ended', ended_at = T, end_reason = ?, last_scores_json = ?, updated_at = ? WHERE id = ? AND status = 'recording' RETURNING id` → 行が返ったときだけ `settings_audit_log` に `record_end`(`operator` / `session_tag` は NULL、`params: { recordingId, reason }`)を INSERT → 17.7 の終了時の削除。
5. 例外は投げない(1 台の失敗で他の台を止めない)。Workers Logs には `{ kind: 'cron', recordings, sampled, ended, failures: { <コード>: n } }` だけを出す(ホスト名・サーバー名・プレイヤー名は出さない。5.7)。

**二重実行**(同じ分に 2 回、または前の実行が終わる前に次が始まる): サンプルは主キーで 1 行、終了は `status = 'recording'` 条件の UPDATE で 1 回、`record_end` は UPDATE が行を返したときだけ。`empty_since` の書き込みが前後しても、判定が 1 分遅れるだけ。Cron の配送が「少なくとも 1 回」か「最大 1 回」かは公式資料に記載が無い(C-22)が、どちらでも壊れない。

**1 回の実行の上限**(Workers Free: 外部への fetch 50、D1 のクエリ 50/呼び出し、CPU 10 ms):

| 項目 | 記録中 8 台(上限)の最悪 |
|---|---|
| RCON への fetch | 8 × 2 = 16(capabilities は呼ばない。`/v1/players` が無いビルドでは 404 を受けて null にするだけ) |
| D1 のクエリ | 一覧 1 + `instance_key` 0〜1 + 1 台あたり最大 5(サンプル 1、`empty_since` 1、終了 3〔UPDATE・`record_end`・削除〕)× 8 = 最大 42。毎時 17 分の掃除 +5 で 47。`db.batch()` の 1 文を 1 クエリと数える(C-23) |
| 経過時間 | タイムアウト 5 秒 × 2 × (8 / 3 の切り上げ = 3 巡) = 最悪 30 秒(上限 15 分) |
| CPU | 復号 8 回・JSON の解析 16 回(各数十 KB 以内)。数 ms の見込み。本番で実測する(C-24) |

`MAX_ACTIVE_RECORDINGS` を 8 にしたのは上の D1 クエリ数の上限から(10 にすると最悪 57 で超える)。

### 17.4 Cron を Astro の Worker に同居させる方法

**一次資料**: Astro 公式の `@astrojs/cloudflare` ガイド(<https://docs.astro.build/en/guides/integrations-guide/cloudflare/>、2026-10-17 閲覧。v13 以降の「Custom entrypoint API」)に、`wrangler.jsonc` の `"main": "./src/worker.ts"` と、`@astrojs/cloudflare/handler` の `handle` に `fetch` を委譲して `queue` などのハンドラを並べた Worker オブジェクトを default export する例がある。`scheduled` の例は無いが、`scheduled` は `queue` と同じく Workers の標準のハンドラ(`ExportedHandler`)の一員で、書き方は同じ。Cloudflare 公式の Cron Triggers の資料(<https://developers.cloudflare.com/workers/configuration/cron-triggers/>)で `triggers.crons` の書式・`* * * * *` が使えること・UTC・反映に最大 15 分かかることを確認した。無料プランの Cron はアカウントあたり 5 個まで、Cron 1 回の CPU は 10 ms(Workers の Limits の資料)。

**採用**: `src/worker.ts`(architect が作成済み。中身は呼び出しだけ):

```ts
import { handle } from '@astrojs/cloudflare/handler';
export default {
  fetch: handle,
  async scheduled(controller, env, ctx) { /* backend: ctx.waitUntil(runCron(env, controller.scheduledTime)) */ },
} satisfies ExportedHandler<Cloudflare.Env>;
```

`wrangler.jsonc` の `main` を `@astrojs/cloudflare/entrypoints/server` から `./src/worker.ts` に変えた(既定のエントリも `{ fetch: handle }` だけなので、`fetch` の動作は変わらない)。

**ローカルでの確認(2026-10-17、`@astrojs/cloudflare@14.3.4`、wrangler 4.151)**: `pnpm check` / `pnpm test` が通る。`pnpm build` が成功し、`dist/server/entry.mjs` が `scheduled` を含む Worker を export し、`dist/server/wrangler.json` に `triggers.crons` が入る。`wrangler dev --test-scheduled` で `/login` が 200(fetch が Astro に届く)、`/cdn-cgi/handler/scheduled` が `ok`(scheduled が呼ばれる)。**本番(Workers Builds・Deploy ボタン経由)での Cron の起動は未確認**(C-10)。

**代替案**(本番で動かなかった場合): (a) Cron 専用の小さな Worker を同じリポジトリに置き、同じ D1 をバインドする(`wrangler.jsonc` が 2 つになり、Deploy ボタンで 2 つ目を作れるかが新たな要確認になるため第 2 候補)。(b) Cron Worker が本体の `/internal/cron` を叩く(秘密の共有が要り、Secrets を使わない方針と合わないため不採用)。(c) 外部の定期実行サービス(Cloudflare の外に設定が増えるため不採用)。

### 17.5 終了条件

判定の順は 17.3 の 3。理由のコードは `MATCH_END_REASONS`(カタログ `match.endReason.*`)。

| 理由 | 条件 | 備考 |
|---|---|---|
| `score_cap` | 保存したサンプルの `factionScores` のいずれかの `score` ≥ 実効の上限 | 実効の上限 = `status.scoreCap`(正の数のとき)→ `servers.score_cap` → `SCORE_CAP_DEFAULT`(100)。Cron が `status.scoreCap` を読めて記録の値と違えば、記録の `score_cap` / `score_cap_source = 'status'` を更新する(変化したときだけ)。**スコアが「上限に向かって増える」前提**(減っていく方式なら判定が合わない。R-21) |
| `manual` | 「記録を停止」(`record_stop`) | 17.2 |
| `map_changed` | `status.map` が開始時のマップと違う | ゲーム内・ほかのツールでのマップ変更・試合終了・サーバーの再起動を含む。`status.map` が取れない分は判定しない |
| `match_action` | このパネルの `map` / `match_end` の execute が成功 | 次の Cron を待たずに終える |
| `empty` | 人数 0 が 10 分(`RECORDING_EMPTY_END_MS`)続いた | 人数は `status.players.current` |
| `max_duration` | 開始から 3 時間(`RECORDING_MAX_DURATION_MS`) | RCON に届かない状態が続いた場合の保険も兼ねる |
| `server_unavailable` | サーバーの削除・無効化・パスワードを読み出せない | Cron が検出(削除の API では終えない。17.7) |

- 試合が終わっても**次の試合を自動では記録しない**(ユーザー決定の範囲外。必要なら「連続記録」を第 2 段階で検討する。要確認 U-20)。
- 開始時点で既に上限に達していても開始は拒否しない(次の Cron で `score_cap` になる)。

### 17.6 キルフィード受信(第 1 段階: 観測モード)

資料(`docs/research/wardogs-rcon.md` 2.4、未検証)では、ゲームサーバーの `[WDServerFeed]` に `Url` と `Token` を書くと、ゲームが `Url + /api/ingest/events` に `Authorization: Bearer <Token>` で `killed` イベントを約 2 秒ごとにバッチ POST する。第 1 段階は**形式を確かめるための受け皿**で、受けた本文を解釈せずに保存して見せるだけにする。

**エンドポイント**: `POST /api/ingest/events`(`src/pages/api/ingest/events.ts`)。認証はログイン Cookie ではなく受信用トークン。middleware の扱いは 5.5・5.8。

**処理の順序と応答**(本文を読まずに返すときは 64 KiB まで読み捨てる。`discardBody`):

| 順 | 確認 | 失敗時 |
|---|---|---|
| 1 | メソッドが POST | 405 `METHOD_NOT_ALLOWED` |
| 2 | D1 の判定(middleware) | 503 `NOT_CONFIGURED` |
| 3 | `Authorization: Bearer <token>` があり、`FEED_TOKEN_PATTERN`(`wof1.<ServerId>.<43 文字>`)に合う | 401 `FEED_TOKEN_INVALID`(`WWW-Authenticate: Bearer`。D1 を読まない) |
| 4 | `server_feeds` の `<ServerId>` の行(isolate 内に 60 秒キャッシュ)の `token_hash` と `SHA-256(token)` を **定数時間で比較**(32 バイト同士、`crypto.subtle.timingSafeEqual`)| 行が無い・不一致 → 401 `FEED_TOKEN_INVALID`(不一致は `last_rejected_reason = token_invalid`) |
| 5 | そのサーバーの 1 分の回数 ≤ 90(`FEED_RATE_PER_MIN`。isolate 内の固定窓) | 429 `RATE_LIMITED`(`Retry-After`) |
| 6 | `Content-Type` が `application/json`(`; charset=...` 可) | 415 `UNSUPPORTED_MEDIA_TYPE` |
| 7 | 本文 ≤ 64 KiB(`FEED_MAX_BODY_BYTES`。`Content-Length` と実際に読んだ量の両方) | 413 `PAYLOAD_TOO_LARGE` |
| 8 | UTF-8 の JSON として読める | 400 `BAD_REQUEST`(`bad_json`) |
| 9 | 空のバッチ(本文が空、`[]`、または `events` が空配列のオブジェクト)| **204 で返し、D1 に書かない**(受信の状況の更新を除く) |
| 10 | 保存してよいか: `server_feeds.enabled = 1`、サーバーがあり有効 | 204(保存せずに捨てる。`last_dropped_reason = disabled / server_unusable`) |
| 11 | 1 日の上限(17.8): サーバーごと 1,000 件・4 MiB、全体 4,000 件・16 MiB | 204(捨てる。`daily_limit` / `global_limit`) |
| 12 | `feed_raw_events` に INSERT(本文は受けた文字列のまま。`event_count`、受信時に記録中の試合 `recording_id`) | 成功 204。D1 の失敗は 500 `INTERNAL_ERROR` |

- **既知外の JSON でも保存する**(観測が目的)。配列でもオブジェクトでも、`killed` 以外のイベントが混ざっていても、そのまま 1 行に入れる。`event_count` は「配列ならその長さ、`events` 配列を持つオブジェクトならその長さ、それ以外は NULL」。
- 1 日の上限の判定と加算は 1 文の UPSERT で行う: `INSERT INTO feed_daily (server_id, day, batches, bytes) VALUES (?, ?, 1, ?) ON CONFLICT (server_id, day) DO UPDATE SET batches = batches + 1, bytes = bytes + excluded.bytes WHERE batches < ?上限 AND bytes + excluded.bytes <= ?上限 RETURNING batches`。行が返らなければ上限で捨てる。サーバーごと → 全体(`server_id = 0`)の順に行い、全体で断られた場合はサーバーの分が 1 件多く数えられたまま残る(上限の判定が少し早まるだけで、害は無い)。
- **上限・無効で捨てるときも 204** を返す(4xx / 5xx を返すと、ゲームが再送して回数が増える可能性があるため。ゲームの再送の挙動は K-6)。
- **受信の状況**(`last_received_at` 等)は isolate ごとにサーバーあたり 1 分に 1 回までしか D1 に書かない(空のバッチを含めて「届いている」ことを設定タブで確かめられるようにしつつ、書き込みを 1,440 行/日・台に抑える)。
- 応答は 204 か `ApiFailure` の JSON(セキュリティヘッダ付き)。本文・トークン・`Authorization`・接続元 IP はログに出さない。Workers Logs には `{ kind: 'ingest', server, result: <204 の種類 or コード>, bytes }` だけ。

**トークン**

| 項目 | 決定 |
|---|---|
| 形式 | `wof1.<ServerId>.<32 バイトの乱数の base64url>`(`FEED_TOKEN_PATTERN`。ini に書いても困る記号を含まない) |
| 保存 | **SHA-256 のハッシュだけ**(`server_feeds.token_hash = 'sha256$<base64url>'`)と末尾 4 文字(`token_hint`)。平文は発行の応答で 1 回だけ返し、二度と表示しない。失くしたら再発行 |
| 発行・再発行 | `POST /api/servers/:id/feed-token`(ログイン必須・CSRF 検査あり)。再発行すると古いトークンは使えなくなる(他の isolate のキャッシュが切れるまで最大 60 秒)。`settings_audit_log` に `feed_token_issue`(`params: { reissued }`。値・ハッシュは入れない) |
| 取り消し | `DELETE /api/servers/:id/feed-token`(本文 `{}`)で行を消す(受信の状況も消える)。`feed_token_revoke`。サーバーの削除(`DELETE /api/servers/:id`)でも同じ batch で消す |
| 比較 | ServerId で 1 行を主キーで引き、ハッシュ同士を定数時間で比較(4 の行) |

根拠(ハッシュ保存で 1 回だけ表示、を選んだ理由): (1) 漏れた場合の影響は「観測データに偽の行を入れられる」だけで、平文を後から見せる必要性が低い。(2) 暗号化保存(再表示可)にすると、ログインできる人(Cookie を盗んだ人を含む)がいつでも取り出せる。(3) 乱数 32 バイトなので、ハッシュに遅い方式(PBKDF2 等)は要らない(総当たりできない)。不便さ(再表示できない)は「再発行してゲーム側を書き換える」で解消できる。ServerId をトークンに含めるのは、ハッシュの一致探索ではなく主キーで 1 行を引いて定数時間で比較するため(ServerId は秘密ではない)。

**ゲーム側の設定の案内**(設定タブ。値は例):

```ini
[WDServerFeed]
Url=https://<パネルのホスト名>
Token=<発行したトークン>
```

- `Url` には**パネルの URL だけ**(末尾の `/` なし。`/api/ingest/events` はゲームが付ける)を書く。画面は自分のオリジン(`Astro.url.origin`)を表示してコピーできるようにする。
- セクション名・キー名・`Url` の後ろへの付け方・HTTPS に対応しているかは未検証(K-1、K-4、K-7)。設定ファイルの場所と編集の手順はサーバーの提供元によって違う(README では一般的な説明だけにする)。
- 「受信を止める」スイッチ(`enabled = 0`)は**保存を止めるだけで、ゲームからの送信(Worker のリクエスト数)は止まらない**。止めるには ini から `Url` を消す(または空にする)ことを画面と README に明記する。

**脅威と対策**: 受信エンドポイントは誰でも叩ける(ログイン画面と同じ)。トークンが無ければ D1 を読まずに 401。トークンが漏れても RCON・パネルの操作には使えない(RCON パスワードとは別の値。サーバーごと)。偽の本文は観測データを汚すだけで、第 2 段階で集計に使う前に再発行できる。CPU を使わせる攻撃(大きな本文)は 64 KiB とレート制限で抑える。リクエスト数の消費(無料枠)はログイン画面と同じく防げない(11.1)。

### 17.7 保持と掃除

| 対象 | いつ | 規則 |
|---|---|---|
| 試合とサンプル(終了時) | 試合を終えたとき(17.3 の 4、17.2) | そのサーバーの終了済みの試合のうち、新しい順で 6 番目以降と、`ended_at` が 30 日より古いものを `match_samples` ごと削除(1 回の削除は最大 5 試合 × 181 行程度) |
| 試合とサンプル(定期) | Cron の毎時 17 分(UTC。`CLEANUP_MINUTE_UTC`) | 30 日より古い終了済みの試合、所属する試合が無いサンプル(`CLEANUP_BATCH_ROWS` = 2,000 行まで) |
| `feed_raw_events` | 毎時 17 分 | `received_at` が 7 日より古い行を 2,000 行まで(1 時間の最大の保存件数 4,000 / 24 ≒ 170 件より十分多い) |
| `feed_daily` | 毎時 17 分 | `day` が 8 日より前の行 |
| `server_feeds` | サーバーの削除時(同じ batch)/ 毎時 17 分 | サーバーが無い行 |
| 記録中の試合 | サーバーの削除時は消さない | 次の Cron が `server_unavailable` で終え、以後は通常の保持に従う |

既存のログイン時の掃除(8.4)は変えない。

### 17.8 無料枠の見積り(11 章への追加)

**Workers リクエスト(10 万/日)**

| 発生源 | 1 日の最大 | 備考 |
|---|---|---|
| Cron | 1,440 | リクエスト数に数えられるかは未確認(C-9)。数えられても 1.4% |
| 受信(1 台が約 2 秒ごとに送る場合) | 約 43,200 | 空のバッチも数える。空のときも送るかは未検証(K-3) |
| パネルの画面(11.1) | 約 2,100〜17,800 | サイドバー込み |
| キルフィードタブ(記録中の試合を 60 秒ごと) | 1 タブ 1,440 | 開いている間だけ |

- 受信を **1 台**で常時続けても、パネルの多めの利用と合わせて約 6.3 万/日で収まる。**2 台以上で常時受信すると無料枠を超え得る**(超えると当日 UTC 0 時〔JST 9 時〕まで Worker 全体が止まり、パネルも使えなくなる)。Worker 側で受信を止めても、ゲームが送る限りリクエストは数えられる(17.6)。
- 方針: README と設定タブで「観測は 1 台ずつ」「形式を確かめたら ini から `Url` を消す」と案内する。受信の回数は D1 に数えない(書き込みが増えるため)ので、正確な回数は Cloudflare のダッシュボード(Workers の Metrics)で見るよう案内する。

**D1 の書き込み(10 万行/日)**

| 発生源 | 計算 | 1 日の最大 |
|---|---|---|
| スコア記録 | 1 台が 24 時間記録し続けて 1,440 行 + 開始・終了・`empty_since` 数十行。`WITHOUT ROWID` で 1 行 1 書き込みの見込み(C-17)| 1 台 約 1,500、上限 8 台で約 1.2 万(12%) |
| 受信の保存 | 1 件 = 本文の行 + 索引 2 + 日次カウンタ 2 ≒ 5 行。全体の上限 4,000 件 | 約 2 万(20%) |
| 受信の状況 | 1 台 1 分 1 回 | 1 台 1,440 |
| 既存(11.3、15.9) | | 約 1,500(通常)〜 約 1.2 万(最悪) |

最悪をすべて足しても約 4.7 万行(上限の半分弱)。通常(1 台を数試合記録、受信なし)は数千行。

**D1 の読み取り(500 万行/日)**: Cron は 1 分 1 回の一覧(記録中の行数分)と、記録中なら 1 台数行。受信は 1 件ごとにトークンの 1 行(60 秒キャッシュで減る)+ 記録中の試合の 1 行。グラフは 1 試合 181 行 × 表示回数。いずれも 500 万に遠い。

**ストレージ(1 データベース 500 MB)**: 生データは全体で 16 MiB/日 × 7 日 = 最大約 112 MiB。サンプルは 1 行 300 バイト程度 × 181 行 × 6 試合 × 20 台 ≒ 6.5 MB。

**CPU(10 ms)**: 受信 1 件 = SHA-256 1 回 + 64 KiB までの JSON.parse 1 回(1 ms 未満の見込み)。グラフの API は 181 行の JSON の解析。Cron は 17.3。

### 17.9 画面

**概要タブ(`/`)**: 「よく使う操作」の近くに「スコア記録」の節を足す。

- 記録していないとき: 「記録を開始」ボタン(`action.help.record_start` を直下に。押すと確認ダイアログ〔`confirm.record_start`、prepare が返したマップと上限を表示〕)。
- 記録中: 開始時刻・経過時間・上限(と出所: サーバーの値 / 設定 / 既定)・最後のサンプルの時刻、「記録を停止」ボタン(`confirm.record_stop`)、キルフィードタブへのリンク(「推移を見る」)。
- 上限に達していない・RCON に届かない等で Cron がサンプルを取れていない場合は、最後のサンプルの時刻で分かるようにする(エラーは出さない)。
- データ源は `GET /api/matches?server=`(表示時に 1 回、操作の後、記録中は 60 秒ごと)。`RECORDING_LIMIT_REACHED` などのエラーはカタログの `error.*`。

**キルフィードタブ(`/killfeed`)**: 「準備中」をやめ、アイランド(`src/components/KillfeedPanel.tsx`)にする。上から:

1. **試合の選択**: 「現在の試合(記録中)」+ 直近 5 試合(開始時刻・マップ・終了理由)。記録が 1 つも無ければ「概要タブで記録を開始してください」の案内。
2. **グラフ**(`src/components/ScoreChart.tsx`。外部ライブラリ無しの SVG):
   - 表示の切り替え: **スコア** / **cash**(ボタン 2 つ。`aria-pressed`)。スコア: 陣営ごとの折れ線と上限の横線。cash: 全員の合計の折れ線 + 陣営ごとの合計の折れ線(17.1 の `cashTotal` / `factions[].cash`)。
   - 横軸は開始からの経過分、縦軸は 0〜最大値(スコアは上限と最大値の大きい方)。目盛りは 4〜5 本。数値は `formatNumber`、時刻は `formatDateTime`(13.4)。
   - 陣営名は RCON の生データ(翻訳しない)。色は最大 3 陣営 + その他の固定の配色(`ops.css` のトークン)に**線の種類(実線・破線・点線)**を組み合わせ、凡例に名前を書く(色だけで区別させない)。
   - SVG は `viewBox` で幅に追従させ、`role="img"` と `aria-label`(例「スコアの推移。{faction}: {score} …」)。グラフの下に最後のサンプルの値の表と、全サンプルの表(折りたたみ)を置く(読み上げ・コピー用)。
   - 375px でも横スクロールを出さない(SVG は `width: 100%`、凡例は折り返す)。
   - データ源: `GET /api/matches/:id/samples`。記録中の試合を表示している間だけ 60 秒ごとに取り直す(終了済みは 1 回)。
3. **試合の要約**: 開始・終了・理由(`match.endReason.*`)・上限と出所・サンプル数・最後の陣営スコア。
4. **受信した生データ(観測モード)**: 「キルフィードは準備中です。ゲームサーバーから届いたデータをそのまま表示しています」の趣旨。トークン未発行なら設定タブへの案内。発行済みなら最新 20 件(受信時刻・バイト数・イベント数・本文)。本文は `<pre>` に**テキストとして**出し(HTML として解釈しない)、既定は折りたたみ。「更新」ボタン(手動)と「さらに読み込む」(`before`)。データ源は `GET /api/feed/raw?server=`。

**設定タブ(`/servers`)**: サイドバーで選んでいるサーバーについて、「サーバー」の節の下に 2 節を足す(全サーバー分を並べない。長くなるため)。

- **スコア記録**: 上限(数値の入力、空欄で既定 100)。「サーバーが上限を返す場合はそちらを使います」の注記。保存は `PUT /api/servers/:id`(`scoreCap`)。
- **キルフィード(観測モード)**: 受信の状況(`GET /api/servers/:id/feed`: 最後に受信・保存・拒否〔理由 `feed.reject.*`〕・捨てた〔`feed.drop.*`〕時刻、今日の件数とバイト数、上限)、トークンの発行 / 再発行 / 取り消し、保存の有効・無効、17.6 の ini の案内。トークンは発行直後に 1 回だけ表示し(コピーボタン)、「この画面を閉じると二度と表示されません」と書く。注意書き: 2 秒ごとの送信は 1 台で 1 日約 4.3 万リクエストになり得ること、2 台以上での常時受信は無料枠を超え得ること、止めるには ini の `Url` を消すこと。

**ナビゲーション**: `src/layouts/nav.ts` のキルフィードの `comingSoon` を false にし、縦ナビにも出す(`inSidebar: true`)。

**サイドバー**: 記録中なら試合の要点に「記録中」の印を出してよい(任意。`/api/status` には含めないので、出すなら概要タブと同じ `GET /api/matches` を引くことになる。リクエストが増えるため今回は出さない。要確認 U-23)。

**カタログ**(frontend-pages が足すもの。architect が足したものは 17.11): `recording.*`(概要タブの節)、`killfeed.*`(タブ。`killfeed.comingSoon` / `killfeed.why` は観測モードの説明に書き換え)、`chart.*`(切り替え・軸・凡例・表)、`feed.*`(設定タブの節と生データ)、`settings.recording.*`。

### 17.10 第 2 段階: キルの正規化・集計・画面(2026-10-17)

2026-10-17 のユーザー要望(参考パネルのキルフィード画面と同等の表示)を受けて確定した。**第 1 段階(17.6 の受信の HTTP 契約・トークン・`feed_raw_events`・`GET /api/feed/raw`)は変えず、追加のみ**。契約は `src/types/api.ts`(「キルフィード 第 2 段階」の節)、`db/migrations/0004_killfeed.sql`、`docs/API.md` 11 章。届く本文の実際の項目名は**未確認のまま**(K-1、K-9〜K-14)で、本節は「候補名の対応表で読み、読めない項目は null」にして、観測で本物を見たら対応表の 1 か所を直せば済む形にする。

#### 17.10.0 決定の要約

| 項目 | 決定 |
|---|---|
| 正規化 | 受信時に本文を `normalizeFeedBatch(body)`(`src/lib/killfeed/normalize.ts`)で `KillEvent` に変換する。項目ごとに**候補名の対応表**(`src/lib/killfeed/fields.ts` の `KILL_FIELD_CANDIDATES`。1 か所)を先頭から試し、読めない項目は null。`killed` 以外の種類は保存せず件数だけ数える(17.10.2) |
| 保存 | **正規化したキルを `feed_kills` に 1 キル 1 行で保存**する(生データから都度計算しない)。生データの保存は別のスイッチ(`server_feeds.raw_enabled`)で止められる(17.10.3) |
| 陣営 | イベントに陣営があればそれ、無ければ**受信時の直近のプレイヤー一覧の観測**(Cron がサンプルと同じ行に書く `match_samples.roster_json`。3 分以内)から Steam ID で引く。どちらも無ければ不明(画面は「?」)。チームキルは両方の陣営が同じ出所で分かるときだけ判定(17.10.4) |
| 試合への割り当て | 受信時に記録中の試合(`match_recordings`)に割り当てる(第 1 段階の `recording_id` と同じ判定)。記録していない間のキルは**記録外**(`recording_id = 0`)として直近 500 件・7 日だけ見られる(17.10.5) |
| 集計 | **ブラウザで計算する**。API は試合のキルの一覧(最大 3,000 件)を 1 回で返し、記録中は 30 秒ごとに差分だけ取る。統計カード・時間帯別・武器別・距離・上位・最長・フィルタ・検索・JSON 出力はすべてブラウザ側(`src/components/lib/killstats.ts`)。集計用・出力用の API は作らない(17.10.6) |
| API(追加) | `GET /api/killfeed/kills`(一覧と差分)、`GET /api/feed/raw/:id/normalized`(保存済みの生データに今の対応表で正規化を試す。対応表の見直し用)、`PUT /api/servers/:id/feed` の `rawEnabled`(API.md 11 章) |
| 画面 | 参考パネルと同じ並び: 試合の選択 → 現在のスコア・推移 → 統計カード 5 枚 → 時間帯別 → 最長キル → 上位のプレイヤー・武器 → 距離 → キルログ(フィルタ 8 種・検索・JSON 出力)→ 生データ(観測モード)。外部ライブラリ無しの SVG、375px 対応(17.10.7) |
| 上限 | 1 バッチ 100 キル、1 日サーバーごと 3,000 キル・全体 8,000 キル(超えた分は 204 で受けて捨て、件数を数える)(17.10.8) |
| 保持 | 試合に属するキルは試合と同じ(直近 5 試合 + 記録中・30 日。試合の削除でトリガーが消す)。記録外は 7 日(17.10.9) |

#### 17.10.1 想定スキーマ(`KillEvent`)

参考パネルの表示(項目名は参考パネルの表示で、本文のフィールド名ではない)から、1 キルに要る項目を決めた。型の正本は `src/types/api.ts` の `KillEvent`。

| 項目 | 型 | 参考パネルの表示 | 備考 |
|---|---|---|---|
| `receivedAt` | 受信時刻 | 受信時刻(UTC) | Worker の時刻。時間帯別・試合への割り当てはこれ |
| `eventAt` | 時刻 / null | − | 本文に時刻があり、受信の前後 1 日以内のときだけ |
| `gameTimeSec` | 秒 / null | `GAME 52:31` | 試合開始からの経過と見られる(K-13) |
| `killer` / `victim` | `{ name, steamId, faction, factionSource }` / null | 名前 + 陣営アイコン | `steamId` は `STEAM_ID_PATTERN` に合うものだけ。`killer = null` は環境による死亡・読めない |
| `weapon` | `{ id, name }` | 武器名、または `WEPN_031` のような内部 ID | 両方 null = 不明 |
| `vehicle` | `{ id, name }` / null | `TNK_01 · Anti Air`(乗り物 + 兵装) | 表示は「乗り物 · 武器」 |
| `flags` | `headshot` `penetration` `roadkill` `vehicleExplosion` `suicide` | HEADSHOT 等の印 | `KILL_FLAGS` |
| `teamkill` | 真偽 / null | TEAMKILLS | 読み取り時に Worker が付ける(17.10.4) |
| `distanceM` | m / null | 距離(不明あり) | 単位は要確認(K-9) |

キルごとの得点は持たない(参考パネルにも「フィードに無い」とある。届くかは K-9 で確認)。

#### 17.10.2 正規化層(`src/lib/killfeed/`)

**入口**: `normalizeFeedBatch(bodyText, opts) → { envelope, kills: NormalizedKill[], counts: { kill, other, incomplete, invalid }, bigIntegersQuoted, diagnostics? }`。1 イベントは `normalizeFeedEvent(value) → FeedNormalizedEvent`(型は `src/types/api.ts`)。純粋関数で D1・時刻に依存しない(受信時刻は引数)。受信(17.10.3)と正規化の試行の API(API.md 11.2)が同じ関数を使う。

**1. 本文を読む(長い整数を守る)**: 17 桁の Steam ID が引用符無しの数値で届くと、`JSON.parse` で桁が落ちる(2^53 を超えるため。K-10)。そこで JSON の文字列の外にある **16 桁以上の整数**(小数点・指数が続かないもの)を、解析の前に引用符で囲む(文字列の内外とエスケープを追う 1 回の走査。64 KiB で 1 ms 未満の見込み)。囲んだ数を `bigIntegersQuoted` に数える。生データの保存(`feed_raw_events.body`)は受けた文字列のまま(変えない)。

**2. 外側の形**(`envelope`): 配列 → 各要素 / `events` 配列を持つオブジェクト → 各要素 / 種類の項目を持つオブジェクト → 1 件(`single`)/ それ以外 → 0 件(`unknown`)。オブジェクトでない要素は `invalid`。

**3. 種類の判定**: 種類の候補(下表 `type`)の値を、英数字以外を除いて小文字にし、`killed` `kill` `playerkilled` `death` `playerdied`(`KILL_EVENT_TYPES`)なら kill。それ以外の値は `other`(キルログに出さず件数だけ)。種類の項目が**どの候補にも無く**、被害者が読めるなら kill とみなす(資料では種類は `killed` だけのため)。

**4. 対応表**(`KILL_FIELD_CANDIDATES: Record<KillFieldName, readonly FieldCandidate[]>`。`FieldCandidate = string | { path: string; scale?: number }`。パスはドット区切り。**先頭から試し、型の検証に通った最初の値を使う**。下の候補はすべて推測で、観測で確定させる):

| 項目(`KillFieldName`) | 候補(この順) | 検証・変換 |
|---|---|---|
| `type` | `type` `event` `eventType` `kind` `action` | 文字列(64 文字まで) |
| `eventAt` | `timestamp` `time` `at` `occurredAt` `createdAt` `utc` `ts` | ISO 8601 の文字列、または数値(10^12 以上はミリ秒、10^9 以上は秒)。受信の前後 1 日を外れたら null |
| `gameTimeSec` | `gameTime` `gameTimeSec` `matchTime` `matchSeconds` `elapsed` `elapsedSec` `roundTime` | 0〜86,400 の数値(秒)、または `m:ss` / `h:mm:ss` の文字列 |
| `killerName` | `killer.name` `killer.playerName` `killer.displayName` `killer.nick` `attacker.name` `attacker.playerName` `instigator.name` `killerName` `killer_name` `attackerName` `attacker_name` `killer`(文字列で 17 桁でないとき) | 文字列。制御文字を除き 64 文字まで。空なら null |
| `killerSteamId` | `killer.steamId` `killer.steamID` `killer.steam_id` `killer.steamId64` `killer.playerId` `killer.uniqueId` `killer.id` `attacker.steamId` `attacker.id` `instigator.steamId` `killerSteamId` `killer_steam_id` `killerId` `attackerSteamId` `killer`(文字列で 17 桁のとき) | 文字列にして `STEAM_ID_PATTERN`。合わなければ次の候補 |
| `killerFaction` | `killer.faction` `killer.team` `killer.teamName` `killer.side` `attacker.faction` `attacker.team` `killerFaction` `killerTeam` `killer_team` `attackerTeam` | 文字列(数値は 10 進の文字列にする)。64 文字まで |
| `victimName` / `victimSteamId` / `victimFaction` | 上の 3 行の `killer` を `victim` `killed` `target` `dead` `player` に、`attacker` / `instigator` を除き、平らな名前を `victimName` `victim_name` `victimSteamId` `victim_steam_id` `victimId` `victimFaction` `victimTeam` `victim_team` にしたもの | 同上 |
| `weaponId` | `weapon.id` `weapon.code` `weapon.class` `weaponId` `weapon_id` `weaponClass` `damageType` | 文字列。64 文字まで |
| `weaponName` | `weapon.name` `weapon.displayName` `weaponName` `weapon_name` `weapon`(文字列のとき) `vehicleWeapon` `seatWeapon` `cause` `causeName` | 同上 |
| `vehicleId` | `vehicle.id` `vehicle.code` `vehicleId` `vehicle_id` `killerVehicle.id` | 同上 |
| `vehicleName` | `vehicle.name` `vehicle.displayName` `vehicleName` `vehicle_name` `vehicle`(文字列のとき) `killerVehicle.name` | 同上 |
| `distanceM` | `distanceM` `distance_m` `distanceMeters` `distance` `range` `{ path: 'distanceCm', scale: 0.01 }` `{ path: 'distance_cm', scale: 0.01 }` | 0 以上 `KILLFEED_DISTANCE_MAX_M` 以下の数値(文字列の数値も可)。小数第 1 位に丸める。`distance` の単位(m か cm か)は K-9 |
| `headshot` | `headshot` `isHeadshot` `headShot` `hs` | 真偽: `true`/`false`、`1`/`0`、`"true"`/`"false"` |
| `penetration` | `penetration` `isPenetration` `penetrated` `wallbang` | 同上 |
| `roadkill` | `roadkill` `isRoadkill` `roadKill` | 同上 |
| `vehicleExplosion` | `vehicleExplosion` `isVehicleExplosion` `vehicle_explosion` | 同上 |
| `suicide` | `suicide` `isSuicide` | 同上 |
| `flagList` | `flags` `tags` `modifiers` `hitFlags` | 文字列の配列、または区切り文字を含む 1 つの文字列。各語を大文字・英数字だけにして `HEADSHOT` / `PENETRATION`・`WALLBANG` / `ROADKILL` / `VEHICLEEXPLOSION` / `SUICIDE` を印に足す(個別の真偽の項目と OR) |

**5. 組み立て**:

- 当事者は「名前・Steam ID のどちらかがある」ときだけオブジェクトにする(両方無ければ null)。陣営を本文から得たら `factionSource = 'event'`。
- **自殺**: `suicide` の印、または両者の Steam ID が分かって同じ。自殺のときは `killer` を残す(画面は「自殺」の印)。
- **incomplete**: kill と判定したが被害者もキラーも読めない → 保存しない(`incomplete` に数える。対応表の見直しの印)。
- 1 バッチの kill は先頭から `KILLFEED_MAX_KILLS_PER_BATCH`(100)件まで。超えた分は `droppedKills`。
- 試行の API 用に、項目ごとに使った候補(`matched`)と、どの候補にも使われなかった最上位のキー(`unmappedKeys`、値は含めない)を返せるようにする(`opts.diagnostics`)。受信の処理では作らない(CPU の節約)。

**直し方**(観測の後): キルフィードタブの「受信した生データ」で 1 件を選び「正規化の結果」(API.md 11.2)を見る → 読めていない項目の実際のキー名を `fields.ts` の該当行の**先頭**に足す → テスト(`normalize.test.ts` に本物の形のダミーを 1 件足す)→ デプロイ。直す前に保存したキルは直らない(生データからの作り直しは要確認 U-31)。

#### 17.10.3 受信の処理の追加と保存(`feed_kills`)

17.6 の表の 1〜10(トークン・レート制限・形式・空のバッチ・`enabled`)は**そのまま**。応答(204 / 4xx / 5xx)も変えない。10 の後を次のようにする:

| 順 | 処理 | 備考 |
|---|---|---|
| 11 | `normalizeFeedBatch`(17.10.2) | CPU のみ。8 の JSON の解析をこれに置き換えてよい(`event_count` の数え方は変えない) |
| 12 | **生データ**: `raw_enabled = 1` なら 17.6 の 11・12(1 日の上限 → `feed_raw_events` に INSERT)。上限で断られたら**生データだけ**捨てる(`last_dropped_reason` は従来どおり) | 第 1 段階では上限でバッチ全体を捨てていたが、キルの保存は次の 13 の上限に従う |
| 13 | **キル**: kill が 1 件以上なら、日次カウンタ(`feed_daily.kills`)をサーバー → 全体(`server_id = 0`)の順に `INSERT ... ON CONFLICT (server_id, day) DO UPDATE SET kills = kills + excluded.kills WHERE kills + excluded.kills <= ?上限 RETURNING kills` で足す。行が返らなければそのバッチのキルを全部捨てる(`droppedKills`) | 一部だけ保存はしない(単純さ優先) |
| 14 | 陣営を付ける(17.10.4)。記録中の試合があり、陣営の無い当事者がいるときだけサンプルを 1 行読む | isolate 内に 30 秒キャッシュ |
| 15 | `INSERT INTO feed_kills (...) SELECT json_extract(value, '$.…'), … FROM json_each(?)` の **1 文**でまとめて入れる(バインドは JSON の文字列 1 つ) | D1 のバインド変数の上限(1 文 100 個)を避けるため。`json_each` の可否・大きさの上限は C-25 |
| 16 | `other` / `incomplete` / `droppedKills` の件数は isolate 内で足し、受信の状況の更新(1 分に 1 回まで。17.6)と同じ機会に `feed_daily` の `other_events` / `incomplete` / `dropped_kills` に UPSERT で足す | 1 イベントごとに書かない(キル以外のイベントが 2 秒ごとに届いても書き込みが増えない) |

- D1 の失敗(12・13・15)は従来どおり 500 `INTERNAL_ERROR`。13 で数えた後に 15 が失敗すると、その分だけ上限が早く来る(害は無い)。
- Workers Logs は従来の 1 行に `kills`(保存数)・`other`・`incomplete` の件数だけを足す(名前・Steam ID は出さない)。
- `enabled = 0`・サーバーが無効のときは従来どおり何も保存しない。

**`feed_kills` の列**(0004。8.14): `id`(INTEGER PRIMARY KEY。AUTOINCREMENT にしない)、`server_id`、`recording_id`(0 = 記録外)、`received_at`、`event_at`、`game_time_sec`、キラーと被害者の `name`・`steam_id`・`faction`・`faction_source`、`weapon_id`・`weapon_name`、`vehicle_id`・`vehicle_name`、`flags`(ビット: 1 headshot / 2 penetration / 4 roadkill / 8 vehicleExplosion / 16 suicide)、`distance_m`。索引は `(server_id, recording_id, received_at)` の **1 本だけ**(一覧・差分・試合の削除・記録外の期限切れの削除をすべてこれで引く。書き込みは 1 キル = 本体 1 + 索引 1)。

**生データから都度計算しない理由**: (1) 陣営は「受信した時点のプレイヤー一覧」で決まるので、受信時に決めて残す必要がある。(2) 生データは 7 日・観測が終われば止める前提で、試合(30 日)より短い。(3) 1 試合 300 キルでも本文は数十〜数百行あり、表示のたびに解析すると読み取り行数と CPU が表示回数に比例して増える。(4) 1 キル 1 行なら一覧の読み取りは索引の範囲検索 1 回で済む。

#### 17.10.4 陣営の付与

参考パネルと同じく、イベントに陣営が無い場合は**直近のプレイヤー一覧の観測**から付ける。

- **観測の置き場所**: Cron(17.3)が記録中の試合ごとに毎分 `GET /v1/players` を取っているので、そのサンプルの行に `roster_json`(0004 で `match_samples` に足した列)として `{"f":["<陣営名>",…],"p":{"<SteamID>":<f の添字>,…}}` を書く(**プレイヤー名は入れない**。最大 `KILLFEED_ROSTER_MAX_PLAYERS` 人。`/v1/players` が取れない・陣営が無ければ NULL)。**同じ INSERT の列が 1 つ増えるだけで、Cron のクエリ数は増えない**(17.3 の上限 50 に対して余裕が無いため、別の表にはしない)。
- **引き方**: 受信時、記録中の試合があれば `SELECT taken_at, roster_json FROM match_samples WHERE recording_id = ? ORDER BY bucket_minute DESC LIMIT 1`(主キーで 1 行)。`taken_at` が受信時刻から `KILLFEED_ROSTER_MAX_AGE_MS`(3 分)以内なら、Steam ID で陣営を引き `factionSource = 'roster'`。見つからない・古い・記録外 → null(画面は「?」)。
- **チームキル**(`teamkill`、読み取り時に付ける): 自殺でなく、両者の陣営が null でなく、**出所が同じ**(両方 `event` か両方 `roster`)なら「同じ陣営か」。それ以外は null(イベントの陣営とプレイヤー一覧の陣営の表記が同じとは限らないため。R-22 と同種)。統計カードには判定できなかった件数も出す。
- 記録外のキルは陣営が付かない(Cron がプレイヤー一覧を取っていないため)。これは画面の注記で説明する。記録外でも陣営を付けたい場合は第 3 段階(要確認 U-27)。

#### 17.10.5 試合との紐づけ・記録外

- 受信時に記録中の試合(第 1 段階で `feed_raw_events.recording_id` を決めているのと同じ判定)があればその id、無ければ 0(記録外)。イベント自体の時刻(`eventAt`)では割り当て直さない(届かない可能性が高く、時計のずれもあり得るため)。
- 試合の開始前・終了後の数秒のずれ(Cron は 1 分ごと、受信は約 2 秒ごと)で、境目のキルが記録外に入ることがある。許容する(画面の注記には出さない)。
- 記録外は、試合の選択に「記録外のキル」として常に出し、直近 `KILLFEED_UNRECORDED_MAX`(500)件を見せる(集計も 500 件で行う)。

#### 17.10.6 集計(ブラウザで行う)

**判断**: `GET /api/killfeed/kills` が試合のキルを全件(上限 3,000、通常 300 程度・100 KB 前後)返し、集計・絞り込み・検索・JSON 出力は**ブラウザで**行う。集計用(summary)・出力用(export)の API は作らない。根拠:

1. **リクエストが 1 本で済む**。SQL で集計すると「統計・時間帯・武器・距離・上位・最長」の 6 種類のクエリ(または 6 本の API)になり、絞り込みや棒の選択のたびに取り直しが要る。ブラウザなら手元の配列を数え直すだけ。
2. **D1 の読み取り行数はほぼ同じ**。SQL の集計でも試合のキルを全部走査するので、1 試合 300 行を読むのはどちらも同じ。差分の取得(30 秒ごと)は新しい行だけを読む。
3. 集計の定義(何をキルに数えるか、チームキルの判定)を 1 か所(`src/components/lib/killstats.ts`)に置け、JSON 出力と画面の数字が必ず一致する。単体テストもしやすい(純粋関数)。
4. 上限の 3,000 件でも 1 MB 程度で、集計は数 ms。それを超える試合は 3 時間・上限 3,000/日のため想定しない(超えたら `truncated` と表示)。

**定義**(`summarizeKills(kills, { origin, end })` → `KillfeedSummary`):

| 項目 | 定義 |
|---|---|
| キル | キラーがいて自殺でないイベント(チームキルを含む) |
| デス | 被害者がいるイベント(自殺・環境による死亡を含む) |
| 自殺 | `flags.suicide` |
| ヘッドショット率 | キルのうち `flags.headshot` の割合(キル 0 なら「−」)。分子の件数も出す |
| 最長キル | 距離が分かるキルの最大(同じなら先のもの)。距離が分かる件数も出す |
| 関わったプレイヤー | キラー・被害者のユニークな Steam ID の数(Steam ID が無い当事者は数えない) |
| チームキル | `teamkill === true` の件数。判定できなかった(null の)キルの件数も出す |
| 時間帯別 | 起点(試合の開始時刻。記録外は最初のキルの受信時刻)を分に切り捨て、`KILL_TIME_BUCKET_MINUTES` のうち棒が 36 本以下になる最小の幅で区切る。終点は試合の終了時刻(記録中は現在、記録外は最後のキル)。キルとヘッドショットの数。キルの無い棒も出す |
| 上位のプレイヤー | キラーの Steam ID(無ければ名前)ごとにキル、被害者ごとにデス。キル数の多い順、同数はデスの少ない順に 10 人。K/D = キル ÷ デス(デス 0 ならキル数) |
| 武器・原因 | 「乗り物 id(名前)+ 武器 id(名前)」ごとのキル数とヘッドショット数。多い順に 10 件 |
| 距離 | `<10` `10–25` `25–50` `50–100` `100–200` `200+`(m。下限を含む)。距離不明は除き、平均も出す |

**絞り込み**(`filterKills(kills, filter, query, bucket)`): `KILL_FILTERS` の 8 種(1 つ選択)× 検索語(NFKC・小文字にして、名前・Steam ID・武器と乗り物の id と名前の部分一致。64 文字まで)× 時間帯の棒(選んだときだけ)。集計(統計カード等)は**絞り込み前の全件**で計算する(参考パネルと同じ。絞り込みはキルログだけに効く)。

**JSON 出力**(`buildKillfeedExport(...)` → `KillfeedExport`): 試合の要約・サンプル(推移)・集計・全件のキル。`Blob`(`application/json`)を `a[download]` で保存する。ファイル名は `killfeed-s<サーバー id>-<試合 id または unrecorded>-<YYYYMMDD-HHmm>.json`(日時は `TIMEZONE`)。サーバー名はファイル名に入れない。ボタンの近くに「Steam ID とプレイヤー名が含まれます」と書く。

#### 17.10.7 画面(キルフィードタブ `/killfeed`)

`src/components/KillfeedPanel.tsx` に第 2 段階の節を足す(第 1 段階の推移のグラフ・生データの一覧はそのまま使う)。上から:

1. **試合の選択**(既存): 「現在の試合(記録中)」+ 直近 5 試合 + **「記録外のキル」**(トークン発行済みのとき)。
2. **現在のスコア**: 記録中の試合はサイドバーと共有の `/api/status`(`useSharedStatus`。30 秒ごと。**追加のリクエストは無い**)の `factionScores`。終了済みは `match.lastScores`(「試合終了時のスコア」)。記録外は出さない。参考パネルの約 15 秒ごとではなく 30 秒ごと(`POLL_MIN_INTERVAL_SEC`)。
3. **スコアの推移**(既存の `ScoreChart`)。
4. **統計カード 5 枚**: キル(デス・自殺)、ヘッドショット率(件数)、最長キル(距離が分かる件数)、関わったプレイヤー(Steam ID の数)、チームキル(判定できない件数)。幅 768px 以上は 5 列、未満は 2 列(5 枚目は全幅)。
5. **時間帯別のキル**(`KillTimelineChart.tsx`、SVG): キルの棒にヘッドショットを重ねた積み上げ(ヘッドショットは塗り + 斜線の模様で、色だけで区別させない)。棒は `<g role="button" tabindex="0" aria-pressed>`(Enter / Space で選択・解除)。選ぶとキルログを絞り込み、「{start}〜{end} のキルを表示しています」と解除ボタンを出す。横軸は時刻(`formatTime`、`TIMEZONE`)、目盛り 4〜6 本。下に表(折りたたみ)を置く。
6. **記録された最長キル**: 距離、キラー → 被害者(陣営の印付き)、武器・原因、時刻、印。
7. **上位のプレイヤー**(表: プレイヤー・K・D・K/D。見出しの略号には `abbr title` で「キル」等)と**武器・原因**(表: 武器・キル・HS)。768px 以上は横に 2 つ、未満は縦に並べる。
8. **距離**(`KillDistanceChart.tsx`、SVG の横棒 6 本 + 数値のラベル)と平均、「距離が分からないキルは含めていません」。
9. **キルログ**: フィルタのボタン 8 個(`aria-pressed`、横に折り返す)、検索欄(`type="search"`、200 ms で反映)、「JSON で書き出す」、件数(「{shown} / {total} 件」)。新しい順に 50 行ずつ(「さらに表示」)。
   - 1 行: 受信時刻(秒まで)とゲーム内時刻(`m:ss`。あれば)/ キラー(陣営の印 + 名前)/ 武器・原因(乗り物があれば「乗り物 · 武器」、名前が無ければ内部 ID)/ 印(ヘッドショット等。チームキルも印として出す)/ 被害者(陣営の印 + 名前)/ 距離(「距離不明」)/「詳細」。
   - 768px 以上は列を揃えた行(CSS grid)、未満はカード(1 行目: 時刻、2 行目: キラー → 被害者、3 行目: 武器・印・距離)。横スクロールを出さない。長い名前は折り返す(`overflow-wrap: anywhere`)。
   - 「詳細」は `<details>` でその場に開く: Steam ID(全桁。U-3)、陣営と出所(`killfeed.factionSource.*`)、武器・乗り物の内部 ID、イベントの時刻、番号。
   - キラーが null は「(環境・不明)」、名前が null は「(名前不明)」。
10. **今日の受信**: 保存したキル・キル以外・読み取れなかったキル・上限で捨てた件数(`today`)。読み取れなかったキルがあれば対応表の見直しを促す文(`killfeed.ingest.incompleteHelp`)。
11. **受信した生データ**(既存の `FeedRawList`): 各件に「正規化の結果」ボタンを足し、押すと `GET /api/feed/raw/:id/normalized` の結果(本文の形・件数・イベントごとの結果と読み取れた項目・使われなかった項目名)を表で見せる。
12. **この画面について**(注記): キルごとの得点は出していない、陣営の付け方と「?」、距離は分かるものだけ、項目名は未確認、時間帯は受信時刻。

**陣営の印**: `factions`(応答。試合の最後のサンプルの陣営の順)の添字で、推移のグラフと同じ配色(最大 3 + その他。`ops.css` のトークン)の小さな印に、陣営名の先頭 2 文字(`Array.from` で数える)を書く。`title` と読み上げ用の文字に陣営名の全体。不明は「?」(読み上げは「陣営不明」)。

**更新**: 記録中の試合・記録外を表示している間、`KILLFEED_POLL_SEC`(30 秒)ごとに `after=<cursor>` で差分を取り、配列の末尾に足して集計し直す(表示中のタブが隠れている間は止める。既存の `useAutoRefresh` に従う)。差分が `truncated` なら全件を取り直す。応答の `match.status` が `ended` になったら更新を止める。終了済みの試合は 1 回だけ取る。

**文言**: すべてカタログ(`killfeed.scope.*` `killfeed.score.*` `killfeed.stats.*` `killfeed.timeline.*` `killfeed.longest.*` `killfeed.top.*` `killfeed.weapons.*` `killfeed.distance.*` `killfeed.log.*` `killfeed.filter.*` `killfeed.flag.*` `killfeed.faction.*` `killfeed.factionSource.*` `killfeed.export.*` `killfeed.notes.*` `killfeed.ingest.*` `killfeed.normalize.*` `killfeed.normalizeResult.*` `killfeed.envelope.*` `killfeed.field.*`、設定タブの `feed.rawEnabled.*` `feed.kills.*`。architect が追加済み。型で全コード必須のものあり)。参考パネルの英語の見出し(`PLAYER KILLS` 等)はそのまま使わず日本語にする。数値・割合・時刻は `Intl`(13.4)。「スポンサー」等の表記・意匠は出さない。

**設定タブ**(`/servers` のキルフィードの節に追加): 「受信した生データも保存する」(`rawEnabled`。既定オン。説明 `feed.rawEnabled.help`)、今日保存したキルと上限(`feed.kills.todayValue`)、保持(`feed.kills.retention`)。

#### 17.10.8 無料枠の見積り(17.8 への追加)

**D1 の書き込み(10 万行/日)**

| 発生源 | 計算 | 1 日の最大 |
|---|---|---|
| キルの行 | 1 キル = 本体 1 + 索引 1。全体の上限 8,000 キル | 16,000 |
| キルの日次カウンタ | キルを含むバッチごとにサーバー・全体の 2 行(最悪 1 バッチ 1 キル) | 16,000 |
| その他の件数 | 1 台 1 分 1 回まで | 1 台 1,440 |
| サンプルの `roster_json` | 既存の行に列が増えるだけ(行数は増えない) | 0 |
| 試合の削除(トリガー) | 削除するキルの行 + 索引(1 試合 300 キルなら 600) | 数千 |

- キルの分の最悪は約 3.4 万行。17.8 の最悪(生データ約 2 万を含めて約 4.7 万)と合わせて**約 8.1 万行**で上限の内側。**形式を確かめたら生データの保存をオフ**(`rawEnabled = false`)にすると約 6.1 万行になる。設定タブと README で案内する。
- 通常(1 台、1 日 3 試合 × 300 キル): キル 1,800 + カウンタ最大 1,800 ≒ 3,600 行。

**D1 の読み取り(500 万行/日)**: 全件の取得は 1 試合 300〜3,001 行 + 数行。差分の取得は新しい行 + 数行(30 秒ごと、1 タブ 8 時間で約 960 回 × 10 行 ≒ 1 万行)。受信はサンプル 1 行(30 秒キャッシュ)。記録外の期限切れの削除は消す行数分だけ(17.10.9)。いずれも上限に遠い。

**Workers のリクエスト(10 万/日)**: キルフィードタブは推移 60 秒(1,440/日)+ キルの差分 30 秒(2,880/日)= **1 タブ開きっぱなしで約 4,300/日**(17.8 の 1,440 から増える)。スコアはサイドバーと共有なので増えない。受信 1 台常時(約 4.3 万)+ パネル(〜1.8 万)と合わせて約 6.5 万/日。

**ストレージ(500 MB)**: 1 キル約 300 バイト(索引込み)。全体の上限 8,000 キル/日 × 30 日 = 最大 24 万行 ≒ 72 MB(実際は「直近 5 試合 + 記録中」で切られるので大幅に少ない)。`roster_json` は 1 行 1.5 KB 程度 × 181 行 × 6 試合 × 20 台 ≒ 33 MB(最悪)。生データ(最大約 112 MiB)と合わせても 250 MB 未満。

**CPU(10 ms)**: 受信 1 件 = 長い整数の走査(64 KiB)+ `JSON.parse` + 100 件までの対応表の照合で 1〜2 ms の見込み(C-27 で実測)。一覧の API は最大 3,000 行の JSON 化(数 ms)。集計はブラウザ。

#### 17.10.9 保持と掃除(17.7 への追加)

| 対象 | いつ | 規則 |
|---|---|---|
| 試合に属するキル | 試合を削除したとき(17.7 の終了時・毎時の削除) | **トリガー** `trg_match_recordings_delete_kills`(0004)が同じ文の中で消す。Cron・API のクエリ数は増えない(17.3 の上限 50 に余裕が無いため) |
| 記録外のキル(サーバーの削除) | `DELETE /api/servers/:id` | トリガー `trg_servers_delete_unrecorded_kills` が消す(試合に属するキルは試合の保持に従う) |
| 記録外のキル(期限) | Cron の毎時 17 分 | `DELETE FROM feed_kills WHERE server_id IN (SELECT id FROM servers) AND recording_id = 0 AND received_at < ?(7 日前)` の 1 文(索引で消す行だけを読む)。17.3 の最悪 47 → 48 クエリ |
| `feed_daily` の 0004 の列 | 既存(8 日より前の行を削除) | 変えない |

トリガーが D1(`wrangler d1 migrations apply`)で作れない場合の代わり: 17.7 の削除の `db.batch` に `DELETE FROM feed_kills WHERE server_id = ? AND recording_id IN (…)` を足し、同時に記録できる台数(`MAX_ACTIVE_RECORDINGS`)を 7 に下げてクエリ数を収める(C-26)。

#### 17.10.10 モック(`scripts/mock-rcon.mjs`。実装は backend)

第 1 段階の送信モード(`MOCK_FEED_URL` / `MOCK_FEED_TOKEN`)に、環境変数 `MOCK_FEED_SHAPE` を足す。

| 値 | 本文 |
|---|---|
| `basic`(既定) | 第 1 段階のまま(`{ type: 'killed', killer, victim, weapon, distance, headshot, time }` の配列) |
| `mixed` | 下の変種を順番に混ぜる(正規化の対応表の確認用) |

`mixed` の変種(プレイヤーは既存の架空の `TestPlayerA` 等、Steam ID は既存の `fakeSteamId` のダミー。**実在の名前・ID は使わない**):

1. 入れ子: `{ type: 'killed', killer: { name, steamId, faction }, victim: { … }, weapon: { id: 'WEPN_031', name: 'Test Rifle' }, distanceM: 37.2, headshot: true, gameTime: 3151 }`
2. 平ら: `{ event: 'kill', killerName, killerSteamId, victimName, victimSteamId, weaponName: 'Test Pistol', distance: 12, isHeadshot: false, flags: ['PENETRATION'] }`(陣営なし → 記録中なら roster から付く)
3. 乗り物: `{ type: 'killed', attacker: { … }, victim: { … }, vehicle: { id: 'TNK_01', name: 'Test Tank' }, weapon: 'Anti Air', range: 180, tags: 'ROADKILL' }`
4. 自殺・距離不明: `{ type: 'killed', killer: <A>, victim: <A>, weapon: { id: 'GRENADE_TEST' } }`
5. チームキル: 同じ陣営の 2 人(`faction` 付き)
6. 数値の Steam ID: `killer.steamId` を**引用符無しの 17 桁の数値**で書いた本文(本文の文字列を手で組み立てる。`JSON.stringify` を使わない)
7. 環境による死亡: `{ type: 'killed', victim: { … }, cause: 'Test Fall' }`(キラーなし)
8. 種類違い: `{ type: 'test_unknown_event', foo: 1 }`(`other` に数えられ、キルログに出ないこと)
9. 読めないキル: `{ type: 'killed', a: 1 }`(`incomplete`)
10. `events` で包んだオブジェクト: `{ events: [変種 1, 変種 2] }`

送信の頻度・空のバッチの混ぜ方は第 1 段階と同じ。1 バッチ 1〜3 件。ログには変種の番号と応答の状態だけを出す(トークン・本文は出さない)。

#### 17.10.11 実装の分担(ファイル単位)

**architect(済み)**: 本節、8.14、14 章(K-9〜K-14、C-25〜C-27、U-25〜U-31)、`docs/API.md` 11 章、`src/types/api.ts`(第 2 段階の節。追加のみ)、`db/migrations/0004_killfeed.sql`、`db/schema.sql`、`src/i18n/ja.ts`(17.10.7 のキー。`killfeed.filter.*` `killfeed.flag.*` `killfeed.factionSource.*` `killfeed.normalizeResult.*` `killfeed.envelope.*` `killfeed.field.*` は型で全コード必須)。新しいエラーコードは無い(`src/lib/http.ts` の `DEV_MESSAGES` は変更なし)。

**backend**(第 1 段階の実装が終わってから)

| ファイル | 作業 |
|---|---|
| `src/lib/killfeed/fields.ts`(新規) | `KILL_FIELD_CANDIDATES`・`KILL_EVENT_TYPES`・印の語の表(17.10.2 の表。**対応表はこの 1 か所**) |
| `src/lib/killfeed/normalize.ts`(新規) | 長い整数を守る解析、`normalizeFeedBatch` / `normalizeFeedEvent`、診断(`matched` / `unmappedKeys`) |
| `src/lib/killfeed/store.ts`(新規) | 日次カウンタの UPSERT、陣営の付与(roster の取得と 30 秒キャッシュ)、`json_each` の INSERT、一覧と差分の読み取り(`KillEvent` への変換、`teamkill` の付与、`factions` の順)、その他の件数の間引き書き込み |
| `src/lib/feed.ts` / `src/pages/api/ingest/events.ts` | 17.10.3 の 11〜16。`raw_enabled` を読む |
| `src/lib/recordings.ts` / `src/lib/cron.ts` | サンプルに `roster_json`(`normalizeRecordingPlayers` の結果から)。毎時 17 分に記録外の期限切れの削除 1 文 |
| `src/lib/config.ts` | `probeD1` に 0004(`feed_kills`、`match_samples.roster_json`、`server_feeds.raw_enabled`、`feed_daily.kills`)を足す |
| `src/lib/testing/sqlite-d1.ts` | `MIGRATIONS` に `0004_killfeed.sql` |
| `src/pages/api/killfeed/kills.ts`(新規)、`src/pages/api/feed/raw/[id]/normalized.ts`(新規)、`src/pages/api/servers/[id]/feed.ts`(GET・PUT に `rawEnabled`・`killsToday`・`killLimits`) | API.md 11 章 |
| `scripts/mock-rcon.mjs` | `MOCK_FEED_SHAPE=mixed`(17.10.10) |
| テスト | 対応表の各候補・長い整数・外側の形 4 種・自殺・incomplete・1 バッチの上限、日次の上限(全部捨てる)、`raw_enabled = 0` でキルだけ保存、roster の鮮度(3 分)・出所が違うときの `teamkill = null`、差分の位置(同じ受信時刻の複数行)、トリガーで試合・サーバーの削除に合わせて消えること、記録外の期限切れ |

**frontend-pages**

| ファイル | 作業 |
|---|---|
| `src/components/lib/killstats.ts`(新規)+ `killstats.test.ts` | `summarizeKills`・`filterKills`・`buildKillfeedExport`・時間帯の幅の選び方・ファイル名(17.10.6) |
| `src/components/KillfeedPanel.tsx` | 17.10.7 の並び、記録外の選択、差分の取得、現在のスコア(`useSharedStatus`) |
| `src/components/KillStatsCards.tsx`・`KillTimelineChart.tsx`・`KillDistanceChart.tsx`・`KillLog.tsx`・`FactionBadge.tsx`(新規) | 17.10.7 の各節 |
| `src/components/FeedRawList.tsx` | 「正規化の結果」 |
| `src/components/ServerExtraSettings.tsx`(または `FeedStatusView.tsx`) | `rawEnabled` のスイッチ、今日のキルと上限 |
| `src/styles/ops.css` | 統計カード・キルログの grid とカード、陣営の印、ヘッドショットの模様 |

**qa-reviewer**: 名前・陣営名・武器名をテキストとして出していること(HTML として解釈しない)、Steam ID・名前がログ・エラー応答に出ないこと、375px で横スクロールが出ないこと(キルログ・表・SVG)、色だけで区別していないこと、集計の定義(17.10.6)と JSON 出力の一致。

#### 17.10.12 要確認

14 章の K-9〜K-14(本文の形)、C-25〜C-27(D1・CPU)、U-25〜U-31(判断)。

### 17.11 実装の分担(ファイル単位)

**architect(済み)**: `docs/ARCHITECTURE.md`(本章・5・8・9・11・14 章)、`docs/API.md`(4.1・8〜10 章、5 章のコード、7 章の追加)、`src/types/api.ts`、`src/types/env.ts`、`db/migrations/0003_recordings.sql`、`db/schema.sql`、`wrangler.jsonc`(`main`・`triggers`)、`src/worker.ts`(呼び出しの枠だけ)、`src/i18n/ja.ts`(`error.*` 5 つ、`audit.event.*` 6 つ、`action.*` / `confirm.*` / `action.help.*` の `record_start` / `record_stop`、`match.endReason.*`、`feed.reject.*`、`feed.drop.*`。いずれも型で全コード必須)、`src/lib/http.ts` の `DEV_MESSAGES`(5 つ)。

**backend**

| ファイル | 作業 |
|---|---|
| `src/worker.ts` | `scheduled` から `ctx.waitUntil(runCron(env, controller.scheduledTime))` を呼ぶ(1 行) |
| `src/lib/cron.ts`(新規) | 17.3 の手順と 17.7 の毎時の掃除。D1・fetch・時刻を引数で受けて単体テストできる形に |
| `src/lib/recordings.ts`(新規) | 記録の開始・停止・終了(共通の終了関数)・サンプルの組み立て(`status` と `players` からの陣営別の集計、cash の合計)・終了時の削除・一覧と推移の読み取り |
| `src/lib/feed.ts`(新規) | トークンの生成・ハッシュ・検証(定数時間、60 秒キャッシュ)、レート制限、空のバッチの判定、日次の上限、保存、受信の状況の間引き更新、生データの一覧 |
| `src/lib/actions.ts` / `src/lib/confirm.ts` / `src/lib/validate.ts` | `RecordingAction` の prepare / execute(17.2)。`isWriteAction` と並べて `isRecordingAction` / `isConfirmableAction`。`map` / `match_end` の成功時に `match_action` で終える |
| `src/lib/rcon/normalize.ts` | `StatusResponse.scoreCap` / `matchSeconds`。記録用に `players[].cash` と `faction` を読む関数(画面用の `PlayersResponse` には cash を出さない) |
| `src/lib/servers.ts` | `score_cap` の読み書き(`UpdateServerRequest.scoreCap`、`ServerSummary.scoreCap` / `feedConfigured`)、削除時に `server_feeds` も消す |
| `src/lib/config.ts` | `probeD1` に 0003 の表・列(`servers.score_cap`、`settings_audit_log.confirm_nonce`、`match_recordings`、`match_samples`、`server_feeds`、`feed_raw_events`、`feed_daily`)を足す |
| `src/lib/audit.ts` | 新しい `SETTINGS_EVENTS` の `status`(すべて succeeded)。`params` からトークンの値を出さない(入れていないことのテスト) |
| `src/middleware.ts` | `/api/ingest/events` の例外(5.5・5.8) |
| `src/pages/api/ingest/events.ts`、`src/pages/api/matches/index.ts`、`src/pages/api/matches/[id]/samples.ts`、`src/pages/api/feed/raw.ts`、`src/pages/api/servers/[id]/feed.ts`(GET・PUT)、`src/pages/api/servers/[id]/feed-token.ts`(POST・DELETE) | API.md 8〜10 章、7 章 |
| `scripts/mock-rcon.mjs` | `status` に `scoreCap`(任意)とスコアの増加、`players` に `cash`。`MOCK_FEED_URL` / `MOCK_FEED_TOKEN` を与えたら 2 秒ごとに `/api/ingest/events` へダミーの `killed` バッチ(と空のバッチ)を送るモード(形は資料からの推測と明記) |
| テスト | 二重実行(同じ分の 2 回の Cron)、各終了条件、上限の優先順位、トークンの不一致・形式不正・取り消し後、空のバッチで D1 に書かないこと、1 日の上限、nonce の 1 回限り |

**frontend-pages**: `src/pages/killfeed.astro`(アイランド化)、`src/components/KillfeedPanel.tsx`・`ScoreChart.tsx`・`FeedRawList.tsx`(新規)、`src/components/StatusPanel.tsx`(スコア記録の節)、`src/components/ServersPanel.tsx`(スコア記録・キルフィードの節)、`src/components/ConfirmDialog.tsx`(`RecordingAction` の確認。`AnyPrepareResponse` / `AnyExecuteResponse`)、`src/layouts/nav.ts`、`src/styles/ops.css`(グラフの配色・線種のトークン)、`src/i18n/ja.ts`(17.9 のカタログ)、README の手順(architect と相談。17.6 の ini の案内と 17.8 の注意)。

**qa-reviewer**: 受信エンドポイントが middleware の例外の範囲を超えないこと(パスの完全一致)、トークン・本文がログ・応答に出ないこと、生データをテキストとして表示していること、375px のグラフ、Cron の二重実行。
