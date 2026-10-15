# WARDOGS RCON 調査

- 調査日: 2026-10-15
- 担当: api-research
- 関連: `docs/PLAN.md` 第 5 章 / `docs/LIVE.md` 4.5 / `docs/BOT.md`

表記の区別:
- **確定**: wardogs-wiki.com のパッチノート等、ゲームの運営情報として確認できたもの
- **未検証**: 非公式の資料(wardogs.tech、warcon、業者ページ)にのみ記載があり、実サーバーで確認していないもの
- **推測**: 資料に明記がなく、調査者が推し量ったもの(断定には使わない)

重要な前提: 調査時点で、開発元(BULKHEAD)による RCON の公式開発者ドキュメントは見つかっていない(「公式ドキュメントなし」と述べる二次資料がある)。wardogs-wiki.com の運営主体は未確認のため「wiki」と呼び、公式とは断定しない。したがって API 詳細の大半は **未検証** である。

## 0. 結論

| 項目 | 可否 | 確度 | 備考 |
|---|---|---|---|
| 方式 | HTTP API(`/v1`、JSON)。Source RCON(TCP)ではない | 未検証(非公式資料が一致) | wiki は「RCON」の存在と AllowedHosts のみ確定 |
| 接続中人数・最大人数の取得 | できる(`GET /v1/status` の `players.current/max`) | 未検証 | `players.max` は MaxPlayers から予約枠を引いた値 |
| 接続中プレイヤー名の取得 | できる(`GET /v1/players`。`name`, `steamId`, `faction`, `kills`, `deaths`, `cash`, `pingMs`) | 未検証 | |
| 現在マップ・試合情報 | できる(`/v1/status`) | 未検証 | |
| 接続/切断ログの取得 | 履歴は取れない見込み。一覧のポーリング差分で代替 | 推測 | 監査ログ `/v1/audit` は管理操作の記録で、接続ログではない可能性が高い |
| kick / ban / unban | できる | 未検証 | ban は対象がオンラインである必要あり |
| ブロードキャスト / 個別メッセージ | できる(256 文字上限) | 長さ上限の存在は確定、256 は未検証 | |
| マップ変更・試合終了・試合再開 | できる | 未検証 | |
| 再起動 / シャットダウン | API は見つからず。日次の予約再起動(UTC)のみ設定可 | 日次再起動は確定、API 無しは未検証 | `match/restart` は試合の再開でプロセス再起動ではない |
| 設定値の変更 | できる(`ServerSettings.ini` 全体を取得/検証/置換) | 未検証 | |
| 読み取り専用トークン | **ない**(同一パスワードで読み書き全権) | 未検証(非公式 2 件が一致) | 第 3 章 |
| 接続元の制限 | AllowedHosts で制限できる | 確定(値の書式は未確認) | |
| RCON 連携の Discord Bot | 第三者の OSS が 2 件ある(RCON HTTP API を読み取り専用でポーリングし、状態パネルを編集し続ける方式) | README のみ確認、未検証 | 一覧は `docs/research/discord-bot-capabilities.md` 5.3。統計 Bot(WD Stats)は RCON 不使用 |

## 1. 方式と認証

| 項目 | 内容 | 確度 |
|---|---|---|
| プロトコル | プレーン HTTP/1.1、JSON、`/v1` プレフィックス。HTTPS は拒否される | 未検証(wardogs.tech、warcon docs、業者ページ) |
| ポート | 既定 7776(`[/Script/WDRCON.WDRCONSettings] Port` または起動引数 `-RCONPort=`) | 未検証 |
| 有効化 | `ServerSettings.ini` の `[/Script/WDRCON.WDRCONSettings]` で `bEnabled`。既定は無効とする記述あり | 未検証 |
| バインド | `BindAddress` 既定 `127.0.0.1`(ループバックのみ)。`0.0.0.0` は TLS と `PasswordHash` が必要とされる | 未検証 |
| 認証 | 全リクエストに `Authorization: Bearer <RCON パスワード>`。ログイン手順なし。`GET /v1/status` が疎通確認に使える | 未検証 |
| パスワード | `Password`(平文)または `PasswordHash`(`WardogsServer -GenerateRCONHash=<pw>` で生成)。空なら `Saved/RCON/ADMIN-PASSWORD.txt` に自動生成 | 未検証 |
| 暗号化 | なし(平文 HTTP)。外部に出す場合は VPN / SSH トンネル / TLS 終端プロキシ経由が推奨されている | 未検証 |
| AllowedHosts / AllowedOrigins | 設定キーとして存在。接続を許可するホストを制限できる(0.1.2 で追加) | AllowedHosts の存在は確定。書式(IP かホスト名か)と AllowedOrigins の役割は未確認 |
| ビルド差 | `GET /v1/capabilities` が実サーバーの提供ルートを返す。2026-09-14 のビルド(CL-501228)で書き込み系ルートが廃止され設定ドキュメント経由に移行したとの記載 | 未検証 |
| 応答の詳細度 | 0.1.2 で既定が Full から Standard に変更。設定応答はサーバー内部情報を出さなくなった | 確定(wiki)。設定キー名は未確認 |

