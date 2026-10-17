# QA レビュー: スコア記録 + キルフィード(観測モードと集計)

- 日付: 2026-10-17(JST)
- 対象: コミット f99adce(設計)、cf02b5e(スコア記録・観測モード)、f6b92b4(第 2 段階の正規化・保存・画面)。`git diff f0e2704..HEAD`(71 ファイル)
- 方針: 修正は行わず報告のみ。セキュリティ・設計整合の指摘は司令塔が Opus に二次レビューを依頼する。

## 実施した確認

| 項目 | 結果 |
|---|---|
| `pnpm test` | 19 ファイル・410 件すべて成功 |
| `pnpm check` | 0 エラー・0 警告・0 ヒント |
| `pnpm build` | 成功。`dist/client` に `instance_key`・`token_hash`・`rcon_password_enc`・`wof1.<数字>`・17 桁の数字・`Bearer ` は無い。外部 URL は React の定数(`react.dev`、`w3.org`)のみ |
| 非公開情報の grep | IPv4 アドレス、招待リンク、メールアドレス実値は無し(`docs/research` の Cloudflare の公開レンジの記述のみ)。`gmkz` は作者の環境の例として `wrangler.jsonc`・`src/types/env.ts`・`scripts/deploy-env.mjs`・README に残る(`CLAUDE.md` が許容する範囲) |
| ダミー値 | テストの Steam ID は `7656119000…`(アカウント番号が負になり実在しない)と `0000…` 形式。名前は `TestPlayerA` 等、武器は `Test Rifle` 等で実在しそうなものは無い |
| 受信エンドポイントの実機確認 | 別の `--persist-to`(作業用ディレクトリ)と別ポートで `wrangler dev` を起動して確認し、終了後に停止。ポートが空いたことを確認済み。下の表 |
| 文言のカタログ外直書き | `src/**/*.{ts,tsx,astro}`(テスト・`ja.ts` を除く)の非コメント部分に日本語・英語の画面文言の直書きは無し。日時は `Intl` に locale とタイムゾーンを渡している(JST 固定は無し) |
| 「スポンサー」等の表記 | リポジトリ内で `.claude/`・`CLAUDE.md`・設計書・過去のレビューにのみ存在(禁止の指示としての記述)。画面・コード・README には無し |

受信エンドポイントの実機確認(管理者未登録の新しい D1 で実施。値はダミー):

| リクエスト | 結果 |
|---|---|
| `POST /api/ingest/events`(Authorization なし) | 401 `FEED_TOKEN_INVALID`、`WWW-Authenticate: Bearer`、`Cache-Control: no-store` |
| 形式は正しいが存在しないトークン | 401(同じ応答。行の有無を応答で区別できない) |
| `GET /api/ingest/events`(Cookie なし) | 405 `METHOD_NOT_ALLOWED` |
| `POST /api/ingest/events/`(末尾の `/`) | 401(正規化後に完全一致。トークン検査に進む) |
| `POST /API/ingest/events`、`POST //api/ingest/events` | 403(通常の CSRF 検査に落ちる。例外にならない) |
| `POST /api/ingest/events/x` | 403 `FORBIDDEN_ORIGIN`(前方一致で例外にならない) |
| `POST /api/servers/1/feed-token`(別オリジン) | 403 `FORBIDDEN_ORIGIN` |
| `GET /api/feed/raw?server=1`(未ログイン) | 503 `SETUP_REQUIRED`(管理者がいる環境では 401。middleware が全 `/api/*` を覆っている) |

## 重大

なし。

認証の迂回、秘密(トークン・パスワード・鍵・暗号文)の漏れ、非公開情報の混入、SQL インジェクション、書き込み操作の確認トークンの迂回は見つからなかった。確認した根拠:

