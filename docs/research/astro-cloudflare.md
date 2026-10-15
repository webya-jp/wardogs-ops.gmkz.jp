# @astrojs/cloudflare と Astro 5 の構成調査

## 確認日

2026-10-10

## 出典 URL

- @astrojs/cloudflare の公式ガイド: https://docs.astro.build/en/guides/integrations-guide/cloudflare/
- オンデマンド描画(prerender): https://docs.astro.build/en/guides/on-demand-rendering/
- npm レジストリ(最新版の確認): https://registry.npmjs.org/@astrojs/cloudflare
- Cron と scheduled ハンドラー(Cloudflare 公式): https://developers.cloudflare.com/workers/configuration/cron-triggers/
- 非公式情報(ブログ記事、検索結果の要約のみ・原文未確認): Astro の default export に `scheduled` を追加し、`fetch` を `@astrojs/cloudflare/handler` の `handle` に委譲する方法の記事がある。公式ドキュメントではない

## 確定事項

### 現行バージョン
- npm の `dist-tags.latest` は `14.3.4`(npm レジストリで確認)
- 公式ガイドの冒頭にも「v14.3.4」の記載がある

### 出力モードと prerender
- 既定: ページはビルド時に静的生成(prerender)される
- 個別ページをオンデマンドにする: ファイル先頭に `export const prerender = false` を書く。オンデマンド化にはアダプターの追加が必要
- `output: 'server'` にすると全ページがサーバー描画になる。個別に静的化するなら `export const prerender = true` を書く
- `output: 'server'` は描画の既定を切り替えるだけで、追加機能はない

### PLAN との対応
- PLAN の「静的ページは prerender、/api/* のみ SSR」は、`output: 'static'`(既定)で `/api/*` に `export const prerender = false` を付ける形で実現できる
- ページ単位で制御するため、ハイブリッド(旧 hybrid 指定)の代わりにこの方式を使う想定

### wrangler.jsonc の断片(公式ページ記載)
- `main`: `@astrojs/cloudflare/entrypoints/server`(新しい値)。旧値は `dist/_worker.js/index.js`
- `compatibility_date`: 例として `2025-05-21`(公式ページの例。実装時は最新を使う)
- `assets`: `directory: ./dist`、`binding: ASSETS` の例あり。ただし新しいアダプターでは不要とされ、削除してよい基本設定として紹介されている

### Cron の scheduled ハンドラー
- Cloudflare 公式: Cron Triggers は UTC 基準。Worker には `scheduled` ハンドラーが必要。`triggers.crons` で設定する
- Cloudflare 公式: Free はアカウントあたり Cron 5 個まで
- Astro 公式ガイドには scheduled ハンドラーの記載なし。カスタムエントリーの例は fetch と queue のみ

## 要確認事項

1. **Astro 5 とアダプターの major 版の対応**: npm の最新は 14.x。Astro 5 対応の版を `npm view @astrojs/cloudflare@<版> peerDependencies` で確認する必要がある。公式ガイドからは確定できず。
2. **Cron を Astro 出力 Worker に同居させる方法**: 公式には記載なし。非公式ブログには「カスタムエントリーで fetch を Astro に委譲し、scheduled を追加する」方法があるが、`@astrojs/cloudflare/handler` の import パスは公式で未確認。採用するなら architect が実機で検証する。
3. **分離構成の方が安全か**: PLAN は「サイト用 Worker と Cron 用 Worker を分けるか同居させるかはアーキテクトが決める」。Cron 用 Worker を分ける場合は、サイト Worker と D1 / KV のバインディングを両方に設定する必要がある。この判断は architect に引き継ぎ。
4. **wrangler.jsonc の `triggers.crons` の書き方**: 公式の Astro ガイドには記載なし。Cloudflare 公式の Cron 設定例で書式を確認する。
5. **ローカル検証の方法**: `wrangler dev` または Cloudflare Vite プラグインで `/cdn-cgi/handler/scheduled` に HTTP リクエストを送ると scheduled を手動実行できる、との記載(非公式要約)。実装時に確認する。
6. **Worker の制限との整合**: Free の 1 リクエスト CPU 10 ms、サブリクエスト 50。Astro のページ描画で CPU 上限を超えないかは実機で確認が必要(司令塔で frontend-pages と確認)。