注意: 本番サーバーが「ループバック限定」「AllowedHosts で自宅 PC / VPS の IP のみ許可」「運用上 RCON ポートを外部に出せない」のどれかは、この調査では判断できない(第 7 章)。

## 2. コマンド一覧

出典の略称(詳細は第 6 章)。全て **未検証**(非公式)。実サーバーで `GET /v1/capabilities` を叩いて確認すること。

- A: wardogs.tech/rcon-reference
- B: warcon の docs/wardogs-api.md
- C: 業者ヘルプ(コンソールコマンド記事。本文は 403 で取得できず、検索結果の要約のみ)
- D: 第三者ガイド(wardogservers.com)

### 2.1 読み取り系(HTTP)

| エンドポイント | 用途 | 戻り値(JSON) | 出典 | 確度 |
|---|---|---|---|---|
| `GET /v1/status` | サーバー状態・人数 | `serverName, map, experiences[], lighting, alternator, scoreTick, players:{current,max}, factionScores[], rotation:{nowIndex,nextIndex}`(ビルドにより `scoreCap`, `matchSeconds` なし) | A, B | 未検証 |
| `GET /v1/players` | 接続中プレイヤー | `{players:[{name,steamId,faction,kills,deaths,cash,pingMs}],count}` | A, B | 未検証 |
| `GET /v1/health` | 稼働確認 | `{status, uptimeSeconds, connections:{active}, gameThreadQueue}` | A, B | 未検証 |
| `GET /v1/capabilities` | 提供ルート・上限の一覧 | `{apiVersion, build, auth, limits, config, routes[]}` | A, B | 未検証 |
| `GET /v1/bans` | BAN 一覧 | `{bans:[{steamId,bannedAtUtc,bannedBy,reason}],count}` | A, B | 未検証 |
| `GET /v1/reserved-slots` | 予約枠一覧 | `{reservedSlots:[steamId],count}` | A, B | 未検証 |
| `GET /v1/rotation` | マップローテーション | `{enabled,mode,entries[]}` | A, B | 未検証 |
| `GET /v1/catalog/maps` ほか | マップ、ライティング、モードの一覧 | `{maps:[{id,displayName}]}` 等 | A, B | 未検証 |
| `GET /v1/audit?limit=N` | 管理操作の監査ログ(N は 500 以下) | `{entries:[{timestampUtc,peer,sessionId,event,detail}],count}` | A, B | 未検証 |
| `GET /v1/config` | `ServerSettings.ini` 全体と revision | `{revision,writable,text,sections[],warnings[]}` + `ETag` | A, B | 未検証 |
| `GET /v1/server-id` | サーバー識別子 | `{serverId}` | A, B | 未検証 |

### 2.2 書き込み系(HTTP)

