# wardogs-ops 企画メモ(正本)

作成日: 2026-10-15 / ユーザー決定に基づく。構成の詳細は `docs/ARCHITECTURE.md`(architect が起草)。

## 目的

運営者が Web ブラウザから WARDOGS コミュニティサーバーの状態を見て、RCON 操作(kick / ban / broadcast / マップ変更 など)を安全に実行できるようにする。Discord ボット(別リポジトリ)や公開サイトとは分離する。

## 画面(初期スコープ、3〜4 画面)

1. 状態: サーバー名、マップ、人数(現在 / 最大)、陣営スコア、ローテーション。数十秒ごとに自動更新
2. プレイヤー: 接続中一覧(名前、陣営、K/D、ping)。行ごとに kick / message / ban
3. BAN 一覧: 一覧と解除
4. 操作ログ: D1 の監査ログ(誰が・いつ・何を・結果)

後回し: 設定(`ServerSettings.ini`)の閲覧・検証・置換、人数履歴グラフ、ローテーション編集。

## 構成(決定)

```
運営者ブラウザ ─▶ https://wardogs-ops.gmkz.jp(Cloudflare Access で保護)
                ─▶ Worker "wardogs-ops"(Astro SSR + React アイランド)
                     ├─ D1 "wardogs-ops-db": 監査ログ、人数スナップショット
                     └─ fetch(Access サービストークン)
                           ─▶ Cloudflare Tunnel(cloudflared、自宅 PC / VPS)
                                ─▶ 中継プロキシ(同じ機械。RCON パスワードはここだけ。許可ルートを列挙)
                                     ─▶ RCON HTTP API(AllowedHosts でこの機械だけ許可)
```

## 制約

- Workers から RCON へ直接接続しない
- RCON パスワードを Cloudflare に置かない
- 書き込み系の操作は中継プロキシ側の許可リストと、Worker 側の確認ダイアログ + 監査ログの両方を通す
- 無料枠内(Workers / D1 / Access / Tunnel)

## 要確認(設計時に一次資料で確定する)

- Cloudflare Tunnel + Access サービストークンを Workers からの fetch で使う手順と Free プランでの可否
- RCON の実在ルート(`GET /v1/capabilities`)と、ビルドによる書き込み系ルートの差
- AllowedHosts の書式と、サーバー提供元が RCON ポートを中継機から到達可能にできるか