- middleware の例外は `pathname === FEED_INGEST_PATH`(`src/middleware.ts` 79 行)の完全一致だけ。D1 の判定(不備なら 503)とセキュリティヘッダは通る。
- トークン検証(`src/lib/feed.ts` 169〜178 行)は、形式 → 主キーで 1 行 → SHA-256 同士を `timingSafeEqual` で比較(32 バイト固定長)。D1 にはハッシュだけ。行が無い場合も同じ回数だけハッシュを計算する。
- 発行・取り消し・設定変更はログイン必須(middleware)+ CSRF 検査 + `settings_audit_log`。`params_json` にトークンの値・ハッシュを入れていない(`feed.ts` 649〜650 行)。応答でトークンを返すのは `POST /feed-token` の 1 回だけ。
- キルの保存は `json_each(?3)` に JSON 文字列 1 つをバインドする(`store.ts` 199〜209 行・236 行)。値は SQL に連結されない。`WHERE` の組み立てにユーザー入力を連結している箇所は無い(`writeUpdates` の `sets` は固定の列名だけ)。
- `record_start` / `record_stop` は確認トークンの署名・セッション・action と params のハッシュ・`sv` / `sh` を検証してから動く(`actions.ts` 391〜413 行)。`nonce` は `settings_audit_log.confirm_nonce` の UNIQUE で 1 回限り。`record_stop` の batch は `server_id = ?` と `status = 'recording'` を条件にしており、別サーバーの試合 id にすり替えても動かない。
- 画面は名前・陣営名・武器名・本文を React の子要素(テキスト)として描画している。`dangerouslySetInnerHTML`・`innerHTML` は `src` に無い。`t()` の補間は 1 回の置換で、名前に `{key}` が含まれても再展開されない。

## 要修正

### M-1 README の 4.5 が実装と合っておらず、スコア記録の使い方が README に無い

- 場所: `README.md` 236〜262 行(4.5)
- 内容:
  1. 238 行が「キルフィードは **準備中** です。…キル数などの集計を追加する予定です」のまま。第 2 段階でキル数・ヘッドショット率・上位プレイヤー・武器・距離・キルログ・JSON 出力が実装済みで、画面(`killfeed.intro`)とも食い違う。
  2. 「受信した生データも保存する」(`rawEnabled`)のオフの案内が無い。設計(17.10.8)は「形式を確かめたらオフにして書き込みを約 2 万行/日節約」としており、設定タブには出ている。
  3. スコア記録(概要タブの「記録を開始」)の手順・自動で終わる条件・1 分ごとの記録(Cron)がどこにも書かれていない。4.5 は「スコア記録は受信の設定をしなくても使えます」と書くが、その使い方の節が無い。非エンジニアは機能の存在に気付けない。
  4. 新しい版へ更新した既存のパネルでは、マイグレーション 0003・0004 が未適用だと「設定の確認」画面でログインできなくなる(`probeD1` が表・列を参照する)。更新時にマイグレーションを適用する旨(6.5 への案内)が、更新の手順として書かれていない。
  5. 「注意(無料枠)」の数字(1 台 約 4.3 万/日、無料枠 10 万/日、UTC 0 時 = 日本時間 9 時)は正しい。ただしキルの 1 日の上限(サーバーごと 3,000 件・全体 8,000 件)を超えた分は保存されずに捨てられることが書かれていない(画面の「今日の受信」には出る)。
- 影響: 非エンジニアが機能を見つけられない・古い説明に混乱する。
- 提案: 4.5 の導入文を実装に合わせ、「4.6 スコア記録を使う」の節を足し、4.5 に `rawEnabled` のオフとキルの上限を足す。更新時の注意を 6.5 から参照する。

### M-2 JSON 出力の「時間帯別」が、記録中の試合では画面と終点がずれる

- 場所: `src/components/KillfeedPanel.tsx` 313〜324 行(画面の集計)と 331〜343 行(出力)、`src/components/lib/killstats.ts` 358〜373 行
- 内容: 画面は `summarizeOptionsFor(…, feed.updatedAt)`(最後に取得した時刻)を終点にするが、出力は `buildKillfeedExport` が `exportedAt`(押した時刻)を終点にして集計し直す。記録中の試合では、時間帯の棒の本数・幅(`chooseBucketMinutes`)が画面と出力で変わり得る。合計(キル数・ヘッドショット率・上位・武器・距離)は同じ。17.10.6 の「画面と JSON の数字が必ず一致する」に反する。
- 提案: 出力は画面で使っている `summary` をそのまま渡す(または画面と同じ終点を `BuildExportInput` に渡す)。

### M-3 記録の終了処理が 2 文に分かれており、`record_end` の監査が欠け得る