| エンドポイント | 用途 | リクエスト | 出典 | 確度 |
|---|---|---|---|---|
| `POST /v1/players/{steamId}/kick` | kick | `{reason}` | A, B | 未検証 |
| `POST /v1/players/{steamId}/kill` | キャラクターを倒す | `{message}` | A, B | 未検証 |
| `POST /v1/players/{steamId}/message` | 個別メッセージ | `{message}`(256 文字まで) | A, B | 未検証 |
| `PATCH /v1/players/{steamId}` | 陣営変更 | `{faction}`(ビルド依存) | A, B | 未検証 |
| `POST /v1/broadcast` | 全体メッセージ | `{message}`(256 文字まで) | A, B | 未検証 |
| `POST /v1/bans` | BAN | `{steamId, reason?}`(対象がオンラインである必要) | A, B | 未検証 |
| `DELETE /v1/bans/{steamId}` | BAN 解除 | なし | A, B | 未検証 |
| `POST /v1/match/map` | マップ変更 | `{map, experiences?, lighting?, zoneAlternator?}` | A, B | 未検証 |
| `POST /v1/match/end` | 試合終了(ローテーションが進む) | なし | A, B, C | 未検証 |
| `POST /v1/match/restart` | 試合の再開 | なし | A, B | 未検証 |
| `PUT /v1/world/lighting` | ライティング変更 | `{lighting}` | A, B | 未検証 |
| `POST /v1/config/validate` | 設定の検証(ドライラン) | text/plain の ini | A, B | 未検証 |
| `PUT /v1/config` | 設定の置換 | text/plain、`If-Match: "<revision>"`、`?force=true&fullApply=true` | A, B | 未検証 |
| ローテーション編集、予約枠、スコア設定、スポンサー画像 | 旧ビルドのみ個別ルート。新ビルドは設定ドキュメント経由 | | A, B | 未検証 |

存在が確認できなかったもの: プロセスの再起動 / シャットダウン API、ホワイトリスト、管理者アカウントの追加(権限はパスワード単一。予約枠は別機能)、サーバーログ取得(監査ログのみ)、チャット取得。

### 2.3 ゲーム内コンソールコマンド(参考)

検索結果の要約によれば、業者のヘルプ記事に次のコマンドが列挙されている(C。構文は未確認): `playerlist`, `msg`, `kick`, `kill`, `faction`, `banlist`, `ban`, `unban`, `changemap`, `restartmatch`, `endmatch`, `status`, `audit`, `health`, `help`。いずれも **未検証**。HTTP API とは別経路(ゲーム内や業者パネルのコンソール)と思われるが、戻り値の形式は不明(推測)。

### 2.4 キルフィード(WDServerFeed。サーバーからの通知)

設定 `[WDServerFeed] Url / Token` を入れると、ゲーム側が `Url + /api/ingest/events` に Bearer トークン付きで `killed` イベントを約 2 秒ごとにバッチ POST する(B)。接続/切断イベントは観測されていない(B は `killed` のみと記載)。**未検証**。

## 3. 読み取り専用運用の可否

- 読み取り専用トークン・ロールは**ない**。同一パスワードで読み書き全権(kick、ban、設定置換、試合終了まで)。非公式 2 件(wardogs.tech、第三者ガイド)が一致して記載。**未検証**だが、公式に分離機構があるという記載は見つかっていない。
- 回避策(本プロジェクトで採るかは未決定):
  1. 自前の読み取り専用プロキシ(GET `/v1/status`・`/v1/players` のみ中継)を自宅 PC / VPS に置き、スクリプトはそちらだけを叩く。RCON パスワードはプロキシ側にのみ置く。**推測**(実装は容易だが未検証)。
  2. AllowedHosts で接続元を自宅 PC / VPS に限定する(機能は確定、書式は未確認)。
  3. 第三者パネル(warcon の `viewer/operator/admin` ロール、BattleMetrics の操作別権限)を経由する。ただしパスワードを預ける形になる。
- 「人数・プレイヤー名の取得だけ」の用途でも、スクリプトが持つパスワードは書き込み権限を持つ。漏洩時は kick / ban / 設定置換が可能になる。パスワードは自宅 PC / VPS の環境変数のみに置き、Worker には渡さない。Worker へ POST するのは `/api/status` 用の別トークンのみにする。

## 4. 既存ツール

