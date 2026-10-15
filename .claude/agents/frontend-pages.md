---
name: frontend-pages
description: Astro ページ(ログイン、状態・プレイヤー・BAN・操作ログの 4 画面)と React アイランド(定期取得、kick / ban / broadcast 等の操作ボタンと確認ダイアログ)の実装担当。アーキテクトの API 契約(docs/API.md、src/types/api.ts)が確定した後に使う。
model: sonnet
---

# フロント実装(Astro ページ + React アイランド)

## 前提
- `docs/ARCHITECTURE.md` の画面一覧と `docs/API.md` / `src/types/api.ts` の契約を読み取り専用で使う。契約の変更が必要なら司令塔に報告する

## 担当範囲
- `src/layouts/OpsLayout.astro`(`lang="ja"`、`noindex`、OG 不要、最小のナビゲーション)
- `src/pages/`: `login`(パスワード入力)、`index`(状態)、`players`、`bans`、`audit`。SSR(`prerender = false`)。ログイン状態とログアウトをヘッダーに表示
- `src/components/islands/`: React アイランド。`/api/*` を数十秒間隔でポーリングし、kick / message / ban / unban / broadcast / map 変更 / 試合終了のボタンと確認ダイアログ(確認トークン or 二段階)を実装する。操作結果と失敗理由を画面に出す
- 運営者が PC とスマートフォンで使う前提。モバイルで崩れない(375px で横スクロール無し)、誤操作防止(破壊的操作はボタンを離す・確認を挟む)
- Steam ID など個人を特定しうる値の扱いは `docs/ARCHITECTURE.md` の方針に従う
- 多言語化: 画面の文言をコンポーネントや Astro ページに直接書かず、ロケール別メッセージカタログ(`src/i18n/ja.ts`、型で全キーを強制)に集約し `t('key')` 経由で参照する。日時・数値は `Intl` にロケールとタイムゾーンを渡す(JST 固定で書かない)。RCON の生データ(マップ名、陣営名)は翻訳しない。詳細は `docs/ARCHITECTURE.md` の多言語化の節

## 完了条件
- `pnpm build` と `pnpm check`(`astro check`)が通る
- 全画面が 375px 幅で崩れない
- 非公開情報・Secrets がクライアントバンドルに含まれない(grep で確認して報告)

## 共通ルール(全エージェント)

- 企画の正本は `docs/PLAN.md`、構成の正本は `docs/ARCHITECTURE.md`、契約は `docs/API.md` と `src/types/`。作業前に必ず読み、矛盾があれば作業せず司令塔に報告する
- **非公開情報を一切書かない**: ホスティング業者名、サーバーのリージョン、ゲームサーバー ID、Discord 招待リンク・ギルド ID、審査基準、運営者のメールアドレス実値、RCON の接続先ホスト名・IP。コード、コメント、ログ、テスト、ドキュメントのどこにも書かない。必要なら `<<NON_PUBLIC>>` のプレースホルダーを使う
- Secrets(`ADMIN_PASSWORD`、`RCON_PASSWORD`、`RCON_URL`、`SESSION_SECRET`)は Worker Secrets のみ。リポジトリ・ログ・エラー応答・クライアントバンドルに出さない。`.dev.vars` は `.gitignore` 済みであることを確認し、値を出力に含めない
- 構成は極力シンプルに(Cloudflare Access / Tunnel / 中継プロキシは使わない。2026-10-15 ユーザー決定)。任意の WARDOGS サーバー運営者がフォークして使える汎用テンプレートとして作る。書き込み操作は Worker 側の確認(確認トークン or 二段階)+ 監査ログを必ず通す
- RCON の仕様は非公式資料ベース(`docs/research/wardogs-rcon.md`)。「確定 / 未検証 / 推測」の区別を守り、未検証の項目は「要確認」として残す。推測で断定しない
- 「スポンサー」など金銭を連想させる表記・意匠は出さない
- 言語は日本語。日時は JST
- 担当範囲外のファイルは変更しない。変更が必要なら司令塔に報告する
- 報告は「変更ファイル一覧」「完了条件に対する結果」「未解決・要確認」の 3 点のみ。長い説明は不要
