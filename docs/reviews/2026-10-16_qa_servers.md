# QA レビュー 2026-10-16(JST): 複数サーバー対応

対象: コミット 19bc295(設計)、1f35328(backend)、36c58f9(frontend)。`git diff 091cc83..HEAD`(62 ファイル)。実施: qa-reviewer。修正は行わず報告のみ。
方法: `src/lib/{keys,servers,config,confirm,actions,audit,snapshots,reads,runtime,server-api}.ts`、`src/lib/rcon/{capabilities,client}.ts`、`src/pages/api/{servers,actions,audit,session,status}*`、`src/layouts/*`、`src/components/{ServersPanel,ConfirmDialog,AuditLog,ServerGate,...}`、`db/`、`src/styles/ops.css`、README、docs を全読。`pnpm test`(11 ファイル・93 件成功)。別ディレクトリへ `astro build` して grep。起動中の dev サーバー(4322、モック 7776 / 7777)へ curl で 60 件超のリクエスト(再起動・停止なし)。
値(パスワード・Cookie・接続先)はこの報告に書かない。
ローカル D1 に残った痕跡: 確認用に登録・削除した id 7・8(`settings_audit_log` に追加・変更・削除の行、`audit_log` に拒否の行が数件)。ほかの `QA-*` / `Mock B` / `ブラウザ追加 B` は私が作ったものではないので触っていない。

結論: **重大 0 件 / 要修正 4 件 / 提案 11 件**。暗号化(IV 乱数・AAD に宛先・`s`/`a` 鍵・再暗号化)、server_id のすり替え防止、`/api/servers/*` の認証・CSRF・応答にパスワードが無いこと、Secrets 格下げ後のログイン、`needsPassword` の遮断は、コードと実機の両方で設計どおり。要修正は「README / Deploy ボタンが旧方式のまま」「サーバー設定の拒否が記録に残らない」「記録の食い違い 2 件」。

---

## 重大

なし。

確認済みの根拠(漏れなし):