| ツール | 内容 | 対応操作 | URL | 備考 |
|---|---|---|---|---|
| warcon | 自前ホストの複数サーバー対応パネル(Bun + SvelteKit + Postgres/TimescaleDB、Docker Compose)。MIT(地図画像は別) | 状態、スコアボード、kick、ban、kill、whisper、陣営変更、broadcast、マップ変更、試合終了/再開、天候、ローテーション編集、予約枠、設定全体。ロール、監査、Discord Webhook、Prometheus | https://github.com/warcon-app/warcon / https://warcon.app/ | 非公式(BULKHEAD/Team17 と無関係と明記)。フォークが複数ある |
| Wardogs RCON Panel | 単一サーバー向けの自前ホスト管理パネル | プレイヤー一覧、kick、ban、メッセージ、予約枠、設定ドラフト | https://github.com/TreasureGooldove/Wardogs_RCON_PANEL | ライセンス未確認 |
| BattleMetrics | 有料の RCON 連携。操作ごとの権限があり、パスワードを共有せずスタッフに限定権限を渡せるとされる | | https://www.battlemetrics.com/rcon/wardogs | 本文は 403 で取得不可。検索結果の要約のみ。**未検証** |
| wardogs.tech 対話コンソール / OpenAPI | 非公式の API コンソールと `openapi.json` | 全ルート | https://wardogs.tech/rcon-api | 非公式 |
| WD Stats | 統計の Discord Bot。RCON 不使用 | | https://discordbotlist.com/bots/wardogs-stats-bot/upvote | 本件には不向き |
| RCON 連携の Discord 状態 Bot(OSS) | `nobodys-tools/wardogs-discord-status`、`unn-corp/sgtpuppers`。RCON HTTP API の読み取り系(`/v1/status` 等)をポーリングし、1 枚のパネルを編集し続ける常駐プロセス | 人数、マップ、スコア、プレイヤー一覧の表示(書き込み操作なし) | `docs/research/discord-bot-capabilities.md` 5.3 参照 | README のみ確認、**未検証** |
| 業者の RCON コンソール | Web で RCON を中継 | 状態、プレイヤー、broadcast、whisper、kill、kick、ban、restart(試合)、end match | https://xgamingserver.com/tools/wardogs/rcon-console | 業者ページ、**未検証**。warcon の仕様に基づくと記載。パスワードは保存しないと主張 |

GitHub / npm / pip の網羅検索はしていない(WebSearch の範囲のみ)。WARDOGS 専用の RCON ライブラリは検索結果に出なかった。HTTP API なので専用ライブラリは不要で `fetch` で足りる(推測)。

## 5. 制約・ログ

| 項目 | 内容 | 確度 |
|---|---|---|
| レート制限 | クライアント IP あたり 600 リクエスト/分、超過で 429 + `Retry-After`。リクエスト本文は 64 KiB まで(B)。A は「公開された制限値なし、数秒間隔以上を推奨」 | 未検証(資料間で表現が異なる) |
| 注意 | プロキシ経由だと全クライアントが `127.0.0.1` に見え、上限を共有する構成がある(B) | 未検証 |
| 本プロジェクトの負荷 | 30〜60 秒に 1〜2 回の GET なら上限に遠く及ばない | 推測 |
| 同時接続数 | 明記なし。`/v1/health` に `connections.active` あり | 未検証 |
| メッセージ長 | broadcast / whisper に上限あり(0.1.2)。256 文字(B) | 上限の存在は確定、値は未検証 |
| AllowedHosts | 接続元の制限(0.1.2) | 確定(書式は未確認) |
| 日次再起動 | UTC で時刻指定できる(0.1.2)。`uptimeSeconds` で再起動を検知できる | 設定の存在は確定、検知方法は未検証 |
| ログ | 管理操作の監査ログ `/v1/audit` のみ確認。イベント名はモックと実ビルドで異なる(`ACCEPT/AUTH_OK/AUTH_FAIL/REJECT/COMMAND/CLOSE` と `AUTH_OK/HTTP`) | 未検証 |
| 接続/切断ログ | ログファイルの場所・形式は資料なし。プレイヤー一覧のポーリング差分で代替する必要がある | 未確認 |
| ID の永続性 | `matchId` / `serverId` は起動ごとに変わる(B) | 未検証 |

## 6. 出典 URL 一覧(確認日 2026-10-15)

