# Deploy to Cloudflare ボタン方式の調査(Workers 直接 fetch 版)

## 確認日

2026-10-15(JST)。一次資料は developers.cloudflare.com と cloudflare.com/ips のみ。実機でのデプロイ・送信テストは未実施。

## 前提(2026-10-15 の方針変更)

Cloudflare Access / Tunnel / 中継プロキシは撤回。新方針は「Worker から RCON HTTP API を直接 fetch、認証はアプリ内パスワード、デプロイは Deploy to Cloudflare ボタン」。既存の `docs/research/cloudflare-free-tier.md`(2026-10-10 確認)と重複する数値は差分のみ記載し、Access / Tunnel に関する旧調査は本方針では使わない。

## 結論

| 項目 | 可否 | 確度 | 出典 |
| --- | --- | --- | --- |
| A. ボタンでフォーク相当の複製 + Worker 作成 + Workers Builds 接続 | 可(公開 GitHub/GitLab リポジトリのみ) | 確定(公式記述) | deploy-buttons |
| A. D1 / KV / R2 の自動作成 | 可(ただしリポジトリ側に既定値が必要と明記) | 確定(挙動の細部は要確認) | deploy-buttons |
| A. デプロイ時フォームで Secrets 入力 | 可(`.dev.vars.example` / `.env.example` で宣言) | 確定(公式記述。実画面は未確認) | deploy-buttons |
| A. 無料プランで使えるか | ボタンのページは言及なし。Workers Builds は Free で利用可 | 要確認(ボタン自体) | deploy-buttons, builds limits |
| B. `database_id` 省略で D1 自動作成 | 可(wrangler 4.45.0 以上、open beta) | 確定(beta)。`database_name` の要否は要確認 | changelog 2025-10-24, wrangler configuration |
| C. Workers から外部ホストの任意ポート(7776)へ `http://` | ポートは可(非プロキシ宛先は任意ポート)。**IP アドレス直指定は不可と明記** | ポート: 確定 / IP 直指定不可: 確定(文脈は要確認) | compatibility-flags, known-issues |
| D. 送信元 IP が cloudflare.com/ips の範囲か | 公式に「Workers の fetch の送信元はこの範囲」とする文書は見つからず。AllowedHosts の根拠として使えない | 要確認(使えない前提で設計) | ips, tcp-sockets, dedicated-egress |
| E. Workers Builds は無料プランで可 | 可(3,000 分/月、同時 1、タイムアウト 20 分) | 確定 | builds limits-and-pricing |
| F. 無料枠 | Workers 10 万/日、D1 読 500 万行・書 10 万行/日、KV 書 1,000/日、Cron 5 個 | 確定 | pricing 各ページ |

最大のリスクは C と D の組み合わせ。**RCON 接続先が IP アドレスのみだと Worker の `fetch()` では直接叩けない(公式 known-issues)。** かつ送信元 IP を固定できず、AllowedHosts に Workers を許可する書き方が公式資料から導けない。設計判断が必要(末尾「未解決」参照)。

---

## A. Deploy to Cloudflare ボタン

出典: https://developers.cloudflare.com/workers/platform/deploy-buttons/ (確認日 2026-10-15)、https://developers.cloudflare.com/changelog/post/2025-04-08-deploy-to-cloudflare-button/ (検索要約のみ、本文未取得)

### 確定

- URL 書式: `https://deploy.workers.cloudflare.com/?url=<リポジトリ URL>`。ボタン画像は `https://deploy.workers.cloudflare.com/button`。サブディレクトリの指定も可能とされるが書式は未取得。
- 流れ: (1) Cloudflare が元リポジトリをユーザーの GitHub/GitLab アカウントへクローン、(2) 設定ページでリポジトリ名・Worker 名・必要リソース名を入力、(3) Workers Builds でビルドしデプロイ。
- 対応ホスト: github.com と gitlab.com のみ。セルフホストは不可。**リポジトリは公開(public)必須**。Pages は非対応(Workers のみ)。
- リソース自動作成: KV、D1、R2、Hyperdrive、Vectorize、Secrets Store、Durable Objects、Workers AI、Queues。リポジトリの wrangler 設定を読み、作成したリソース ID で設定を更新する。「リポジトリには、リソース名・ID・その他バインディング属性の既定値を含めるべき」とある。
- 環境変数: wrangler 設定の `vars`。Secrets: `.dev.vars.example` または `.env.example`(dotenv 形式、`KEY=値 # コメント`)で宣言するとデプロイ時に入力を求められる。`package.json` の `cloudflare.bindings.<名前>.description` で入力欄の説明を付けられる(インライン Markdown 可)。
- ビルド: `package.json` の `build` と `deploy` スクリプトを自動検出して事前入力する。deploy スクリプトが無ければ `npx wrangler deploy` が既定。build が無ければ空欄。
- D1 マイグレーション: `deploy` スクリプト内で実行し、**データベース名ではなくバインディング名**を指定する(公式の指示)。
- モノレポは完全には非対応。サブディレクトリは依存を含め独立している必要がある。

