# wardogs-ops.gmkz.jp

WARDOGS 53(日本人ストリーマー向け WARDOGS コミュニティサーバー)の**運営用 RCON 操作パネル**。
公開サイト `wardogs.gmkz.jp`(別リポジトリ `../wardogs.gmkz.jp`)とは Worker・ドメイン・Secrets を完全に分離する。

## 決定事項(2026-10-15 ユーザー決定)

- ホスト: `wardogs-ops.gmkz.jp`(gmkz.jp ゾーンのサブドメイン)。Worker 名 `wardogs-ops`
- 技術: **Astro + React アイランド**(`@astrojs/cloudflare`、`@astrojs/react`)。Astro は SSR・ルーティング・認証ミドルウェア、React は操作画面(状態の定期取得、kick / ban / broadcast 等のボタン)
- 認証: Cloudflare Access(運営者のメール 1 件)+ Worker 側で `Cf-Access-Jwt-Assertion` を毎リクエスト検証(多層防御。`../wardogs.gmkz.jp/docs/ADMIN.md` 2 章と同じ方式)
- RCON への経路: **Workers から RCON を直接叩かない**(送信元 IP が固定されず、RCON は平文 HTTP・AllowedHosts 前提・読み取り専用トークン無し)。自宅 PC / VPS 上の**中継プロキシ**(RCON パスワードはここにだけ置く。許可ルートを明示列挙)を **Cloudflare Tunnel** で公開し、Worker は Access サービストークン付き fetch で呼ぶ
- データ: D1 = 操作の監査ログ(誰が・いつ・何を)、人数の履歴スナップショット。R2 は当面使わない
- 利用できる基盤: Cloudflare Workers / D1 / R2 / KV / Cron / Access / Tunnel。無料枠内で設計する

## 正本と調査資料

- 企画・構成の正本: `docs/PLAN.md`、`docs/ARCHITECTURE.md`(architect が起草)
- RCON の仕様調査: `docs/research/wardogs-rcon.md`(非公式資料ベース。「未検証」の区別を守る。実在ルートは本番で `GET /v1/capabilities` で確定する)
- Discord の仕様調査: `docs/research/discord-bot-capabilities.md`(本リポジトリでは参考。ボット本体は別リポジトリ)
- Cloudflare: `docs/research/cloudflare-free-tier.md`、`docs/research/astro-cloudflare.md`

## 共通ルール

- 言語は日本語。日時は JST
- **非公開情報を一切書かない**: ホスティング業者名、サーバーのリージョン、ゲームサーバー ID、Discord 招待リンク・ギルド ID、審査基準、運営者のメールアドレス実値、RCON の接続先ホスト名・IP。必要なら `<<NON_PUBLIC>>` のプレースホルダーを使う
- Secrets(RCON パスワード、Access サービストークン、D1 以外の認証情報)はリポジトリに置かない。RCON パスワードは Cloudflare 側にも置かず、中継プロキシの機械にだけ置く
- 「スポンサー」など金銭を連想させる表記・意匠は出さない
- 推測で断定しない。一次資料で確認できない項目は「要確認」として設計書に残す
- 作業の進め方: 司令塔(Fable)がヒアリングと振り分け、実装は `.claude/agents/` のエージェントが担当。エージェント定義は公開サイト用から持ち込んだものなので、本リポジトリの担当範囲に合わせて適宜書き換える
