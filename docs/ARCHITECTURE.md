# wardogs-ops 構成(正本)

作成日: 2026-10-15(JST)/ 担当: architect
上位の正本: `docs/PLAN.md`(2026-10-15 改訂版)。契約: `docs/API.md`、`src/types/api.ts`、`src/types/env.ts`、`db/schema.sql`、`wrangler.jsonc`。
RCON の仕様は非公式資料ベース(`docs/research/wardogs-rcon.md`)。本書の「未検証」「要確認」は末尾第 14 章の番号(R-n / C-n)で参照する。

## 1. 目的と設計目標

- 任意の WARDOGS コミュニティサーバー運営者が、**フォーク(またはボタンで複製)→ Deploy to Cloudflare → Secrets を 3 個入力 → サーバー側で RCON を有効化** だけで使える運営パネル。
- 運営者 1〜数人が 1 つのパスワードを共有して使う規模を想定する。アカウント管理・権限分離はしない。
- Cloudflare 無料プラン(Workers / D1)の範囲で動かす。KV・R2・Cron・Access・Tunnel は使わない(第 2 段階の選択肢は 12 章)。
- 公開リポジトリのテンプレートなので、リポジトリには接続先・パスワード等を一切含めない。利用者固有の値はすべて Secrets。

## 2. 構成図

```
運営者のブラウザ
  │  HTTPS(https://wardogs-ops.<アカウント>.workers.dev。カスタムドメインは任意)
  ▼
Cloudflare Worker「wardogs-ops」(Astro SSR + React アイランド)
  ├─ middleware: 設定チェック → セキュリティヘッダ → ログイン Cookie 検証 → CSRF(Origin)検査
  ├─ /login, /logout(フォーム POST。JS 無しで動く)
  ├─ ページ: / 状態, /players, /bans, /audit, /setup
  ├─ /api/*: 読み取り(status / players / bans / maps / capabilities / audit / session)
  │          書き込み(actions/prepare → actions/execute の二段階)
  ├─ D1「DB」(任意・推奨): audit_log / status_snapshots / login_throttle
  └─ fetch(Authorization: Bearer <RCON_PASSWORD>、タイムアウト付き、リダイレクト非追従)
        │  平文 HTTP(C-1 要確認)。送信元 IP は固定されない(C-3)
        ▼
     RCON HTTP API(Secret RCON_URL = http://<ホスト名>:<ポート>。IP アドレス直指定は不可)
     ゲームサーバー側: ServerSettings.ini の [/Script/WDRCON.WDRCONSettings](R-3, R-4 要確認)
```

ブラウザが RCON を直接叩くことはない。RCON_URL・RCON_PASSWORD はブラウザに一切渡らない(クライアントバンドル・HTML・API 応答のいずれにも含めない)。

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
├─ .dev.vars.example          # Secrets の宣言(Deploy ボタンの入力欄になる)。値は書かない
├─ db/
│  ├─ schema.sql              # 現行スキーマのまとめ(参照用)
│  └─ migrations/0001_init.sql
├─ docs/                      # PLAN / ARCHITECTURE / API / research
└─ src/
   ├─ env.d.ts                # Cloudflare.Env と App.Locals の型付け
   ├─ middleware.ts           # 設定チェック、ヘッダ、認証、CSRF(backend)
   ├─ i18n/                   # 多言語化(第 13 章。architect が雛形、文言の追加は各担当)
   │  ├─ ja.ts                # 日本語カタログ(キーの正本。型で全キーを強制)。言語を足すときは en.ts 等
   │  └─ index.ts             # t(key, params?)、getTranslator、resolveLanguage、toLocale、formatDateTime 等
   ├─ types/
   │  ├─ api.ts               # API 契約(architect)
   │  └─ env.ts               # バインディング・Secrets の型(architect)
   ├─ lib/                    # backend
   │  ├─ config.ts            # Secrets の検証、SetupWarning、Features の判定
   │  ├─ keys.ts              # HKDF による鍵の派生
   │  ├─ session.ts           # Cookie の発行・検証
   │  ├─ password.ts          # 定数時間比較
   │  ├─ throttle.ts          # ログイン失敗のレート制限(D1 / メモリ)
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
   │  └─ rcon/
   │     ├─ client.ts         # fetch、タイムアウト、エラー分類
   │     ├─ routes.ts         # 本パネルが使う RCON ルートの一覧(API.md 6 章)
   │     ├─ capabilities.ts   # /v1/capabilities の取得・解釈・キャッシュ
   │     └─ normalize.ts      # RCON 応答の正規化
   ├─ pages/                  # frontend-pages(API は backend)
   │  ├─ index.astro          # 状態
   │  ├─ players.astro / bans.astro / audit.astro
   │  ├─ login.astro          # GET 表示 / POST 認証
   │  ├─ logout.ts            # POST のみ
   │  ├─ setup.astro          # 設定不足の案内
   │  └─ api/
   │     ├─ session.ts / status.ts / players.ts / bans.ts / maps.ts / capabilities.ts / audit.ts
   │     └─ actions/prepare.ts / actions/execute.ts
   ├─ components/             # React アイランド(frontend-pages)
   └─ layouts/