### 要確認

- ボタン経由デプロイの無料プラン可否(ボタンのページに記載なし)。Workers Builds 側は Free 可(E 参照)。実アカウントで確認する。
- Secrets 入力フォームが `secrets.required`(wrangler 設定)と併用できるか。`secrets.required` は「未設定だと `wrangler deploy` が失敗する」仕様(下記 B)なので、ボタンのフォームで先に入力されるかどうかで初回デプロイの成否が変わる。未検証。
- Astro などフレームワークの扱い: ボタンのページに専用記述なし。build/deploy スクリプト検出に依存。`docs/research/astro-cloudflare.md` を参照。
- `https://deploy.workers.cloudflare.com/` は未ログインだとダッシュボードのログイン画面へ 307 リダイレクトされ、公式説明ページとしては**未取得**。ダッシュボード URL は 403 で取得不可。
- ボタンのフォームで入力した Secrets が実行時 Secrets(Settings > Variables and Secrets)に入るのか、ビルド変数に入るのかは未確認。

## B. wrangler の自動プロビジョニング

出典: https://developers.cloudflare.com/changelog/2025-10-24-automatic-resource-provisioning/ 、https://developers.cloudflare.com/workers/wrangler/configuration/ (確認日 2026-10-15)

### 確定

- 対応: KV、R2、D1 ほか(wrangler 設定ページは Queues 等も列挙)。バインディングを ID なしで書くと `wrangler deploy` が作成して紐づける。KV/D1 は `id` / `database_id` を省略、R2 はバケット名を省略。
- 必要バージョン: wrangler 4.45.0 以上(2025-10 の changelog)。**open beta**。`--no-x-provision` で無効化。
- 作成物の名前は Worker 名がプレフィックスになる。
- 初回デプロイ後は、設定ファイルに ID が無くてもリソースへの紐づけは以後のデプロイで維持される(changelog)。
- `wrangler deploy` ではローカル設定ファイルへ ID が書き戻される。**ダッシュボード / GitHub(Workers Builds)からのデプロイでは作成されるが、ID はダッシュボードでのみ確認でき、リポジトリには書き戻されない**(wrangler 設定ページ)。
- Secrets の宣言: `"secrets": { "required": ["A", "B"] }`。未設定だと `wrangler deploy` / `versions upload` が失敗し、不足名が表示される。`wrangler types` と `.dev.vars` 読み込みもこの一覧に従う。

### 要確認

- D1 で `database_name` のみの宣言で足りるか: changelog では未記載。wrangler 設定ページの D1 リファレンスは `database_id` を必須としており、自動プロビジョニングの記述と食い違う(公式ページ内で未解消)。実機検証が必要。
- 名前の決定規則(`database_name` 指定がどう効くか)は changelog に記載なし。
- Workers Builds / ボタン経由の挙動はボタン側記述(リポジトリに既定値を含める)が優先と読める。ボタン用リポジトリでは `database_name` と仮の `database_id` の両方を置く案を検証する。
- beta の解除有無と最小バージョンが現在も 4.45.0 か(検索結果のみ、changelog 本文は取得済みだが最新状態は未確認)。

## C. Workers の fetch から外部ホストの任意ポートへの平文 HTTP

出典: https://developers.cloudflare.com/workers/configuration/compatibility-flags/ 、https://developers.cloudflare.com/workers/platform/known-issues/ 、https://developers.cloudflare.com/workers/platform/limits/ 、https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/ (確認日 2026-10-15)

### 確定

