# wardogs-ops

WARDOGS コミュニティサーバーの**運営用 RCON 操作パネル**。任意の WARDOGS サーバー運営者がフォークして使える**汎用テンプレート**として設計する。
`wardogs-ops.gmkz.jp` は作者自身の環境の例にすぎない。公開サイト `wardogs.gmkz.jp`(別リポジトリ `../wardogs.gmkz.jp`)や Discord ボットとは Worker・ドメイン・Secrets を完全に分離する。

## 最優先の方針(2026-10-15 ユーザー決定)

**エンジニアが本職でない運営者でも、構築と操作が簡単にできること。** 理想は「GitHub でフォークして Cloudflare と連携するだけで構築が完了する」形。

- Cloudflare の設定は最小限にする。**Cloudflare Access・Tunnel・中継プロキシは使わない**
- セキュリティ上のトレードオフ(下記)は設計書に明記したうえで、簡単さを優先する

## 決定事項

- 技術: **Astro + React アイランド**(`@astrojs/cloudflare`、`@astrojs/react`)。Astro は SSR・ルーティング・認証ミドルウェア、React は操作画面(状態の定期取得、kick / ban / broadcast 等のボタン)
- 認証: **アプリ内のパスワードログイン。Worker Secrets は使わない(2026-10-16 ユーザー決定)**。初回アクセス時の `/setup` で管理パスワードを登録し、PBKDF2 + salt で D1 に保存。初期設定時に生成したランダムな `instance_key`(D1 保存)から HKDF で用途別の鍵を派生し、セッション Cookie の HMAC と RCON パスワードの暗号化に使う。Cookie は `Secure; HttpOnly; SameSite=Strict`、Origin 検査による CSRF 対策、ログイン失敗制限あり
- RCON への経路: **Worker から RCON HTTP API を直接 fetch する**。接続先(ホスト名・ポート)と RCON パスワード(AES-GCM で暗号化)は **D1 の `servers` テーブル**に保存し、ログイン後の「サーバー」画面から**サーバーを何台でも追加・編集・削除**できる(2026-10-16 ユーザー決定)。ヘッダーのセレクトで操作対象を切り替える。環境変数での指定は廃止
- デプロイ: **「Deploy to Cloudflare」ボタン + Workers Builds の Git 連携**を第一候補。バインディング(D1 など)は `wrangler.jsonc` に宣言し自動プロビジョニングに任せる。ドメインは既定で workers.dev、カスタムドメインは任意
- データ: D1 = 操作の監査ログ(誰が・いつ・何を・結果)、人数の履歴スナップショット。自動プロビジョニングで作れない場合は KV のみ、または「ログ無し」でも動くよう段階的に有効化する。R2 は当面使わない
- 画面(初期スコープ): 状態 / プレイヤー / BAN 一覧 / 操作ログ。設定ファイルの編集は第 2 段階
- 書き込み操作(kick / ban / unban / broadcast / message / マップ変更 / 試合終了)は、Worker 側の確認ダイアログを通し、全件を監査ログに残す
- 利用できる基盤: Cloudflare Workers / D1 / KV / R2 / Cron。無料枠内で設計する
- 多言語化: **当面は日本語のみだが、後から多言語化できる設計にする**(2026-10-15 ユーザー決定)
  - 画面の文言はコンポーネントや Astro ページに直接書かず、**ロケール別のメッセージカタログ**(例 `src/i18n/ja.ts`、型で全キーを強制)に集約し、`t('key')` 経由で参照する
  - 命名: **利用者が触る名前は「言語 / Language」**(vars `LANGUAGE`、値は `ja` / `en` などの言語コード。利用者向け文書で「ロケール」という語は使わない)。**コード内部で `Intl` に渡す値は `locale`**(型 `Locale`、`ja` → `ja-JP` の対応表はコード側で持つ)
  - 既定の言語は `ja`。言語の決め方(vars での固定、`Accept-Language`、ログイン後の切り替え)は設計書で決める。URL に言語を含める必要は無い(ログイン必須の管理画面のため SEO 不要)
  - 日時・数値の表示は `Intl` を使い、locale とタイムゾーン(vars `TIMEZONE`、既定 `Asia/Tokyo`)を引数で受ける(JST 固定で書かない)
  - RCON から返る生データ(マップ名、陣営名など)は翻訳しない。翻訳するのは UI の文言とエラーメッセージのみ
  - README も将来 `README.en.md` を足せる構成にする(先頭に言語リンク欄を置く)

## 明示するトレードオフ(設計書・README に書く)

- RCON の全権パスワード(暗号化済み)と暗号化鍵が同じ D1 に置かれる。D1 を読める相手(Cloudflare アカウントの乗っ取り)には復号できるため、アカウントの 2 要素認証が前提(RCON に読み取り専用トークンは無い)
- デプロイ直後、管理者が未登録の間は誰でも `/setup` で登録できる。デプロイしたらすぐ登録すること、先に登録されていたら D1 の `admins` 行を消してやり直すことを README に書く
- RCON ポートがインターネットから到達可能である必要がある。Workers の送信元 IP は固定されないため、AllowedHosts で絞れない可能性がある(サーバー提供元の仕様次第。要確認)
- 認証は単一パスワードのため、強いパスワードを使う前提とし、漏えい時の差し替え手順を README に書く

## 正本と調査資料

- 企画の正本: `docs/PLAN.md`。構成の正本: `docs/ARCHITECTURE.md`(architect が起草)。API 契約: `docs/API.md`
- 構築手順(非エンジニア向け): `README.md`(1. フォーク 2. Deploy to Cloudflare 3. URL を開いて管理パスワードを登録 4. サーバー側で RCON を有効化し、画面からサーバーを追加、の順)
- RCON の仕様調査: `docs/research/wardogs-rcon.md`(非公式資料ベース。「確定 / 未検証 / 推測」の区別を守る。実在ルートは `GET /v1/capabilities` で確定する)
- Cloudflare のデプロイ方式調査: `docs/research/cloudflare-deploy-button.md`
- Discord の仕様調査: `docs/research/discord-bot-capabilities.md`(本リポジトリでは参考。ボット本体は別リポジトリ)
- Cloudflare 無料枠・Astro: `docs/research/cloudflare-free-tier.md`、`docs/research/astro-cloudflare.md`

## 共通ルール

- 言語は日本語。日時は JST
- **非公開情報を一切書かない**: ホスティング業者名、サーバーのリージョン、ゲームサーバー ID、Discord 招待リンク・ギルド ID、審査基準、運営者のメールアドレス実値、RCON の接続先ホスト名・IP。必要なら `<<NON_PUBLIC>>` のプレースホルダーを使う
- パスワード・ホスト名などの実値はリポジトリ・ログ・ドキュメントに置かない。テストとモックはダミー値のみ
- 「スポンサー」など金銭を連想させる表記・意匠は出さない
- 推測で断定しない。一次資料で確認できない項目は「要確認」として設計書に残す
- 利用者が Cloudflare ダッシュボードで行う操作は、画面の名称と順番を README に書き、CLI(wrangler)を必須にしない。CLI は開発者向けの補足にとどめる
- 作業の進め方: 司令塔(Fable)がヒアリングと振り分け、実装は `.claude/agents/` のエージェントが担当