- 暗号化(`src/lib/servers.ts:111-148`、`src/lib/keys.ts:57-100`): IV は 12 バイトを毎回 `getRandomValues`(`:120-121`)。AAD は `wardogs-ops/server-password/v1|<k>|<scheme>://<host>:<port>`(`:102-104`)で、暗号化と復号で同じ関数。鍵は HKDF(info = `server-password`)で `extractable: false`、`s` は SESSION_SECRET だけ・`a` は ADMIN_PASSWORD だけ(セッション鍵の ikm とは別)。復号失敗は `{ ok: false }` に統一され、例外・平文・暗号文・鍵をログにも応答にも出さない(`servers.ts` に `console.*` 無し。リポジトリ全体の `console.*` は前回と同じ 4 か所のみ)。
- `needsPassword`: `resolveServer`(`:313-329`)が `SERVER_NEEDS_PASSWORD`(409)を返し、読み取り API・prepare・execute・接続テストのすべてがこれを通る。ページは `ServerGate` が理由だけを出してアイランドを描画しない。ヘッダーのセレクトには印が付く。単体テストあり(`servers.test.ts:223`)。実機で再現はしていない(鍵を変えられないため)。
- すり替え(実機): prepare を server 4 で取ったトークンを、execute で server 5 / default に変えると 400 `CONFIRM_INVALID`、存在しない 999 では 404、`server` 省略は 400。prepare 後にポートを変更(パスワード付き)して execute すると 400 `CONFIRM_INVALID`(`sh` による宛先照合)。無効化したサーバーは prepare・execute とも 409 `SERVER_DISABLED`。トークン不正なら `SERVER_*` より `CONFIRM_INVALID` を優先する(`actions.ts:196-199`)ので、トークンを持たない者に id の有無を探られない。AUTOINCREMENT で id は再利用されない。
- `/api/servers/*`(実機): 未ログインの GET / PUT / DELETE / test は 401、Origin 無し・別オリジンの POST は 403、`text/plain` は 415、GET などは 405。応答は `Cache-Control: no-store`。`GET /api/servers` の応答にパスワード・暗号文・`v1.s.` / `v1.a.` は無い(登録・更新・テスト・削除の応答も同様)。ホスト名は IP 直指定(`127.0.0.1`、`0x7f.1`、`2130706433`、`[::1]`)・認証情報付き・URL / ポート貼り付け・空白・`/` を 400 で拒否。`LOCALHOST.` は `localhost` に正規化されて通る(開発用途の想定どおり)。ポート 0 / 文字列、パスワードの非 ASCII・257 文字以上、表示名 33 文字、本文が配列、をそれぞれ 400。余分な項目(`scheme` / `id` / `rcon_password_enc`)を付けても無視される。`reenter_required`、`SERVER_READ_ONLY`、`confirmName` の `required` / `mismatch`、接続テストの 5 秒制限(429 `RATE_LIMITED`、`retryAfterSec` 付き)も期待どおり。接続テストのタイムアウトは `READ_TIMEOUT_MS = 5000`。
- 上限 20 と同時書き込み: `INSERT ... SELECT ... WHERE COUNT(*) < 20` と `settings_audit_log` の INSERT が 1 つの `db.batch()`(`servers.ts:607-623`)、更新・削除も同様(`:723-731`、`:775-785`)。単体テストで 20 台上限を確認。本番 D1 での原子性は未確認(下記)。
- 認証: `src/middleware.ts` は `/api/*` を含む全パスで設定チェック → CSRF → セッション検証を行う(除外は `/_astro/` のみ。前回 M-4 は修正済み)。選択 Cookie(`wo_server` / 本番 `__Host-wo_server`)は `HttpOnly; SameSite=Strict`(本番は `Secure` も)で、署名しないが毎回 D1 と照合するので、書き換えても使えるサーバーが変わるだけ。ログアウトで両方を消す。
- Secrets 格下げ: ログインを止めるのは `ADMIN_PASSWORD` の不備と `SESSION_SECRET_TOO_SHORT` などの 4 つだけ(`config.ts:16-21`)。`RCON_URL` / `RCON_PASSWORD` が未設定・片方だけ・不正でもログインできる(`config.test.ts:31,49,62`)。現在の dev サーバー(`RCON_*` あり)でログイン成功を確認。`/setup` の「未設定」は `ADMIN_PASSWORD` だけ(`setup.astro:30`)。0002 未適用の D1 は `probeD1` が `not_migrated` にし、`features` がすべて false(読み取り専用。`config.test.ts:73`)。
- すべての API 呼び出しに `server` が付く: 読み取りは `withServer(...)`(`StatusPanel` / `PlayersTable` / `BansTable` / `useCapabilities`)、書き込みは prepare・execute の本文に `server`(`ConfirmDialog.tsx:82,135`)。`/api/session` と `/api/servers*` と `/api/audit`(`server` は任意の絞り込み)はサーバー非依存で正しい。
- 漏れ(grep): `.dev.vars` は `.gitignore` 済みで追跡されず、全履歴にも値が無い(`ADMIN_PASSWORD` 実値を追跡ファイル・直近 50 リビジョンで grep して 0 件)。ビルド後の `client/` に `ADMIN_PASSWORD` / `RCON_URL` / `RCON_PASSWORD` の実値、暗号文(`v1.s.` / `v1.a.`)、`rcon_password_enc` は無い(Secret の「名前」を使う案内文言のみ)。メールアドレス・招待リンク・生の IP(文書用アドレス以外)・ホスティング業者名・「スポンサー」等は `src` / README / docs(調査資料を除く)に無い。ローカル用の `RCON_URL` / `RCON_PASSWORD` の値と一致するのは、README・テスト・モックにある公開のダミー値だけ。
- UI 文言: `src/components` / `pages` / `layouts` / `lib` にカタログ外の日本語直書きは無い(ソース内コメントのみ)。パスワード欄は `type="password"`・`autocomplete="new-password"`、ほかの欄は `autocomplete="off"`(`ServersPanel.tsx:337,353,373,390`)。削除は表示名の入力が一致するまで押せない(`:592`)。
- 無料枠: スナップショットは `(server_id, bucket)` で 5 分 1 行 / 台(`snapshots.ts`)。ページ表示の D1 読み取りは `listServers` 1 回(最大 20 行)で、`/api/session` が 1 回、読み取り API がサーバー解決で 1 行。見積り(15.9)内。

---

## 要修正