- 場所: `src/lib/recordings.ts` 322〜344 行(`endRecording`)
- 内容: `UPDATE … RETURNING`(状態を ended にする)と `INSERT INTO settings_audit_log … 'record_end'` が別々の文。2 文目が失敗すると、試合は終了済みなのに設定変更ログに `record_end` が残らない(Cron の呼び出しは例外を `INTERNAL` として数えるだけ)。さらに `pruneEndedRecordings` の例外も同じ呼び出しで伝わり、`ended: true` が数えられない。手動停止(`actions.ts` の `record_stop`)は 1 つの batch で原子的に行っているため、扱いが揃っていない。17.3 の 4 は「行が返ったときだけ `record_end`」としており、二重実行では問題ないが、途中失敗には弱い。
- 影響: 発生は D1 の一時的な失敗に限られ頻度は低い。監査の欠落は静かに起きる。
- 提案: `INSERT INTO settings_audit_log … SELECT … WHERE EXISTS (SELECT 1 FROM match_recordings WHERE id = ? AND status = 'ended' AND ended_at = ?)` を `UPDATE` と同じ `db.batch()` に入れる(クエリ数は増えない)。`pruneEndedRecordings` の失敗は `record_stop` と同じく握りつぶして `ended: true` を数える。

### M-4 記録の開始・停止の失敗が監査に残らない(設計どおりだが QA 項目と食い違う)

- 場所: `src/lib/actions.ts` 391〜500 行、設計は `docs/ARCHITECTURE.md` 17.2
- 内容: QA の確認項目は「失敗を含め全件が `audit_log` に残る」。`record_start` / `record_stop` は、RCON の失敗・`RECORDING_*`・トークンの検証失敗を**記録しない**設計(ゲームに影響せず、結果不明の状態が無いため)。成功と自動終了は `settings_audit_log` に残る。
- 影響: 他の書き込み操作(kick 等)と扱いが異なる。「誰が開始を試みて拒否されたか」は追えない。ゲームサーバーには何も書かないので危険は小さい。
- 提案: 現状維持で良いが、17.2 と README の「操作ログ」の説明に「記録の開始・停止は成功したものだけが『設定変更』に残る」と一文足す。または司令塔が方針を決める。

## 提案

### P-1 受信のログ量(`src/lib/feed.ts` 356 行)

`stored` / `empty` / `raw_disabled` 以外は毎回 `console.log` する。`disabled`(保存を止めたがゲームは送り続ける)、`daily_limit`、`FEED_TOKEN_INVALID`、`RATE_LIMITED` は約 2 秒ごと(最大 4.3 万行/日)出得る。Workers Logs は無料枠に上限があり、観測が目的の機能が他のログを押し出す。同じ結果の連続は 1 分に 1 行にまとめる(`flushStatus` の間引きと同じ仕組み)ことを検討。

### P-2 受信用トークンの検証キャッシュが、存在しない ServerId の連打で入れ替わる(`feed.ts` 124〜161 行)

`MAX_CACHE`(= 台数上限 × 3)を超える種類の ServerId を送られると、正規のサーバーのキャッシュが追い出され、正規の受信ごとに D1 を 1 回読む。害は読み取りが増えるだけ(桁違いに小さい)。「行が無い」ことを覚えるエントリは別の小さな上限にする、で足りる。

### P-3 サーバーの有効・無効の変更で受信の検証キャッシュを捨てていない(`src/lib/servers.ts`)

`deleteServer` は `invalidateFeedToken` を呼ぶが(775 行)、`updateServer` は呼ばない。無効にしても同じ isolate が最大 60 秒は保存を続ける。他の isolate は元から最大 60 秒遅れるため実害は小さいが、`enabled` の変更時だけでも捨てると整合する。

### P-4 受信の 500 後の再送で生データが重複する(`feed.ts` 431〜459 行)

生データの INSERT が成功した後にキルの INSERT が失敗すると 500 を返す。ゲームが再送した場合、生データが 2 行になり、日次の件数も二重に数える。生データとキルを同じ `db.batch()` にするか、キルの失敗では 204 を返して `dropped` に数える方法がある。

### P-5 試合の開始直後は陣営の観測が最大 30 秒遅れる(`src/lib/killfeed/store.ts` 131〜152 行)

