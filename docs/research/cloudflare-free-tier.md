# Cloudflare 無料枠の調査(第 1 リリース向け)

## 確認日

2026-10-10

## 出典 URL

- Workers の制限: https://developers.cloudflare.com/workers/platform/limits/
- Cron Triggers: https://developers.cloudflare.com/workers/configuration/cron-triggers/
- KV の制限: https://developers.cloudflare.com/kv/platform/limits/
- KV の料金・Free 上限表: https://developers.cloudflare.com/kv/platform/pricing/
- D1 の料金・Free 上限表: https://developers.cloudflare.com/d1/platform/pricing/
- D1 の制限: https://developers.cloudflare.com/d1/platform/limits/
- Turnstile のプラン: https://developers.cloudflare.com/turnstile/plans/
- Rate Limiting バインディング: https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/
- Rate Limiting ルール(ゾーン単位、参考): https://developers.cloudflare.com/waf/rate-limiting-rules/
- 補足(検索結果の要約のみで原文未確認): Turnstile の旧ウィジェット解説ページは「10 widgets」と記載しているとの検索要約あり。プランページは「20」。

## 確定事項

### Workers Free
- 1 日あたりリクエスト数: 100,000 リクエスト/日。UTC 0 時にリセット。超過時は Error 1027。
- CPU 時間: HTTP リクエストあたり 10 ms(Paid は 5 分、既定 30 秒)。
- サブリクエスト: 1 リクエストあたり 50(Paid は 10,000)。
- Cron Triggers: Free でも利用可。アカウントあたり 5 個まで(Paid は 250)。Cron 実行の CPU 時間は 10 ms。
- Cron は UTC 基準。Scheduled ハンドラーの最大 wall time は 15 分。

### KV Free
- 読み取り(Keys read): 100,000 回/日
- 書き込み(Keys written): 1,000 回/日(異なるキー)。同じキーへの書き込みは 1 秒に 1 回
- 削除(Keys deleted): 1,000 回/日
- 一覧(List requests): 1,000 回/日
- ストレージ: 1 GB/アカウント(1 GB/ネームスペース)
- 値のサイズ: 25 MiB
- 上限は毎日 00:00 UTC にリセット。超過した同種の操作は失敗する

### D1 Free
- 行の読み取り: 5,000,000 行/日
- 行の書き込み: 100,000 行/日
- ストレージ: 5 GB(アカウント合計)
- データベース数: 10(アカウント)
- データベース 1 つあたり最大 500 MB
- Worker 呼び出し 1 回あたりのクエリ数: 50(Paid は 1,000)
- Time Travel の保持: 7 日(Paid は 30 日)
- 1 クエリの SQL 最大長 100 KB、バインドパラメータ 100 個、SQL 実行 30 秒

### Turnstile Free
- ウィジェット数: 1 アカウントあたり 20(Enterprise は無制限)
- ホスト名: ウィジェットあたり 10(Enterprise は 200)
- 検証(challenge / siteverify)の回数: Free でも無制限と表に記載(数値上限の記載なし)

### Rate Limiting バインディング(Workers)
- 設定: wrangler の `ratelimits` で `name`、`namespace_id`(正の整数を文字列で指定)、`simple.limit`、`simple.period` を定義。Wrangler 4.36.0 以降が必要
- `period` は 10 秒または 60 秒のみ
- `limit()` の `key` は任意の文字列。ユーザー ID や API キー等の安定した識別子を推奨。IP は非推奨の記載
- 精度: 「permissive, eventually consistent」。正確な会計用途には使わない。カウンターはロケーションごとにローカルで非同期更新される。超過が即時反映されない場合がある
- 同じ `namespace_id` を共有する Worker 間ではカウンターを共有

### ゾーン単位の Rate Limiting ルール(参考)
- Free は counting period・mitigation timeout ともに 10 秒、ルール数 1 個
- 利用できるフィールドは Path と Verified Bot のみ、カウント対象は IP

## 要確認事項

1. **Cron の最短実行間隔**: 公式の Cron 記載ページには最短間隔の明記がない。PLAN の 3 分間隔は Free 上限内と推定できるが、実機確認が必要。
2. **Rate Limiting バインディングの Free プラン可否**: 公式ページでは確認できず。検索要約では「追加料金なし」の記述のみ。Free アカウントでデプロイして確認が必要。
3. **Rate Limiting バインディングの精度と用途**: 「eventually consistent」のため、応募の「同一 IP 1 時間 3 回」を厳密に守る用途には弱い可能性。KV またはバインディングのどちらを使うかは architect の判断(司令塔で整理)。
4. **Turnstile ウィジェット上限の食い違い**: プランページは 20、旧解説は 10。ダッシュボードで実数を確認する。本サイトは 1 ウィジェットで足りる見込み。
5. **Turnstile の検証回数**: 公式表は無制限とするが、検索要約の第三者記述では「月 100 万回」とあり食い違う。公式表を優先するが、ダッシュボード側の表示で確認する。
6. **Workers の 100,000 リクエスト/日に Cron 実行が含まれるか**: 公式ページの記述からは判断できず。3 分間隔の Cron(1 日 480 回)が枠に影響するかを確認する。
7. **KV の 1,000 回/日の上限と PLAN の設計**: 書き込み・削除・一覧がそれぞれ 1,000 回/日。PLAN の「値が変化したときだけ書き込む」方針なら書き込みは収まる見込みだが、削除 Cron や一覧操作の回数見積もりは architect が行う必要がある。
8. **Workers 無料枠の 1 日 100,000 リクエストと応募フォームの Bot 攻撃**: 大量リクエストで枠を使い切ると全サイトが停止する。Turnstile とレート制限より前段の対策は司令塔で判断(引き継ぎ)。

## 第 1 リリースへの影響(要点)

- 応募フォームは Turnstile → レート制限 → D1 保存の順。D1 の書き込み上限(10 万行/日)は十分。
- 稼働フラグは KV。読み取り 10 万回/日の範囲内。
- Cron(第 2 リリース)は 1 アカウント 5 個まで。配信中判定と応募データ削除で 2 個程度なら収まる。