### M-1 README / Deploy ボタン / `.dev.vars.example` が旧方式(RCON_URL・RCON_PASSWORD 必須)のまま
- `package.json:53-58`(`cloudflare.bindings` に `RCON_URL` / `RCON_PASSWORD`)、`.dev.vars.example:9,11`、`README.md:56`(1 章「パスワードを 2 つ作る」)、`:94`(「3 つを入力」)、`:105`(方法 B の手順 4)、`:116-117`(3 章の表が必須扱い)。
- 影響: 4.4 は「Secrets を設定する必要はありません」と書くのに、Deploy ボタンのフォームは今も 3 つの入力を求める。初めて使う人が必須と思い込み、(1) IP アドレスしか無い場合に詰まる、(2) 2 台目以降は画面から足せることに気付かない。`ARCHITECTURE.md` 15.12 で architect の担当になっている未完了項目(U-7)。
- 修正案: 必須を `ADMIN_PASSWORD` だけにし、`RCON_URL` / `RCON_PASSWORD` は「任意(1 台目を Secrets で持ちたい場合。ふつうは 4.4 の画面から追加)」へ移す。1 章の表・2 章・3 章・5 章の手順を、「ログイン → サーバー設定 → 追加」の流れに合わせる。あわせて `src/types/env.ts:57-61` の `@deprecated REQUIRED_SECRETS` と、`src/types/api.ts` の「実装後に必須化」の `?`(`:205,336,378,381,447,460`)を整理する。

### M-2 サーバー設定の拒否が記録に残らない(QA 基準「失敗を含め全件が記録に残る」)
- `src/lib/servers.ts:687`(`reenter_required`)、`:772-773`(`confirmName` 不一致)、`:659,765`(`SERVER_READ_ONLY`)、検証失敗の全般は `settings_audit_log` に行を作らない。接続テスト(`:792-829`。保存済みの RCON パスワードを Bearer で外に送る操作)は成功しても記録が無い。
- 影響: Cookie を盗んだ者が「宛先だけ書き換えてパスワードを持ち出す」試行(`reenter_required` が止めた分)や、他のサーバーの削除試行の痕跡が、設定変更ログからも操作ログからも見えない。前回 M-2 で書き込み操作の拒否は `recordRejected` で記録する方針になったが、サーバー設定には適用されていない。
- 修正案(D1 書き込み枠との兼ね合いで architect が判断): 少なくとも `reenter_required` / `confirmName` の `mismatch` / `SERVER_READ_ONLY` と接続テストを 1 行記録する(`event` は `server_update_rejected` のように追加。`settings_audit_log.event` は CHECK 無しなのでマイグレーション不要)。検証エラー(形式不正・重複)は記録しなくてよい、と明文化する。

### M-3 `docs/API_TEST.md` の記録が実装と食い違う
- `:163-165`(5.5 未確認): 「ページが第 3 引数を渡していないので `Set-Cookie: wo_server` が出ない」とあるが、現在は全ページが `Astro.response` を渡しており、実機で `GET /?server=4` と `GET /players?server=default` が `Set-Cookie: wo_server=…; HttpOnly; SameSite=Strict`(開発のため `Secure` 無し)を返すことを確認した。`?server=999` / `abc` は Cookie を出さず「見つかりません」の案内になる。記録を更新する。
- `:149`(S-E17「本文の無い DELETE → 400 `BAD_REQUEST`」): `Content-Type` 無しの本文なし DELETE は 415 `UNSUPPORTED_MEDIA_TYPE`(`Content-Type: application/json` で本文が空のときだけ 400)。記録の再実行が必要。

### M-4 監査ログ・スキーマの注記が実態と矛盾する(接続先の保存)
- `src/lib/audit.ts:4`「RCON の接続先は保存しない」は、今は `settings_audit_log.params_json` に `host` / `port`(追加・変更・削除)を保存している(`servers.ts:605,702-706,783`。`db/schema.sql` の注記は「パスワード・暗号文は入れない」とだけ書く)。ホスト名は D1 の `servers` にも保存されるので、保存自体は設計どおり(画面に出る運営者自身のデータ)だが、「接続先を保存しない」という前提で読む人(README の 6.4 など)と、`docs/PLAN.md` の非公開情報の方針が食い違って見える。
- 修正案: コメントを「RCON の接続先は audit_log には保存しない(settings_audit_log と servers には運営者が登録したホスト名・ポートを保存する)」に直し、`ARCHITECTURE.md` 8 章に明記する。