記録外のとき `roster: null` を 30 秒キャッシュするため、`record_start` 直後の 30 秒に届いたキルは陣営が「?」になる。`record_start` / 終了時に `rosterCache` を捨てる(`invalidate` を足す)と解消する。また、陣営は「受信時の 3 分以内の観測」で、チーム移動を反映しないことが画面の注記にある(`killfeed.notes.faction`)。

### P-6 CPU 10 ms の余裕が未測定(`src/lib/killfeed/normalize.ts` 349〜364 行)

100 イベント × 約 20 項目 × 平均数個の候補 × `getPath`(`split`)で、1 バッチ最大で数千回の候補照合と 64 KiB の 1 文字ずつの走査(`quoteBigIntegers`)を行う。設計は 1〜2 ms の見込みだが、本番の実測(C-27)まで確定できない。無料プランの CPU 上限は 10 ms なので、超える場合に備えて候補のパスを事前に分割しておく(`split` を初期化時に 1 回にする)と安全。

### P-7 キルの 1 日の上限が小さく、混んだサーバーでは夜に止まり得る(`feed.ts` 446〜449 行、`store.ts` 178〜197 行)

サーバーごと 3,000 キル/日を超えると、バッチ単位で全部捨てる(残りの枠に収まる分も捨てる)。画面の「今日の受信」に捨てた数は出るが、README と設定タブの注意には無い(M-1)。リセットは UTC 0 時 = 日本時間 9 時。D1 の書き込み枠(10 万行/日)から決めた値であり、変える場合は 17.10.8 の見積りを更新する。

### P-8 色以外の区別と小さな操作対象(375px)

- `FactionBadge`(`src/components/FactionBadge.tsx` 28 行)は先頭 2 文字で区別するが、陣営名の先頭が同じ(例「US Army」「US Marines」)だと色だけになる。全体の名前は `title` と読み上げ用の文字にあるが、視覚では区別できない。陣営ごとに印の形(●■▲)を足すか、2 文字目以降を変える工夫を検討。
- `KillTimelineChart` の棒は最大 36 本で、375px では 1 本の幅が約 8px。クリック領域(`.kt-hit`)が細く、指で押しにくい。表(折りたたみ)があるので機能は失われないが、幅が狭いときは棒の数を減らす(幅を広げる)か、選択を表の行からも行えるようにする。
- 時間帯の目盛りは時刻(時:分)だけで、記録外(7 日分)のように日をまたぐ範囲では日付が分からない。バケット幅が 1 日以上になる範囲では日付も出す。

### P-9 テキストの残骸・小さな整合

- `src/i18n/ja.ts` 205・206・331 行の `killfeed.comingSoon`・`killfeed.why`・`feed.raw.observation` はどこからも参照されていない(0 件)。205・331 行は「集計は準備中です」の古い文言。削除する。
- `docs/API_TEST.md` 285 行の単体テスト件数(16 ファイル・159 件)は第 1 段階時点の値で、現在は 19 ファイル・410 件。7.6 で第 2 段階の件数を足す。
- Cron は記録中が 0 件でも毎分 `{ kind: 'cron', … }` を `console.log` する(`cron.ts` 214・285 行)。1,440 行/日で小さいが、0 件のときは出さないと Workers Logs が読みやすい。

## 確認したが問題なしの項目(根拠つき)