- `allow_custom_ports`: 2024-09-02 以降の compatibility_date では既定で有効。`fetch()` の URL に指定したポートが使われる。Cloudflare にプロキシされていない(グレークラウド)宛先は**任意のポート**を指定可能。プロキシ(オレンジクラウド)宛先は Cloudflare のリバースプロキシが対応するポートのみ有効。→ 7776 はグレークラウド / 非 Cloudflare 宛先なら可。compatibility_date をそれ以降にすること。
- **IP アドレス直指定は不可**: known-issues の「Fetch to IP addresses」に「requests can only be made to URLs, not to IP addresses directly」とあり、回避策は自分のゾーンに A / AAAA レコードを作ってホスト名で fetch すること(例は `http://` + ホスト名)。
- サブリクエスト上限(Free): 1 リクエストあたり 50(リダイレクトの各ホップも含む)。同時に応答ヘッダ待ちにできる接続は 6。
- 個別サブリクエストの時間制限: 公式 limits ページは「個別サブリクエストに一定の時間制限はない」旨。クライアント切断時に未完了処理がキャンセルされ得る。Free の CPU 時間 10 ms にはネットワーク待ち時間は含まれない。
- 生 TCP(`connect()`)は別機能。Cloudflare IP・localhost・プライベート IP は不可、ポート 25 は既定で禁止。HTTP は `fetch` を使うよう案内されている。RCON は HTTP なので `fetch` を使う。

### 要確認

- `http://ホスト名:7776` が実際に `https://` へ書き換えられず平文のまま届くか: 公式ドキュメントに「書き換えられる / られない」の明記は見つからず(known-issues の例は `http://` ホスト名の fetch を使用)。実機検証が必要。
- 公式 known-issues の IP 直指定不可が、ゾーンを持たないアカウントや `workers.dev` でも当てはまるか、また IP のみの接続先を使う運営者がどう回避するか(自前ドメインの A レコードを要求する設計になる)。文脈の詳細は未確認。
- ホスト名がオレンジクラウドだと 7776 が無視される可能性がある。運営者の DNS はグレークラウド(DNS only)必須。
- 無料プランでの個別タイムアウト実測値は未確認。RCON 側が遅い場合は Worker 側で `AbortSignal` により上限を設ける設計にする(これは設計案であり、公式記述ではない)。
- 同一 Worker が多数の fetch を並列に出す場合の 6 接続制限(画面更新で複数 API を同時に叩く設計に影響)。

## D. Workers の送信元 IP

出典: https://www.cloudflare.com/ips/ 、https://developers.cloudflare.com/fundamentals/concepts/cloudflare-ip-addresses/ 、https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/ 、https://developers.cloudflare.com/smart-shield/configuration/dedicated-egress-ips/other-products/ (確認日 2026-10-15)

### 確定(文書に書かれていること)

- `cloudflare.com/ips` は「Cloudflare の現行 IP レンジの正本」で、Workers や送信接続への言及はない。
- Cloudflare IP の基本ページ: プロキシ経由のオリジン接続はそのレンジから来る。一方「他のプロダクト用の別レンジも使うが、それらはオリジンへ接続しない」とあり、`172.64.0.0/13` は公開 egress 用空間の旨の注記がある。Workers への言及はない。
- Workers の TCP `connect()` の送信元は「公開 IP レンジ一覧に含まれないプレフィックス」と明記。
- Workers の `fetch()` については、Enterprise の Dedicated CDN Egress IPs を使うと固定の送信元になる(他プラン向けではない)。

### 要確認 / 判断

- 通常の Workers `fetch()` の送信元が cloudflare.com/ips のレンジか、そうでないかを断言する公式文書は**見つからなかった**。固定される保証も書かれていない。
- よって AllowedHosts(RCON 側の許可リスト)に書く材料としては**判断できない**。Cloudflare のレンジを列挙しても通る保証はなく、レンジは変更もされる。
- 実機で RCON 側のログから実際の送信元を観測する案はあるが、固定でない場合は運用に耐えない。業者が AllowedHosts 無効化または広い範囲の許可を認めるか、あるいは `docs/research/wardogs-rcon.md` の AllowedHosts 書式(未検証項目)を確認する必要がある。
- 結論: 公式資料からは「Workers から RCON を安全に許可リストで絞る」ことの成立を確認できない。アプリ内パスワード + RCON 側トークンのみでの運用になる前提を司令塔に確認してもらう。

## E. Workers Builds

出典: https://developers.cloudflare.com/workers/ci-cd/builds/ 、https://developers.cloudflare.com/workers/ci-cd/builds/limits-and-pricing/ 、https://developers.cloudflare.com/workers/ci-cd/builds/configuration/ 、https://developers.cloudflare.com/workers/configuration/environment-variables/ (確認日 2026-10-15)

### 確定