```

### 3.1 担当の分担

- backend: `src/lib/*`、`src/middleware.ts`、`src/pages/api/*`、`src/pages/login.astro` の POST 処理、`src/pages/logout.ts`。契約は `docs/API.md` と `src/types/*`。
- frontend-pages: 画面(9 章)、確認ダイアログ(4.3 / 7.3)、自動更新(9 章)、カタログへの文言の追加(13 章)。エラー表示は `code` でカタログを引き、`rconMessage` は補足としてそのまま出す。
- 契約(`src/types/*`、`src/i18n/index.ts` の関数の形、`db/*`、`wrangler.jsonc`、`docs/API.md`)の変更は architect 経由。

Worker 内のランタイム値は `import { env } from 'cloudflare:workers'`(参考実装と同じ)で取る。`src/env.d.ts` で `Cloudflare.Env` に `OpsEnv` を結び付けてあり、`env.ADMIN_PASSWORD` 等は型付きで参照できる(`tsc` で確認済み)。

## 4. データフロー

### 4.1 ログイン

```
GET /login ── フォーム(パスワード、操作者名[任意])
POST /login(application/x-www-form-urlencoded)
  1. 必須 Secrets・強度を確認。不足なら /setup へ 303
  2. Origin 検査(5.5)。不一致は 403
  3. 接続元キー = HMAC(ip-hash 鍵, CF-Connecting-IP)の先頭 16 桁(IPv6 は /64 に丸めてから)
  4. login_throttle を参照。ロック中ならパスワードを評価せずにエラー表示(残り分数)
  5. 定数時間比較(5.2)。失敗 → 失敗回数 +1(D1)、約 300 ms 待ってからエラー表示
  6. 成功 → 接続元キーの失敗回数を消去、Cookie 発行、audit_log に login を記録、古い行の掃除(8.4)
  7. 303 で / へ
```

### 4.2 読み取り(ポーリング)

```
React アイランド ──(30 秒ごと。タブが非表示の間は止める)── GET /api/status など
Worker: Cookie 検証 → RCON GET /v1/status(タイムアウト 5 秒)→ 正規化 → JSON
        └ /api/status のときだけ、成功したら status_snapshots に INSERT OR IGNORE(waitUntil で応答後に実行)
```

- 1 画面が叩く API は原則 1 本(状態画面は `/api/status`、プレイヤー画面は `/api/players`)。1 リクエスト = RCON 1 回 + D1 0〜1 回で、サブリクエスト 50・同時接続 6 の上限に十分収まる。
- capabilities は画面表示時に `/api/capabilities` を 1 回取る(Worker 側で 10 分キャッシュ)。
- 応答は `Cache-Control: no-store`。Worker 側で RCON の結果はキャッシュしない(複数タブの同時更新でも RCON 側の上限 600/分〔R-13〕に遠い)。

### 4.3 書き込み(二段階)

```
1. 画面で操作を選ぶ(例: プレイヤー行の kick)
2. POST /api/actions/prepare { action, params }
   Worker: 入力検証 → capability 確認 → 対象の名前解決(RCON GET /v1/players、unban は監査ログ)
           → 正規化済み params・対象名・確認トークン(署名付き、120 秒、1 回限り)を返す(文言は返さない)
3. 画面: Worker が返した正規化済み params と対象名を、カタログの `confirm.<action>` で確認ダイアログの文にして表示。destructive なら強調し、ban / match_end は
   表示中の対象名(または「試合終了」)を再入力させる等の追加確認を frontend-pages が設計する
4. POST /api/actions/execute { action, params, confirmToken }
   Worker: トークン検証(署名・期限・セッション一致・action と params のハッシュ一致)
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

**決定: 読み取り時の間引き(Cron は使わない)**。`/api/status` が RCON から状態を取れたとき、`bucket = floor(unix秒 / 300)` を主キーに `INSERT OR IGNORE` する。5 分に最大 1 行、誰かがパネルを開いている間だけ記録される。

根拠: (1) Cron を Astro の Worker に同居させるにはカスタムエントリが必要で、`@astrojs/cloudflare@14` の公式ガイドに記載が無い(`./handler` の export は存在するが組み合わせは未検証、C-10)。(2) Cron はアカウントあたり 5 個までで、テンプレート利用者の既存 Worker と枠を取り合う。(3) 人数履歴グラフは PLAN で後回し。常時記録が必要になったら第 2 段階で Cron 化する(12 章)。

## 5. 認証の詳細

### 5.1 Secrets と鍵の派生

| 用途 | 鍵 |
|---|---|
| Cookie 署名 | `HKDF-SHA256(ikm, salt="wardogs-ops/v1", info="session")` |
| 確認トークン署名 | 同 `info="confirm"` |
| 接続元 IP のハッシュ | 同 `info="ip-hash"` |
| パスワード比較用 | 同 `info="password-compare"` |

`ikm = UTF-8(SESSION_SECRET ?? "") || 0x00 || UTF-8(ADMIN_PASSWORD)`。

**決定: SESSION_SECRET は任意**(既定は ADMIN_PASSWORD からの HKDF 派生)。

- 利点: 利用者が入力する Secrets が 3 個で済む。ADMIN_PASSWORD を変えると全セッションが自動で無効になる(ローテーションが 1 操作)。
- 欠点: SESSION_SECRET 未設定のとき、Cookie を盗まれると ADMIN_PASSWORD をオフラインで総当たりされ得る(HKDF は低速化しない)。Cookie は `HttpOnly; Secure` で盗まれにくく、ADMIN_PASSWORD は 16 文字以上を必須にして実用上の総当たりを防ぐ。PBKDF2 等の低速化は無料プランの CPU 10 ms/リクエストを圧迫するため採らない。
- SESSION_SECRET を設定すると ikm に加わり、Cookie からのオフライン総当たりが不可能になる。長さ 32 未満は設定エラー(`SESSION_SECRET_TOO_SHORT`、ログイン不可)。ボタンのフォームには出さず(.dev.vars.example ではコメント扱い)、README で「より安全にしたい人向け」として案内する。

### 5.2 パスワード検証とパスワード強度

- 入力は 256 文字で打ち切る。`HMAC(password-compare 鍵, 入力)` と `HMAC(同, ADMIN_PASSWORD)` を `crypto.subtle.timingSafeEqual` で比較する(長さの差も隠れる)。
- 強度要件(Worker で強制): ADMIN_PASSWORD は **16 文字以上**、かつ RCON_PASSWORD と同一でないこと。満たさなければログインを受け付けず /setup で警告(`ADMIN_PASSWORD_TOO_SHORT` / `ADMIN_PASSWORD_EQUALS_RCON_PASSWORD`)。README ではパスワード生成の手順(ランダム 24 文字以上)を案内する。
- RCON_PASSWORD は Worker から強制できないため、24 文字未満なら警告のみ(`RCON_PASSWORD_SHORT`)。README の推奨はランダム 32 文字以上。

### 5.3 Cookie の形式と有効期限

- 名前: `__Host-wo_session`(`Secure; HttpOnly; SameSite=Strict; Path=/`、Domain 属性なし)。開発時(`import.meta.env.DEV`)は `wo_session`、`Secure` なし(http://127.0.0.1 で `__Host-` が使えない場合に備える。C-14)。
- 値: `v1.<sid>.<iat>.<exp>.<op>.<sig>`
  - `sid`: 16 バイト乱数の base64url(セッション ID。監査ログには先頭 8 文字の `sessionTag` だけ残す)
  - `iat` / `exp`: UTC epoch ミリ秒(10 進)。`exp = iat + 12 時間`
  - `op`: 操作者名(任意、最大 32 文字)の UTF-8 を base64url。空可
  - `sig`: `HMAC-SHA256(session 鍵, "v1.<sid>.<iat>.<exp>.<op>")` の base64url。比較は定数時間
- 有効期限: **絶対 12 時間、延長しない**(Cookie の再発行 = 書き込みが毎リクエスト発生しない)。`Max-Age` も同じ値にする。
- 操作者名は自己申告で、なりすましは防げない(パスワード共有型の限界)。監査ログには sessionTag と ip_hash も併記して追跡の手掛かりにする。

### 5.4 ローテーションとログアウト

- ログアウト: `POST /logout`(Origin 検査あり)で Cookie を消し、audit_log に logout を記録する。署名 Cookie は状態を持たないため、ログアウト前に Cookie を盗まれた場合は期限まで有効(12 時間)。
- 全セッションの強制失効: ADMIN_PASSWORD または SESSION_SECRET を変更する(鍵が変わり、既存 Cookie の署名が通らなくなる)。手順は 10.3。

### 5.5 CSRF 対策

- Cookie は `SameSite=Strict`(他サイトからのリクエストに付かない)。
- GET / HEAD 以外のすべて(`/login`、`/logout`、`/api/*`)で検査する:
  1. `Origin` があれば `new URL(request.url).origin` と完全一致を要求
  2. `Origin` が無い、または `null` なら `Sec-Fetch-Site: same-origin` を要求(Chrome は `Referrer-Policy: no-referrer` や sandbox 下のフォーム送信で `Origin: null` を送る。`Sec-Fetch-Site` は forbidden header でスクリプトから偽装できない。2026-10-15 のブラウザ確認で発見し修正)
  3. どちらも無ければ拒否(403 `FORBIDDEN_ORIGIN`。ページは 403 の簡易 HTML)
- `/api/*` の POST は `Content-Type: application/json` を必須(他サイトの単純フォームからは送れない)。
- Astro 標準の origin 検査(`security.checkOrigin`)は**無効化**し、上記の middleware の検査に一本化する。標準検査はフォーム形式の POST だけが対象で JSON 等は見ず、middleware より先に本文を読まずに 403(セキュリティヘッダ無し)を返し、開発サーバーでは直後の同一接続のリクエストが 500 になるため(`docs/API_TEST.md` 4 章。本番は C-19)。middleware の検査は GET / HEAD 以外の全リクエストが対象で、拒否前に本文を読み捨てる。
- 許可オリジンを設定値で持たない(workers.dev でもカスタムドメインでも、リクエスト自身のオリジンと比較する)。

### 5.6 ログイン失敗のレート制限

**決定: D1 の `login_throttle` テーブル(固定窓)**。KV は書き込み 1,000/日で、総当たりを受けると枠を使い切って制限自体が働かなくなる。D1 は書き込み 10 万行/日で余裕があり、監査ログと同じデータベースなので自動プロビジョニングの対象も増えない。Rate Limiting バインディングは無料プランでの可否が未確認(`cloudflare-free-tier.md` 要確認 2)で、精度も「eventually consistent」のため採らない。

| 規則 | 値 |
|---|---|
| 接続元ごと(`ip:<HMAC 先頭 16 桁>`。IPv6 は /64) | 15 分の窓で失敗 5 回 → その窓の終わりまでロック |
| ロック中 | パスワードを評価しない。失敗回数も増やさない(書き込みを増やさない) |
| 全体(`global`) | 失敗回数を数えるだけ。1 時間に 50 回を超えたら画面上部に警告(`SetupWarning` の `LOGIN_FAILURES_HIGH`、`/api/session` の `warnings`)。**全体ロックはしない**(第三者が運営者を締め出せてしまうため。総当たりへの備えは 16 文字以上のパスワードで行う) |
| 判定の順序 | 評価の前に試行回数を UPSERT で加算(`RETURNING`)し、上限超なら拒否、成功時に行を削除する(並行リクエストで回避されないよう原子的に。2026-10-15 QA M-3) |
| 失敗時の待ち | 約 300 ms(応答を遅らせる。Workers の CPU 時間には数えられない) |
| D1 が無い場合 | isolate 内のメモリで同じ規則を近似(isolate ごとに独立し、再起動で消える。弱いことを /setup で表示) |

### 5.7 その他のヘッダ・保護

- 全応答: `X-Frame-Options: DENY`、`Content-Security-Policy` に少なくとも `frame-ancestors 'none'; base-uri 'none'; form-action 'self'`、`Referrer-Policy: same-origin`(`no-referrer` だと同一オリジンのフォーム送信で `Origin: null` になり CSRF 検査に落ちる)、`X-Content-Type-Options: nosniff`、`X-Robots-Tag: noindex, nofollow`。HTML と API は `Cache-Control: no-store`。`script-src` を絞るかは Astro のアイランド用インラインスクリプトとの両立を確認してから決める(C-15)。
- 未ログインのページ要求は `/login` へ 303、API は 401 `UNAUTHENTICATED`。
- 必須 Secrets が不足・不正(`*_MISSING`、`*_TOO_SHORT`、`RCON_URL_INVALID`、`RCON_URL_IS_IP_ADDRESS`、`ADMIN_PASSWORD_EQUALS_RCON_PASSWORD`)なら `/setup` 以外は `/setup` へ 303、API は 503 `NOT_CONFIGURED`。
- `/setup` は未ログインでも見られるが、**設定が揃っているときは「設定済み」以外を出さない**。不足時は不足している Secret の名前と警告種別だけを出す(値・長さ・接続先は出さない)。警告の文言は `SetupWarning` のコードからカタログ(`setup.warning.<コード>`)で引く。
- ログ(`console.*`、Workers Logs)に出してよいのは、ルート名・HTTP ステータス・所要時間・エラーコードのみ。パスワード、Cookie、RCON_URL、`Authorization`、生の IP、プレイヤーのメッセージ本文は出さない。

## 6. RCON 呼び出し

### 6.1 接続先の検証(RCON_URL)

- `new URL()` で解釈できること。`protocol` は `http:` または `https:`(https は R-3 / R-5 次第。現状の非公式資料では平文 HTTP のみ)。
- ユーザー名・パスワードを含まないこと(`RCON_URL_HAS_CREDENTIALS`)。
- ホスト名が IPv4 / IPv6 リテラルでないこと(`RCON_URL_IS_IP_ADDRESS`)。Workers の fetch は IP アドレス直指定ができない(Cloudflare 公式 known-issues)。README に回避手順(自前ドメインの A レコード〔DNS only〕等)を書く。
- パスの末尾の `/` を除き、その後ろに `/v1/...` を付ける(パス接頭辞は許す。将来 TLS 終端プロキシの下に置く場合のため)。
- 検証に失敗しても値そのものは画面・ログに出さない。

### 6.2 fetch の方針

| 項目 | 値 |
|---|---|
| ヘッダ | `Authorization: Bearer <RCON_PASSWORD>`、`Accept: application/json`、本文がある場合は `Content-Type: application/json` |
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
| 401 / 403 | `RCON_AUTH_FAILED` | RCON_PASSWORD 不一致、または AllowedHosts で拒否(区別できるかは R-15) |
| 404 | `RCON_ROUTE_NOT_FOUND` | このビルドにルートが無い。capabilities のキャッシュを破棄する |
| 429 | `RCON_RATE_LIMITED`(`Retry-After` を秒で `retryAfterSec` に) | RCON 側の上限 |
| 400 / 409 / 422 等その他 4xx | `RCON_REJECTED`(本文の `error`/`message` 文字列を 200 文字に切り詰め、制御文字を除いて `rconMessage` に) | 例: 対象がオフライン |
| 5xx | `RCON_ERROR` | サーバー内部エラー |
| JSON として解釈できない 2xx(読み取り) | `RCON_BAD_RESPONSE` | 形式が想定外 |
| 2xx(書き込み。本文が JSON でなくても・空でも) | 成功 | 書き込みの成否は HTTP ステータスで判断し、本文は解釈しない(実行済みの kick 等を失敗と記録しないため)。監査ログには `rcon_status` を残す |

エラー本文の形式は未検証(R-14)。書き込みの 2xx の本文形式も未検証のため、成功判定に本文を使わない(R-18)。`rconMessage` は JSON の文字列フィールドからだけ取り、HTML 等はそのまま返さない。

### 6.4 capabilities によるルート判定

- `GET /v1/capabilities` を Worker の isolate 内で 10 分キャッシュ(`RCON_ROUTE_NOT_FOUND` を受けたら即破棄)。KV / D1 には保存しない。
- `routes[]` の要素形式は未検証(R-1)。文字列(`"POST /v1/broadcast"` 等)と `{ method, path }` 形式の両方を受け付け、`"METHOD /path"` に正規化する。パスのパラメータ部(`{steamId}`、`:steamId` 等)は名前を無視して照合する。
- 判定(`CapabilityState`):
  - `available`: 該当ルートがある
  - `missing`: capabilities は解釈できたがルートが無い → **画面のボタンを無効化**し、prepare も `CAPABILITY_MISSING` で拒否
  - `unknown`: capabilities 自体が取れない(404・形式不明)→ ボタンは有効のまま「未確認」と表示し、実行時のエラーで判断
- 2026-09-14 のビルドで書き込み系ルートが廃止され設定ドキュメント経由に移ったとの記載がある(R-2)。該当する場合、kick 等は `missing` になり操作できない。設定経由の代替(`PUT /v1/config`)は第 2 段階。

### 6.5 Steam ID の扱い

- 形式: SteamID64(10 進 17 桁、`STEAM_ID_PATTERN`)を前提に検証する。RCON がこの形式かは未検証(R-9)。合わない ID の行は表示だけして操作ボタンを無効にする(定数 1 か所の変更で直せるようにしてある)。
- 画面: ログイン済みの運営者には全桁を表示する(BAN 解除・外部照会に必要)。ログイン前の画面・/setup・エラー応答には出さない。
- 保存: audit_log の `target_steam_id` と操作時点の名前 `target_name` を残す(BAN 一覧で名前を補完するため)。保持期間 365 日(8.4)。status_snapshots には人数とマップだけでプレイヤー情報は入れない。
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

### 7.4 段階的有効化(D1 が無くても動く)

| 段階 | 条件 | 動作 |
|---|---|---|
| 0. 未設定 | 必須 Secrets の不足・不正 | `/setup` のみ表示。ログイン不可 |
| 1. 読み取り専用 | Secrets は揃っているが D1 が無い(`env.DB` 未定義)またはテーブルが無い | ログイン、状態・プレイヤー・BAN 一覧は使える。**書き込み操作は無効**(`WRITES_DISABLED`)。操作ログ画面は「無効」表示。ログイン失敗の制限はメモリ近似 |
| 1'. ログ無しで書き込み | 段階 1 かつ vars `AUDIT_REQUIRED="false"` | 書き込みを許可。記録は Workers Logs に「操作種別・結果コード・sessionTag」だけ出す(対象の Steam ID・本文は出さない)。確認トークンの 1 回限りは isolate 内メモリで近似。画面上部に常時警告 |
| 2. 通常 | D1 が使え、マイグレーション適用済み | 全機能 |

- D1 の可否は「`env.DB` があり、`SELECT 1 FROM audit_log LIMIT 1` が成功する」で判定し、isolate 内で 5 分キャッシュする。失敗したら段階 1 として扱い、`D1_MISSING` / `D1_NOT_MIGRATED` を警告に出す。
- 既定を「D1 が無ければ書き込み不可」にした理由: PLAN と共通ルールの「書き込みは監査ログを必ず通す」を既定で守るため。ログ無しでの書き込みは利用者が明示的に選ぶ(ユーザー確認事項)。

## 8. D1 スキーマ

正本は `db/migrations/0001_init.sql`(`db/schema.sql` は参照用のまとめ)。時刻はすべて UTC epoch ミリ秒。

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

インデックス: `created_at`、`(target_steam_id, created_at)`。

### 8.2 status_snapshots

`bucket`(PK、`floor(unix秒/300)`)、`taken_at`、`players_current`、`players_max`、`map`。`INSERT OR IGNORE` で 5 分に 1 行。

### 8.3 login_throttle

`key`(PK、`ip:<hash>` または `global`)、`window_start`、`failures`。窓が過ぎた行は次の書き込み時に上書き(UPSERT)。

### 8.4 保持と掃除

ログイン成功時に次を実行する(Cron を使わないため):

- audit_log: 365 日より古い行を削除
- status_snapshots: 90 日より古い行を削除
- login_throttle: `window_start` が 1 日より古い行を削除

いずれも定数としてコードに持つ(vars にはしない。利用者の設定項目を増やさない)。

## 9. 画面一覧

| パス | 内容 | アイランド | 自動更新 |
|---|---|---|---|
| `/login` | パスワード、操作者名(任意)。ロック中は残り時間 | なし(フォーム POST) | − |
| `/` 状態 | サーバー名、マップ、人数(現在/最大)、陣営スコア、ローテーション位置。broadcast、マップ変更、試合終了 | あり | 30 秒 |
| `/players` | 接続中一覧(名前、陣営、K/D、ping、Steam ID)。行ごとに kick / message / ban | あり | 30 秒 |
| `/bans` | BAN 一覧(Steam ID、日時、理由、実行者、監査ログからの名前)。解除 | あり | 手動更新 |
| `/audit` | 操作ログ(日時〔vars `TIMEZONE` で表示。既定は日本時間〕、操作者、操作、対象、内容、結果)。50 件ずつ | あり | 手動更新 |
| `/setup` | 不足している Secrets、警告、README への案内 | なし | − |

共通: 画面上部に `warnings`(`/api/session`)と段階(7.4)を表示する。capabilities が `missing` のボタンは無効化し理由を示す、`unknown` は「未確認」表示。モバイル幅で操作できること。自動更新は `document.visibilityState === 'hidden'` の間止め、`POLL_MIN_INTERVAL_SEC`(30 秒)より短くしない。

## 10. Secrets / vars

### 10.1 一覧

| 名前 | 種別 | 必須 | 内容 |
|---|---|---|---|
| `ADMIN_PASSWORD` | Secret | 必須 | ログインパスワード。16 文字以上 |
| `RCON_URL` | Secret | 必須 | `http://<ホスト名>:<ポート>`。接続先は非公開情報なので vars にしない |
| `RCON_PASSWORD` | Secret | 必須 | RCON の Bearer トークン(読み書き全権) |
| `SESSION_SECRET` | Secret | 任意 | 32 文字以上。鍵の派生に加える(5.1) |
| `AUDIT_REQUIRED` | vars(`wrangler.jsonc`) | 任意 | 既定 `"true"`。`"false"` で D1 無しでも書き込み可(7.4) |
| `LANGUAGE` | vars(`wrangler.jsonc`) | 任意 | 表示言語の言語コード。既定 `"ja"`。`"auto"` で Accept-Language から選ぶ(13.2) |
| `TIMEZONE` | vars(`wrangler.jsonc`) | 任意 | 既定 `"Asia/Tokyo"`(IANA 名。13.4) |
| `DB` | D1 バインディング | 推奨 | 自動プロビジョニング(`wardogs-ops-db`) |

`secrets.required`(wrangler 設定)は**使わない**。未設定だと `wrangler deploy` が失敗する仕様で、ボタンのフォームとの順序が未確認(C-6)なため、初回デプロイが失敗する危険を避ける。不足は実行時に `/setup` で案内する。

### 10.2 注入方法

| 方法 | 使う場面 |
|---|---|
| Deploy to Cloudflare ボタンのフォーム | 初回。`.dev.vars.example` に書いた `ADMIN_PASSWORD` `RCON_URL` `RCON_PASSWORD` が入力欄になり、`package.json` の `cloudflare.bindings.<名前>.description` が説明文になる |
| ダッシュボード: Workers & Pages > wardogs-ops > Settings > Variables and Secrets > Add(種類 Secret) | 後からの変更・追加(SESSION_SECRET など)。Settings > Build のビルド変数は実行時に見えないので使わない |
| `wrangler secret put <名前>` | コマンドを使える人向け |
| `.dev.vars`(`.dev.vars.example` をコピー) | ローカル開発のみ。`.gitignore` 済み |

### 10.3 ローテーション手順

- ADMIN_PASSWORD: ダッシュボードで値を更新 → 保存(新しいバージョンが反映)→ 全セッションが失効するので再ログイン。
- SESSION_SECRET: 同上(全セッション失効)。
- RCON_PASSWORD: (1) ゲームサーバーの `ServerSettings.ini` の Password / PasswordHash を変更しサーバーを再起動 (2) 直後にダッシュボードで RCON_PASSWORD を更新。(1)〜(2) の間は `RCON_AUTH_FAILED` になる。漏洩が疑われるときは最優先で行う(RCON パスワードは読み書き全権)。
- RCON_URL: 接続先の変更時に更新。DNS の A レコードを変えるだけで済む構成(README 4.3)なら更新不要。

## 11. 無料枠の見積り

前提: Workers 10 万リクエスト/日、サブリクエスト 50/リクエスト、同時接続 6、D1 書き込み 10 万行/日・読み取り 500 万行/日(UTC 0 時リセット)。静的アセット(`/_astro/*`)はリクエスト数に数えない。

### 11.1 Worker リクエスト

自動更新は 30 秒間隔・非表示タブは停止。1 タブを開きっぱなしにすると `86400 / 30 = 2,880` リクエスト/日。

| 想定 | 計算 | リクエスト/日 |
|---|---|---|
| 通常(運営者 2 人 × 1 タブ × 8 時間) | 2 × 960 + ページ遷移・操作 約 200 | 約 2,100 |
| 多め(3 人 × 2 タブ × 12 時間) | 6 × 1,440 + 約 500 | 約 9,100 |
| 上限の目安 | 100,000 / 2,880 | タブ 34 本を 24 時間開き続けて到達 |

ログイン画面への総当たりはリクエスト数を消費する(5.6 のロックは CPU と D1 を守るが、リクエスト数そのものは減らせない)。無料枠を使い切ると当日 UTC 0 時(JST 9 時)まで Worker が止まる。対策が必要になったら WAF のレート制限ルール(Free は 1 ルール)を README の「困ったとき」で案内する。

### 11.2 サブリクエスト(1 リクエストあたり)

| API | RCON | D1 | 計 |
|---|---|---|---|
| `/api/status` | 1(+ capabilities 取得時 1) | 0〜1(スナップショット)+ D1 判定 0〜1 | 最大 4 |
| `/api/actions/prepare` | 1〜2(players、maps) | 0〜1(unban の名前) | 最大 3 |
| `/api/actions/execute` | 1 | 2(INSERT + UPDATE) | 3 |
| `POST /login` 成功 | 0 | 約 6(throttle 読み・消去、audit、掃除 3) | 約 6 |

いずれも 50 / 同時 6 に収まる。

### 11.3 D1

| 対象 | 計算 | 書き込み行/日 |
|---|---|---|
| status_snapshots | 5 分に 1 行 × 24 時間 = 288 行(インデックス更新を含めても 2 倍以内と見込む。C-17) | 最大 約 600 |
| audit_log | 1 操作 = INSERT + UPDATE + インデックス 2 本 ≒ 6 行相当 × 100 操作 | 約 600 |
| login_throttle | 失敗 1 回 = 2 行(ip + global)。ロック中は書かないので 1 接続元あたり 15 分に最大 5 回 | 攻撃 100 接続元が 24 時間続けても 100 × 96 × 5 × 2 = 96,000 → 上限に近い |
| 合計(通常) | | 約 1,500(上限の 1.5%) |

login_throttle の最悪値が上限に近いため、**global の失敗が 1 時間に 1,000 回を超えたら以後その時間は throttle を書かない**(ロック判定はメモリ近似に切り替える)実装とする。読み取りは監査ログ 50 件 × 閲覧回数程度で 500 万行/日に遠い。ストレージは 1 年で数十 MB 以内(5 GB に遠い)。

## 12. 撤回した旧方針とトレードオフ

2026-10-15 午前の方針(Cloudflare Access のメール認証 + Worker での JWT 検証、Cloudflare Tunnel、自宅 PC / VPS の中継プロキシに RCON パスワードを置き許可ルートを列挙)は、非エンジニアには設定が重すぎるため撤回した。現方針で受け入れるリスク:

| 項目 | 旧方針 | 現方針(受け入れるリスク) | 緩和策 |
|---|---|---|---|
| RCON パスワードの置き場所 | 中継プロキシの機械のみ | **Cloudflare の Worker Secret に全権パスワードがある**。Cloudflare アカウントの乗っ取りや Worker の改ざんで kick / ban / 設定置換が可能になる | Cloudflare アカウントの 2 要素認証(README で必須扱い)、RCON_PASSWORD の定期変更 |
| 許可ルートの限定 | 中継プロキシが列挙したルートのみ | Worker のコードが許可リストを持つだけ(Worker が改ざんされれば無効) | `routes.ts` の固定リスト + capabilities |
| RCON ポート | Tunnel 経由でインターネットに出さない | **RCON ポートがインターネットから到達可能である必要**。平文 HTTP のため経路上でパスワードが読まれ得る(C-1、R-5) | 強いパスワード、`PasswordHash` で ini に平文を残さない、TLS が使えるなら https(R-3) |
| 接続元の制限 | AllowedHosts に中継機の IP 1 つ | **Workers の送信元 IP は固定されず公式に列挙できないため、AllowedHosts で絞れない**(C-3)。全許可にするしかない可能性が高い(書式・挙動は R-4) | パスワードの強度(32 文字以上推奨)、RCON 側の監査ログ `/v1/audit` での AUTH_FAIL の確認(第 2 段階で画面化) |
| パネルの入口 | Access の前段で遮断 | workers.dev 上のログイン画面がインターネットに公開される | 16 文字以上のパスワード、接続元ごとのロック、`preview_urls: false` |

将来の選択肢(実装しない。短く記録するだけ): (a) 利用者が自前ドメインを持つ場合に Cloudflare Access をログインの前段に追加する、(b) RCON 側で TLS が使える場合の https 化、(c) 中継プロキシを任意オプションとして復活させ AllowedHosts を絞る、(d) Cron による常時スナップショット、(e) `PUT /v1/config` による設定変更(第 2 段階)。

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
- `error.<ApiErrorCode>` と `validation.<ValidationIssue>` は `satisfies` で全コード分を必須にしてある(コードを `src/types/api.ts` に足すとカタログが型エラーになり、訳し漏れを防ぐ。キーを 1 つ消すと tsc がエラーになることを確認済み)。`SetupWarning` の `setup.warning.<コード>`、確認ダイアログの `confirm.<action>`、操作ログの `audit.event.<event>` も、実装時に同じ方法で全コード必須にする。
- 補間: `{name}` を params の値で置換する。値は文字列化するだけで HTML エスケープはしない(Astro / React の通常の出力でエスケープされる。`set:html` / `dangerouslySetInnerHTML` にカタログの文字列を渡さない)。
- **翻訳しないもの**: RCON から返る生データ(サーバー名、マップ名・displayName、陣営名、プレイヤー名、BAN の理由・実行者、`rconMessage`)と、運営者が入力した文字列(broadcast の本文、kick の理由、操作者名)。そのまま表示する。

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
- **R-15** 認証失敗(パスワード違い)と AllowedHosts による拒否のステータスの違い、失敗が続いたときのロックアウトの有無(送信元を共有する他者の失敗に巻き込まれないか)。
- **R-16** サーバーの提供元ごとに、RCON ポートをインターネットに公開できるか(運営者ごとの確認事項。README で案内)。
- **R-17** 開発元による公式ドキュメント・RCON の外部利用に関する規約(未確認)。
- **R-18** 書き込みルートの成功時の応答(ステータスが 200 / 204 のどちらか、本文の有無と形式)。現在は 2xx なら本文に関係なく成功とする。

### Cloudflare(一次資料で未確定、または実機確認が必要)

- **C-1** `http://ホスト名:7776` への fetch が https に書き換えられず平文のまま届くか。
- **C-2** IP アドレス直指定不可(known-issues)が workers.dev のみの利用でも当てはまるか。README の回避策(自前ドメインの A レコード〔DNS only〕、IP をホスト名に埋め込む型のワイルドカード DNS サービス、ダイナミック DNS)で実際に届くか。
- **C-3** Workers の fetch の送信元 IP を公式に列挙する資料は無い(AllowedHosts に書けない前提で設計した)。
- **C-4** Deploy to Cloudflare ボタンが無料プランで使えるか(Workers Builds は Free 可と確定)。
- **C-5** ボタン経由で D1 が自動作成され、`database_id` 省略の設定で動くか。ボタンが作成した ID をコピー先リポジトリに書き戻すか。**`wrangler d1 migrations apply DB --remote` は D1 が存在しないと失敗する(wrangler 4.151 のソースで確認: "Couldn't find a D1 DB named ...")** ため、`deploy` スクリプトは「`wrangler deploy`(ここで作成)→ マイグレーション」の順にした(指示の順序と逆。理由は本項)。新しいコードが新しいマイグレーションより一瞬先に動くため、マイグレーションは追加のみ(列・テーブルの追加)とし、コードはテーブル・列が無い場合も段階 1 として動くようにする。
- **C-6** ボタンのフォームで入力した Secrets が実行時 Secrets(Settings > Variables and Secrets)に入るか。`.dev.vars.example` の空値・コメント行の扱い。
- **C-7** ボタンの設定画面で Worker 名を変えた場合に、`wrangler.jsonc` の `name` との一致(Workers Builds の要件)が保たれるか。
- **C-8** `wrangler.jsonc` の `vars`(`AUDIT_REQUIRED`)がダッシュボードで設定した値をデプロイ時に上書きするか。
- **C-9** Cron 実行が 10 万リクエスト/日に含まれるか(第 2 段階で Cron 化する場合)。
- **C-10** `@astrojs/cloudflare@14` のカスタムエントリ(`@astrojs/cloudflare/handler` の `handle` は export されていることを確認済み)に `scheduled` を同居させられるか。
- **C-11** RCON のホスト名がプロキシ(オレンジクラウド)だと 7776 番が使えない。DNS only(グレークラウド)必須であることの実機確認。
- **C-12** `redirect: 'manual'` の挙動と、無料プランでの個別サブリクエストの実際のタイムアウト。
- **C-13** ボタン / Workers Builds が `package.json` の `deploy` スクリプトをどう実行するか。pnpm には組み込みの `pnpm deploy` コマンドがあり、`pnpm deploy` と書くとスクリプトではなく組み込みが動く。手動設定では `pnpm run deploy` と書く(README に記載)。
- **C-14** 開発時(http://127.0.0.1)に `Secure` / `__Host-` Cookie が使えるか(使えない前提で開発時は別名にする)。
- **C-15** CSP の `script-src` を絞った場合に Astro 7 のアイランドのインラインスクリプトが動くか(Astro の CSP 機能の有無を含む)。
- **C-16** `@astrojs/cloudflare@14` で `waitUntil` を取る方法(`cloudflare:workers` の `waitUntil` か、locals 経由か)。
- **C-17** D1 の「書き込み行数」にインデックス更新が数えられるか(11.3 の見積りの余裕)。
- **C-18** Workers Logs(`observability.enabled`)の無料枠と保持期間。
- **C-19** 本文を読まずに返した応答の直後、同じ接続の次のリクエストが 500 になる事象(開発サーバーで観測。`docs/API_TEST.md` 4 章)が本番の Workers でも起きるか。Astro 標準の origin 検査は無効化し、middleware と API は拒否前に本文を読み捨てる対策をしたが、他の早期応答(アダプタ・アセット等)で起きないかを含めて確認する。

### 多言語化(13 章)

- **I-1** Astro 7 + `@astrojs/react` で、ページから React アイランドに渡した props(`language`、`timeZone`)の扱いと、アイランドが `src/i18n/` を import したときのクライアントバンドルの大きさ(実装後に `pnpm build` の出力で確認)。
- **I-2** 2 つ目の言語を動的 import にする場合、`getTranslator` を同期のまま保てるか(サーバーは先読み、アイランドは読み込み完了まで待つ等。追加時に決める)。
- **I-3** Workers の実行環境(workerd)とブラウザで `Intl.DateTimeFormat` の `timeZone` 指定・`ja-JP` の書式が揃うか(サーバー描画とアイランドで日時の表記がずれないか)。
- **I-4** vars `LANGUAGE` / `TIMEZONE` をダッシュボードで変えた値が、次のデプロイで `wrangler.jsonc` の値に戻るか(C-8 と同じ問題。戻る場合はフォーク側の `wrangler.jsonc` を書き換える手順を README に書く)。
- **I-5** `Accept-Language` の照合は言語コード単位(`ja-JP` → `ja`)の簡易実装。地域で文言を分けたい言語(例 `pt-BR` と `pt-PT`)を足す場合は、`LANGUAGE` の値の形式と照合規則を見直す。

### 設計上の判断(ユーザー確認事項)

以下は 2026-10-15 にユーザーが「推奨どおり」で確定した(以後は決定事項として扱う)。

- **U-1(確定)** D1 が無い・テーブルが無いときは書き込み操作を止める(既定 `AUDIT_REQUIRED="true"`)。ログ無しでの操作は利用者が明示的に `"false"` にした場合のみ。
- **U-2(確定)** セッションは 12 時間で失効し延長しない。ログイン失敗は接続元ごとに 15 分で 5 回までロック。全体ロックは行わない(第三者による締め出しを防ぐ)。
- **U-3(確定)** Steam ID はログイン後の画面で全桁表示する。監査ログは 365 日保持する。
- **U-4(確定)** 利用手順は「ボタンで複製(方法 A)」と「フォーク + ダッシュボードで取り込み(方法 B)」の 2 通りを README に残す。ボタンがリポジトリを複製する仕様のため、先にフォークしてからボタンを押すと 2 つできる可能性がある点は要確認のまま(C-5 系)。
- **U-5(確定)** IP アドレスしか無い運営者には「自前ドメイン推奨、第三者のワイルドカード DNS サービスは自己判断」と案内する(README 4.3 のまま)。