| 観点 | 結果 |
|---|---|
| middleware の例外 | パスの完全一致のみ。末尾 `/` のみ許容、大文字小文字・`//`・前方一致は通常の `/api/*` 扱い(実機で確認) |
| 4xx の条件 | メソッド → D1 → トークン形式 → 行・ハッシュ → レート → Content-Type → サイズ → JSON の順(`feed.ts` 366〜407 行)。設計 17.6 と一致。空バッチは 204 で D1 に書かない(受信の状況は除く) |
| 本文サイズ | `Content-Length` と実読み取りの両方で 64 KiB(`readLimited` が超えた時点で中止)。トークン不一致でも本文は上限まで読み捨てる |
| レート制限 | トークン検証の後で数える(誤った送信で正規の枠を使わせない)。isolate 内の固定窓なので上限は目安 |
| ログへの漏れ | `console.*` は `src` に 10 箇所。出すのはエラー名・コード・件数・サーバー番号のみ。トークン・本文・Steam ID・名前・Authorization は出ていない。Cron は件数とコードのみ |
| エラー応答 | `jsonError` のメッセージは固定。D1 の例外文言は外に出さない(`uniqueViolation` は内部判定のみ) |
| Cron の二重実行 | サンプルは主キー + `EXISTS(… status = 'recording')`、終了は `status = 'recording'` 条件の UPDATE。`record_end` は行が返ったときだけ |
| 記録が無いとき | `rows.length === 0` なら RCON も `getKeys` も呼ばない(D1 の読み取り 1 回)。毎時 17 分だけ掃除 |
| 終了条件の優先順位 | サーバー不在 → 3 時間 → status 失敗(何もしない)→ マップ変化(サンプルは保存しない)→ players → サンプル → 上限 → 人数 0。設計 17.3 と一致 |
| D1 クエリ数 | 一覧 1 + 鍵 0〜1 + 1 台あたり最大 5(サンプル 1、`writeUpdates` 1、終了 3)× 8 + 掃除 1 batch = 最大でも約 43。上限 50 の内側 |
| `roster_json` | サンプルと同じ INSERT に載る(クエリ増なし)。名前は入れず、最大 128 人・Steam ID は 17 桁のみ |
| 16 桁以上の整数 | 文字列の内外・エスケープを追う走査で、引用符の無い 16 桁以上の整数だけを文字列化(小数・指数・負数・先頭 0 は対象外)。保存する本文は受けた文字列のまま。Steam ID は 17 桁のパターンに合うものだけ通る |
| 対応表 | `src/lib/killfeed/fields.ts` の 1 か所。`normalize.ts` / `store.ts` / 画面に項目名の直書きは無い(`envelopeOf` も同じ表を参照)。読めない項目は検証を通らず `null`。種類が無いとき被害者が読める場合だけキルとみなす |
| `teamkill` | 保存せず読み取り時に判定。自殺でなく、両者の陣営が分かり、かつ出所(`event` / `roster`)が同じときだけ true / false。異なる出所なら null |
| トリガー | `trg_match_recordings_delete_kills` は `server_id` と `recording_id = OLD.id` の両方で絞る。`match_recordings.id` は AUTOINCREMENT のため再利用されない。`trg_servers_delete_unrecorded_kills` は `recording_id = 0` のみ。`servers.id` も AUTOINCREMENT |
| 差分取得 | `useAutoRefresh` が `document.visibilityState === 'hidden'` の間は呼ばず、`max(sec, POLL_MIN_INTERVAL_SEC)` 秒より短くしない。キルの差分は `KILLFEED_POLL_SEC` = 30 秒、推移は 60 秒。終了した試合は 1 回だけ取得 |
| 集計の定義 | `killstats.ts` の `summarizeKills` が 17.10.6 の表と一致(キル・デス・自殺・ヘッドショット率・最長〔同値は先のもの〕・関わったプレイヤー〔Steam ID のみ〕・チームキル〔null の件数も別に出す〕・距離の階級〔下限を含む〕)。集計は絞り込み前の全件 |
| トークンの表示 | 発行の応答を React の状態(メモリ)にだけ持ち、サーバー切り替えで捨てる。`localStorage` 等には保存しない。コンソール・ログに出さない |
| 429 / 4xx の再送 | 上限・無効はすべて 204(ゲームの再送を増やさない) |
| Cookie / 認証 | 今回の差分は既存の仕組みを変えていない。全 `/api/*`(例外 1 つを除く)が middleware で 401 になることを実機で確認 |

## 未確認(司令塔・本番での確認が必要)

- 本番の D1 でのトリガー作成(`CREATE TRIGGER … BEGIN … END;`)と、トリガー内の削除行数の書き込み枠への計上(C-26)。
- 本番の Cron が Workers Builds / Deploy ボタンの経由で起動すること(C-10、C-22)。
- 受信 1 件の CPU 時間(C-27、P-6)。
- 実際のゲームサーバーが送る本文の項目名・Steam ID の型・距離の単位(K-1、K-9〜K-14)。対応表の候補はすべて推測のため、観測後に先頭へ実際のキーを足す必要がある。
- Workers Logs の invocation ログが `Authorization` ヘッダを記録するか(トークンは URL ではなくヘッダで送られる。観測モードを有効にしてから、ダッシュボードのログに値が出ないことを確認する)。