---

## 提案

### S-1 鍵の移行(`a` → `s`)が `GET /api/servers` を開いたときにしか走らない
- `src/pages/api/servers/index.ts:15-17`。ページ表示(`page-context.ts:48`)と `/api/session`(`session.ts:13`)は `listServers` を呼ぶのに `migrations` を捨てている。README 6.3 は「SESSION_SECRET を設定して『サーバー設定』を一度開いてから ADMIN_PASSWORD を変える」と手順を書いているが、開き忘れると全台が `needsPassword` になる。
- 案: `/api/session`(全ページで 1 回呼ばれる)でも `waitUntil(migratePasswords(...))` を走らせる。データ量が小さく、1 行 1 回きりで冪等。4.4 に「先に `SESSION_SECRET` を設定してからサーバーを追加する」と書く(今は 6.3 だけ)。3 章の `SESSION_SECRET` の説明にも「画面から追加したサーバーのパスワードの暗号鍵になる」を足す。

### S-2 存在しない `server` の拒否が、その id の履歴として監査ログに残る
- `src/lib/actions.ts:63-66,198`: execute に存在しない id(例 `999`)を送ると、`server_id = 999` / `server_name = NULL` の拒否行が書かれ(実機で確認、`GET /api/audit?server=999` に出る)、将来 id 999 のサーバーを作ると、その履歴に混ざる。無効化済みサーバーの拒否行も `server_name` が NULL(`:65`)で、名前を引ける場合は残した方が読みやすい。
- 案: `SERVER_NOT_FOUND` の拒否は `server_id` を入れずエラーコードだけにする(NULL は既定サーバーと同じ意味なので、`params` に送られた id を文字列で残すのが無難)。`SERVER_DISABLED` / `SERVER_NEEDS_PASSWORD` は解決時に行を読んでいるので名前を返す。

### S-3 ホスト名の検証がラベル単位ではない
- `src/lib/servers.ts:426-444`: `a..b`、`ex_ample.com`、`xn--bad` が通る(接続テストで `RCON_UNREACHABLE` になるだけで無害)。誤入力を保存前に弾けると、非エンジニアの「保存したのに繋がらない」が減る。案: 各ラベルを `[a-z0-9-]{1,63}`(先頭末尾に `-` 不可)、全体に `.` を 1 つ以上要求(ただし開発の `localhost` は例外)。
- 参考(要判断): 本番で `localhost` を登録しても Worker は必ず接続できない。README に「`localhost` はローカル開発用」と一言ある(開発者向け)が、画面のヘルプには無い。

### S-4 選択 Cookie を GET(`?server=`)で発行している
- `page-context.ts:55`。QA 基準「GET で副作用を起こさない」に形式上は触れるが、Cookie は署名なし・`SameSite=Strict` で、書き換えても使えるサーバーが変わるだけ、ナビのリンクにも `?server=` を付けるので害は小さい。設計(15.5)の決定事項として理由が書かれているため、問題ではなく記録。

### S-5 同時編集の上書き
- `servers.ts:723-731`: `UPDATE ... WHERE id = ?` に `updated_at` の照合が無く、2 人が同時に編集すると後勝ちで黙って上書きされる。`migratePasswords` は旧暗号文を照合しているが、編集は旧暗号文を再投入する経路がある(パスワード未指定の保存が、並行して走った `a → s` 移行を元に戻し得る。害は無いが、次回また移行される)。案: `WHERE id = ?8 AND updated_at = ?9`。

### S-6 「既定サーバー(Secrets)」という表示
- `src/i18n/ja.ts:135`(`server.defaultName`)。非エンジニアには「Secrets」が分からない。README の用語表にはあるが、画面の見出し・セレクトに出る。案: 「既定サーバー(Cloudflare で設定)」など。

### S-7 操作ログのサーバー絞り込みに、削除済みサーバーが出ない
- `src/pages/audit.astro:11`: 絞り込みの選択肢は現在の一覧から作るので、削除したサーバーの履歴は「すべて」でしか見つからない(行には記録時点の名前が出る)。案: 削除済みの `server_id` を操作ログから `DISTINCT` で拾って選択肢に足す、または説明を 1 行足す。