- Free プラン: ビルド 3,000 分/月、同時ビルド 1、タイムアウト 20 分(検索要約: 2 vCPU / 8 GB メモリ / 20 GB ディスク)。Git 連携は GitHub / GitLab(と Artifacts)。
- 既存 Worker への接続: Workers & Pages > 対象 Worker > Settings > Builds > Connect。新規は Create application > Import a repository。
- トリガー: 接続リポジトリへの push。production ブランチへの push が本番バージョンになり、他ブランチはプレビュー。
- **ダッシュボード上の Worker 名は wrangler 設定の `name` と一致している必要があり、不一致だとビルド失敗**。フォーク後もこの名前が一致する設計にする(ボタンの設定ページで Worker 名を変えられるため、利用者が変更した場合の挙動は要確認)。
- ビルド設定: build コマンド(任意)、deploy コマンド(既定 `npx wrangler deploy`)、Root directory(任意)。
- 実行時 Secrets の設定場所: Workers & Pages > 対象 Worker > Settings > Variables and Secrets > Add > 種類 Secret。**Settings > Build のビルド変数 / シークレットは実行時には見えない**(別物)。Secret は設定後に値が表示されない。

### 要確認

- `vars` を wrangler 設定に書いている場合、ダッシュボードで設定した値が次回デプロイで上書きされるか(公式ページが言及せず)。機微値は `vars` に書かない。
- フォークしたリポジトリに初回 push する前の Workers Builds の状態(ボタン経由では自動接続とされるが、設定画面の実際は未確認)。

## F. 無料枠(`cloudflare-free-tier.md` との差分のみ)

確認日 2026-10-15。出典: https://developers.cloudflare.com/workers/platform/limits/ 、https://developers.cloudflare.com/workers/platform/pricing/ 、https://developers.cloudflare.com/d1/platform/pricing/ 、https://developers.cloudflare.com/kv/platform/pricing/

- 既存の数値(Workers 10 万/日・CPU 10 ms・サブリクエスト 50・Cron 5 個、D1 読 500 万 / 書 10 万行/日・5 GB、KV 読 10 万・書 1,000・削除 1,000・一覧 1,000/日・1 GB)は**2026-10-15 時点で再確認し変更なし**。UTC 0 時リセット。
- 追加: 静的アセットへのリクエストは無料・無制限(pricing)。Workers 側の Cron は Free で 5 個(limits)。pricing ページ自体は Free の Cron 個数を載せない。
- 追加: 同時接続 6(上記 C)。
- 要確認(既存ファイルの要確認 6 を引き継ぎ): Cron 実行が 10 万/日に含まれるか。
- 本パネルへの含意: 運営者 1 人利用なら 10 万/日に余裕。状態の自動更新(数十秒ごと)は、1 画面あたりのサブリクエスト数 × 開いているタブ数に注意(1 リクエスト 50 上限内)。D1 は監査ログのみなら書き込み上限に余裕。

## 設計者向け転記メモ

- README のボタン: `[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=<公開リポジトリ URL>)`(URL 実値は公開後に確定)。
- リポジトリは public 必須。非公開情報(接続先ホスト名・IP)はコミットしない。接続先は Secret または Settings の変数で入力させる。
- `.dev.vars.example` に Secrets 名のみ(値はダミー)を書き、`package.json` の `cloudflare.bindings` に説明を付ける案。
- `package.json` の `deploy` スクリプトで D1 マイグレーション → `wrangler deploy` の順にする(ボタンの公式手順)。マイグレーションにはバインディング名を使う。
- compatibility_date は 2024-09-02 以降にする(`allow_custom_ports` を既定有効にするため)。
- RCON 接続先は**ホスト名で指定する**(IP 直指定は公式 known-issues で不可)。運営者が IP しか持たない場合の手順は未解決。

## 未解決・要確認(まとめ)

1. 平文 `http://ホスト名:7776` が実際に届くか(書き換えの有無)。実機検証。
2. IP 直指定不可の適用範囲と、IP しか無い運営者の回避策(A レコード用の自前ドメイン要否)。
3. Workers の送信元 IP を RCON の AllowedHosts に書く根拠が公式資料に無い。許可リスト運用の成立可否は司令塔の判断が必要。
4. D1 の `database_name` のみ宣言での自動作成、およびボタン経由での既定値の書き方。
5. ボタン経由デプロイの無料プラン可否、Secrets フォームと `secrets.required` の併用。
6. Workers Builds でフォーク後の Worker 名一致と、`vars` のダッシュボード値上書きの有無。
7. 公式説明ページ(deploy.workers.cloudflare.com)は未ログインではログイン画面へ転送され未取得。
