# wardogs-ops 企画メモ(正本)

作成日: 2026-10-15 / 改訂: 2026-10-15(ユーザー指示「Cloudflare の構成は極力シンプルに。フォークして Cloudflare と連携するだけで構築が完了する形が理想」による方針変更)。構成の詳細は `docs/ARCHITECTURE.md`(architect が起草)。

## 目的

WARDOGS コミュニティサーバーの運営者が、Web ブラウザからサーバーの状態を見て、RCON 操作(kick / ban / broadcast / マップ変更 など)を安全に実行できるようにする。

**エンジニアが本職でない運営者でも構築・操作できること**を最優先にする。リポジトリは特定のサーバー専用ではなく、**任意の WARDOGS サーバー運営者が使える汎用テンプレート**として設計する。`wardogs-ops.gmkz.jp` は作者自身の環境の例にすぎない。Discord ボット(別リポジトリ)や公開サイト(`wardogs.gmkz.jp`)とは分離する。

## 画面(初期スコープ、4 画面)

1. 状態: サーバー名、マップ、人数(現在 / 最大)、陣営スコア、ローテーション。数十秒ごとに自動更新
2. プレイヤー: 接続中一覧(名前、陣営、K/D、ping)。行ごとに kick / message / ban
3. BAN 一覧: 一覧と解除
4. 操作ログ: D1 の監査ログ(誰が・いつ・何を・結果)

後回し: 設定(`ServerSettings.ini`)の閲覧・検証・置換、人数履歴グラフ、ローテーション編集。

## 構成(決定、2026-10-15 改訂)

```
運営者ブラウザ ─▶ https://<worker>.<account>.workers.dev(カスタムドメインは任意)
                ─▶ Worker(Astro SSR + React アイランド)
                     ├─ アプリ内パスワードログイン(Secret ADMIN_PASSWORD)+ HMAC 署名 Cookie
                     ├─ D1: 監査ログ、人数スナップショット(作れない場合は段階的に無効化できる)
                     └─ fetch(Authorization: Bearer <Secret RCON_PASSWORD>)
                           ─▶ RCON HTTP API(Secret RCON_URL。サーバー側で AllowedHosts を設定)
```

- デプロイ: 「Deploy to Cloudflare」ボタン(deploy.workers.cloudflare.com)+ Workers Builds の Git 連携を第一候補にする。`wrangler.jsonc` にバインディングを宣言し、自動プロビジョニングに任せる
- 利用者の手順(README): 1. GitHub でフォーク 2. Deploy to Cloudflare ボタン 3. Secrets を 2〜3 個入力 4. サーバー側で RCON を有効化し AllowedHosts を設定

## 撤回した旧方針(2026-10-15 午前の決定)

Cloudflare Access(メール認証 + Worker 側 JWT 検証)、Cloudflare Tunnel、自宅 PC / VPS 上の中継プロキシ(RCON パスワードをそこだけに置く)は**使わない**。設定の手間が非エンジニアには重すぎるため。これに伴い「RCON パスワードを Cloudflare に置かない」も撤回し、Worker Secret に置く。トレードオフ(Cloudflare 側に RCON の全権パスワードがある、RCON ポートがインターネットから到達可能である必要、AllowedHosts に Workers の送信元を列挙できない可能性)は `docs/ARCHITECTURE.md` に明記する。

## 制約

- 認証: Worker Secret `ADMIN_PASSWORD` 1 つ。ログイン後は HMAC 署名付き Cookie(`Secure; HttpOnly; SameSite=Strict`)。ログイン失敗のレート制限(KV または D1)、CSRF 対策(Origin 検査)、パスワードの強度要件を設計に入れる
- 書き込み系の操作は Worker 側の確認ダイアログ(確認トークン or 二段階)+ 監査ログを通す。当初の許可は kick / ban / unban / broadcast / message / map 変更 / 試合終了まで。設定(`PUT /v1/config`)は第 2 段階
- Secrets(`ADMIN_PASSWORD`、`RCON_PASSWORD`、`RCON_URL`、`SESSION_SECRET`)はリポジトリに置かない
- 無料枠内(Workers / D1 / KV)

## 要確認(設計時に一次資料で確定する)

- 「Deploy to Cloudflare」ボタンの仕様(D1 の自動作成、Secrets の入力、無料プランでの可否)
- Workers の `fetch` から外部 IP の任意ポートへ平文 `http://` で接続できるか。送信元 IP レンジを AllowedHosts に書けるか
- RCON の実在ルート(`GET /v1/capabilities`)と、ビルドによる書き込み系ルートの差
- AllowedHosts の書式と、サーバー提供元が RCON ポートをインターネットから到達可能にできるか(`BindAddress=0.0.0.0` に TLS と `PasswordHash` が要るという非公式記述の真偽)