### S-8 README 4.4 と開発者向け手順の読みやすさ(非エンジニア視点)
- 4.4 は 4 章「ゲームサーバー側で RCON を有効にする」の中にあり、見出しと内容が合わない(パネル側の操作)。4.4 を独立の章(例: 「5. サーバーを追加する」、動作確認を 6 章に繰り下げ)にし、手順は「ログイン → サーバー設定 → 追加 → 接続テスト」の順に。5 章の手順 3「状態画面にサーバー名…が表示されれば成功」は、サーバー 0 台だと「サーバーを追加してください」の案内が出るので、先に 4.4 を済ませる旨を足す。
- 「ホスト名」「ポート」の説明は 0 章と 4.3 にあり、4.4 の手順 3 では「例: `rcon.example.com`」だけ。管理画面に出ている接続先が `IP:ポート` だった場合の判断(4.3 へ戻る)を手順の中にも 1 行置く。
- 開発者向けの「ローカルで動かす」は、`.dev.vars` の `RCON_*` を入れる手順(2)と、無くてもよい手順(モック 2 台の 2)が混在している。どちらが既定か先頭に 1 行(「ADMIN_PASSWORD だけで足りる。RCON_* は任意」)。「ループバック」「環境変数」は用語表に無い(開発者向けなので重要度は低い)。PowerShell の `$env:` 構文は括弧付きの注意があると親切。

### S-9 ビルド成果物に `.dev.vars` の複製が入る
- `astro build` の出力(`dist/server/.dev.vars`)に、`.dev.vars` の全値がそのままコピーされる(`dist/` は `.gitignore` 済みでコミットはされない。`wrangler deploy` が `dist/server/.dev.vars` を Worker のコードとして送らないことは未確認)。Workers Builds(方法 B)では `.dev.vars` が無いので影響しないが、手元でビルドしたものを手動デプロイする運営者のために、`README` の手動デプロイ手順に「`.dev.vars` を一時的に退避してからビルドする」か、アダプターの挙動確認を足す。要確認として architect / api-research に回す。

### S-10 `rconMessage` の扱い
- `ServersPanel.tsx:249-253`: 登録サーバーが返した 4xx の `error` / `message` 文字列(制御文字除去・長さ制限あり、`client.ts:56-58`)をそのまま `<code>` に出す。React がエスケープするので XSS にはならないが、登録先は運営者が入力したホスト名なので、他人が管理するホストを登録すると任意文字列が画面に出る。許容範囲だが、設計(3.1 の rconMessage の扱い)に「登録サーバーの応答は信頼しない」と書いておく。

### S-11 検査環境で確認できなかった点(次回の確認項目)
- `wrangler dev`(本番ビルド)での `__Host-wo_server` の発行、本番 D1 での `db.batch()` の原子性(特に UNIQUE 違反時の巻き戻し)、375px 幅での `/servers` とヘッダーのセレクトの実測、253 文字のホスト名がカード表示で崩れないか(CSS 上は `body { overflow-wrap: anywhere; overflow-x: hidden }` で横スクロールは出ない設計だが、隠れて切れていないかは未確認)、`needsPassword` の実機再現(鍵を変えた状態)。
- CSS の読みでの判断: `@media (max-width: 639px)` でセレクトを 1 行全幅にし(`ops.css:728-748`)、`.table-cards` は 719px 以下でカード化(`:575-`)。ブレークポイントが 639 / 719 の 2 つあり、640〜719px ではヘッダーはワイド配置・表はカードという組み合わせになる(崩れはしないが、揃えると保守しやすい)。ボタンは `min-height: 44px`、削除は他ボタンから離れた `destructive-group`、確認は表示名の入力で二段階。誤タップはしにくい。

---

## 付記

- 前回の要修正(M-1 execute の通信失敗後の二重実行、M-4 `/_image` 素通し)は修正済みを確認(`ConfirmDialog.tsx:51-53` の `UNKNOWN_RESULT`、`middleware.ts:19-21`)。
- 二次レビュー(Opus)に回す候補: M-2(記録の範囲の判断)、S-1(移行のタイミングと README の手順)、S-2(拒否行の `server_id` の意味)。