| URL | 区分 | 取得状況 |
|---|---|---|
| https://wardogs-wiki.com/guides/community-servers-guide/ | wiki(運営主体は未確認) | 取得済み。RCON は 0.1.2 の要約のみ |
| https://wardogs-wiki.com/patch-notes/patch-0-1-2/ | wiki | 取得済み。AllowedHosts、長さ上限、応答詳細度、日次再起動 |
| https://supercraft.host/wiki/wardogs/community_servers/ | 業者ページ(未検証扱い) | タイムアウトで取得できず |
| https://xgamingserver.com/tools/wardogs/rcon-console | 業者ページ(未検証扱い) | 取得済み。HTTP API、ポート 7776、warcon を根拠とする記載 |
| https://wardogs.tech/rcon-reference | 非公式リファレンス | 取得済み |
| https://wardogs.tech/rcon-api | 非公式コンソール(v0.39、2026-09-21 更新) | 取得済み(概要のみ) |
| https://github.com/warcon-app/warcon/blob/main/docs/wardogs-api.md | 非公式(リバースエンジニアリング) | 取得済み |
| https://github.com/warcon-app/warcon | 非公式ツール | 取得済み(README の前半) |
| https://github.com/TreasureGooldove/Wardogs_RCON_PANEL/releases/tag/v0.1.0 | 非公式ツール | 取得済み |
| https://help.bisecthosting.com/hc/en-us/articles/55701694877339-How-to-Use-Console-Commands-on-a-WARDOGS-Server | 業者ページ(未検証扱い) | 403。検索結果の要約のみ |
| https://help.bisecthosting.com/hc/en-us/articles/55591648639131-How-to-Access-the-WARDOGS-RCON-Panel-on-a-WARDOGS-Server | 業者ページ(未検証扱い) | 403。未取得 |
| https://wardogservers.com/guides/wardogs-rcon-and-admin-tools | 第三者ガイド(未検証扱い) | 取得済み。「公式開発者ドキュメントはまだない」と記載 |
| https://www.battlemetrics.com/rcon/wardogs | 第三者サービス | 403。検索結果の要約のみ |
| https://steamcommunity.com/app/1867240/discussions/0/588435120315339028/ | Steam コミュニティ | 取得済み。RCON に関する開発側の回答なし |
| https://warcon.app/ | 非公式ツール | 検索結果で存在のみ確認 |
| https://x.com/WARDOGS/status/2093730167688450150 | 開発元の告知 | 本文は未取得(Steam スレッドが引用) |

## 7. 要確認事項(推測で断定しないもの)

1. **実サーバーでの検証**: 本番で `GET /v1/capabilities` を取得し、実在するルートと `limits` を確認する。非公式資料と実装が異なる可能性がある。ビルド更新で変わる点にも注意(2026-09-14 のビルドでルート廃止との記載)。
2. **到達性**: 既定 `BindAddress=127.0.0.1` だと自宅 PC / VPS から直接叩けない。RCON ポートを外部に開放できるか、AllowedHosts に接続元 IP を登録できるか、パネル経由のみか。サーバーを預けている先への確認が必要(運営の作業)。
3. **AllowedHosts の書式**(IP / ホスト名 / CIDR)と AllowedOrigins との違い。
4. **読み取り専用の権限**: 公式に分離する手段は確認できていない。別権限のアカウントを出せるかも未確認。
5. **接続/切断の取得方法**: 履歴 API が無いため、ポーリング差分で検出する前提でよいか。ログファイルを読めるかは未確認。
6. **コンソールコマンド**(`playerlist` 等)の構文と戻り値形式。HTTP API とは別経路かどうか。
7. **公式ドキュメントと規約**: BULKHEAD / Team17 の公式な RCON ドキュメントや、RCON の外部利用に関する規約(`docs/research/team17-wardogs-terms.md` の範囲)は確認できていない。開発元の X 投稿と Steam の告知を一次で確認したい。
8. wiki が「RCON」と呼ぶ機能が、ここで整理した HTTP API と同一であることの一次確認。

## 8. 本プロジェクトでの用途(まとめ)

- **人数・接続中プレイヤー名**: 自宅 PC / VPS 上のスクリプトが 30〜60 秒間隔で `GET /v1/status` と `GET /v1/players` を取得し、必要な項目(人数、最大人数、マップ名、プレイヤー名)だけに絞って Worker の `/api/status` に POST する。Worker から RCON を直接叩かない(`docs/PLAN.md` と同じ方針)。Steam ID は公開しない扱いを推奨(推測。方針は別途決定)。
- **Bot から運営が実行したくなりそうな操作**(いずれも書き込み権限のパスワードが必要):

| 操作 | API 上の可否 | 確度 |
|---|---|---|
| kick | できる | 未検証 |
| ban / unban | できる(ban は対象がオンライン) | 未検証 |
| メッセージ(全体/個別) | できる(256 文字) | 未検証 |
| マップ変更 / 試合終了 | できる | 未検証 |
| 再起動 | 試合再開のみ。プロセス再起動 API は見つからず | 未検証 |
| シャットダウン | 見つからず | 未検証 |

  読み取り専用の分離ができないため(第 3 章)、Bot や Worker に書き込み権限のパスワードを持たせる設計は避け、書き込み操作は Bot から実行しない運用を推奨する(推測。判断は司令塔)。
