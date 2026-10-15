# Discord ボットで「できること」の調査(一次資料ベース)

調査日: 2026-10-15 / 担当: api-research / 関連: `docs/BOT.md`(設計書)、`docs/PLAN.md` 5〜6 章、`docs/LIVE.md`、`docs/ARCHITECTURE.md`

> 本書は「Discord の仕様として何が可能か」の整理であり、`docs/BOT.md` の設計の再提案ではない。非公開情報(業者名・リージョン・サーバー ID・招待リンク・ギルド ID・審査基準)は書かない。
> 確度の表記: **確定(一次資料)** = 下記の公式ドキュメントのソース本文で確認 / **未検証** = 一次資料に記述が無く実機でも試していない / **推測** = 状況証拠からの見立て。

一次資料の取り方: Discord の公式ドキュメントは 2026 年時点で `https://docs.discord.com/developers/...` に移転している(旧 `discord.com/developers/docs/...` は 301 で転送)。本文は公式リポジトリ `discord/discord-api-docs` の `developers/**/*.mdx`(2026-10-15 時点の main)を直接読んだ。Cloudflare は公式リポジトリ `cloudflare/cloudflare-docs` の `src/content/docs/**` を読んだ。

---

## 0. 結論

### 0.1 本プロジェクトで「できる / 条件付き / できない」

| 項目 | 判定 | 確度 | 要点 |
|---|---|---|---|
| スラッシュコマンド・ボタン・セレクト・モーダル(HTTP Interactions のみ) | できる | 確定 | 初回応答 3 秒、token 15 分。deferred で延長 |
| ephemeral 応答 | できる | 確定 | `flags: 64`(コマンド・コンポーネント・モーダル送信の応答と followup) |
| 埋め込み・Components v2 | できる | 確定 | 埋め込みは 1 メッセージ 10 個・合計 6000 字。v2 は `1 << 15` フラグ(後戻り不可、`content`/`embeds` と併用不可) |
| 相互サーバーのある人への DM | できる | 確定(API の存在)/ 未検証(制約の細部) | `POST /users/@me/channels`。大量送信は制限される警告あり |
| 相互サーバーが**無い**応募者への DM | できない見込み | **未検証**(推測は BOT.md D1 と同じ) | 公式文書に「相互サーバー必須」の明記は無い。エラー 50007「Cannot send messages to this user」が存在する |
| ユーザー名から ID を引く | できない | 確定(文書化された API が無い) | `resolved` はコマンドの user オプションで選んだ相手のみ |
| ロール付与・剥奪 | できる | 確定 | `PUT/DELETE /guilds/{g}/members/{u}/roles/{r}`、Manage Roles + ロール順 |
| 招待の発行・失効 | できる | 確定 | 発行は Create Instant Invite、削除は招待先チャンネルの Manage Channels(または Manage Guild) |
| 招待の「使用された」検知(HTTP のみ) | 条件付き | 未検証 | `max_uses: 1` 後に招待が消えるかは文書に無い。`uses` は Get Channel Invites で取れる |
| チャンネル・スレッド・VC の作成削除 | できる | 確定 | Manage Channels / Create Private Threads / Manage Threads |
| スケジュールイベント | できる | 確定 | EXTERNAL / VOICE / STAGE。同時 100 件。必要権限は種別で異なる |
| Webhook(チャンネル投稿) | できる | 確定 | ボット所有 Webhook は全コンポーネント可、他者所有は非インタラクティブのみ |
| AutoMod ルールの作成(API) | できる | 確定 | Manage Guild。キーワード 6 件 / スパム 1 件 / プロフィール 1 件 / プリセット 1 件が上限 |
| メッセージ編集・ピン留め | できる | 確定 | 自分のメッセージの編集。ピンは `PIN_MESSAGES` 権限(新設) |
| Stage / フォーラム | できる | 確定 | Stage インスタンス作成、フォーラム投稿作成 API あり(本プロジェクトで必須ではない) |
| ユーザーアプリ(DM で使えるコマンド) | できる | 確定 | `integration_types` に USER_INSTALL、`contexts` に BOT_DM / PRIVATE_CHANNEL。ただし用途は限定的(本プロジェクトは対象外が妥当) |
| HTTP だけで `GUILD_MEMBER_ADD` / `VOICE_STATE_UPDATE` / `PRESENCE_UPDATE` を受ける | **できない** | 確定 | Webhook Events に該当なし。Gateway 専用 |
| Entitlements / Monetization | **対象外** | ― | 本プロジェクトでは扱わない |

### 0.2 BOT.md「要確認 D1〜D15」への回答

| # | 回答 | 確度 |
|---|---|---|
| D1 | DM を開く API は存在する。**相互サーバー無しで送れない点は文書に明記なし**(エラー 50007 の存在のみ)。ユーザー名→ID の公開 API は文書化されていない | 未検証(API 存在は確定) |
| D2 | 初回応答 3 秒、token 15 分、`PATCH .../messages/@original`(Edit Original Interaction Response)で deferred 後の更新が可能。type 5 直後の followup 投稿が「ローディングを編集する」挙動は**非推奨**扱い | 確定 |
| D3 | `max_age` は 0〜604800、`max_uses` は 0〜100、`unique: true` で再利用なし。**使用後に招待が削除され 10006 になるかは文書に無い**。招待オブジェクトに `uses` がある。一覧取得は Manage Channels が必要 | 部分確定 / 削除挙動は未検証 |
| D4 | `List Guild Members` は `GUILD_MEMBERS` 特権インテント必須と明記。**`Get Guild Member`(単体)には特権インテントの注記が無い** | 確定(文書上)/ 実機は未検証 |
| D5 | Webhook Events に参加イベントは**無い**。一覧は 5.2 / 2.3 参照 | 確定 |
| D6 | モーダルの `components` は 1〜5、`title` 45 字、`custom_id` 1〜100 字。テキスト入力の `max_length` は最大 4000。モーダルでもセレクト・ラジオ・チェック・ファイルアップロードが使える(Label で包む) | 確定 |
| D7 | Interactions Endpoint URL 保存時に PING(`type: 1`)を送り、200 + `{type:1}`(Content-Type 必須)と署名ヘッダー検証を要求。署名不正は 401 を返す | 確定 |
| D8 | 無効リクエスト(401/403/429)10,000 件 / 10 分で IP が一時ブロック。`X-RateLimit-Scope: shared` の 429 は数えない。Workers の共有 IP での実際の起き方は文書に無い | 確定 / Workers 側は未検証 |
| D9 | 招待 URL の権限整数を変えて再認可したときのロール権限更新は文書に記述なし | 未検証 |
| D10 | クライアントの `サーバー設定 > 連携サービス` で、導入済みアプリの `管理` から編集(文書記載)。表示名は将来変わりうる | 確定(文書時点) |
| D11 | Manage Roles が必須。加えて「ボットの最高ロールが対象ロールより上」のロール階層規則(Permission Hierarchy 節) | 確定 |
| D12 | Private Thread 作成は `CREATE_PRIVATE_THREADS`、全 private thread の閲覧と削除・アーカイブは `MANAGE_THREADS`。ロック済みスレッドの再開は `MANAGE_THREADS` のみ。`auto_archive_duration` は 60/1440/4320/10080。`invitable` は private thread 作成時のみ。**ブーストの要否は文書に記述なし** | 部分確定 / ブーストは未検証 |
| D13 | `permission_overwrites` で許可/拒否できるのはボット自身が持つ権限のみ。チャンネル単位での `MANAGE_ROLES` 設定には追加条件あり(原文を要再確認) | 確定(一部)/ 全文要確認 |
| D14 | カテゴリ上書きだけで作成・削除できるかは文書に記述なし(権限継承の一般規則からは可能と**推測**) | 未検証 |
| D15 | `GET /guilds/{g}/voice-states/{user}` は存在(在室者が居る VC への Connect 権限が必要)。**チャンネル単位の在室者一覧を返す REST は文書化されていない**。未在室時の応答コードは記述なし | 確定(エンドポイントと一覧が無いこと)/ 404 の詳細は未検証 |

(D16 以降のうち今回の調査範囲で触れたもの: D19 = `resolved.members` は partial member(`user`/`deaf`/`mute` を除く = `roles` を含む)で確定。D20 = `default_member_permissions` はコマンドオブジェクトのトップレベルのみにあり、オプション・サブコマンドの構造には無いため、サブコマンド単位では指定できない(構造からの確定)。D22 = Gateway の Identify 上限 24 時間 1000 回・Resume は数えない、は確定。D24 = Move Members + 移動先 Connect は確定、未接続時のエラー 40032「Target user is not connected to voice」も確定。C2〜C9 は 6 章参照。)

### 0.3 重要な追加知見

1. **Cloudflare 公式の記述により C8 の半分が解けた**: DO から開いた外向き WebSocket は退避(eviction)を防ぐが、**各操作の防止期間は開始から最大 15 分**。接続自体は 15 分後も開いたままになりうる。外向き WebSocket は Hibernation 非対応。→ 常時接続すると duration は連続課金になる(6.1)
2. Webhook Events は増えているが、増分はすべて Social SDK(Lobby / Game DM)と Quest で、**ギルド運営に使えるイベントは無い**(2.3)
3. **既存の WARDOGS 専用ボットの OSS が複数ある**(5.3)。いずれも RCON HTTP API をポーリングする方式で、読み取り専用(`/v1/status` 等)に限定したものが多い
4. 招待に「受け入れ可能なユーザーを限定する」`Target Users` 系 API が追加されている(1.6)。ただし事前にユーザー ID が分からないため本プロジェクトの用途には合わない

---

## 1. 機能カテゴリ別の可否

出典の記号は 7 章。確度は特記が無い限り **確定(一次資料)**。

### 1.1 スラッシュコマンド(`interactions/application-commands`)

- 1 アプリあたり グローバル `CHAT_INPUT` 100、`USER` 15、`MESSAGE` 15(ギルド固有も同数)
- コマンド作成は **ギルドごとに 1 日 200 回**まで(Danger 表記)
- オプションは最大 25。説明 1〜100 字。1 コマンドの名前・説明・値の合計 8000 文字
- サブコマンド / サブコマンドグループは、現状すべてトップレベルに並んで表示される
- 権限: `default_member_permissions`(`"0"` で管理者のみ既定)、導入先ごとの上書きは `Server Settings > Integrations`。コマンド権限の上書きは最大 100 件
- 文脈: `integration_types`(サーバー導入 / ユーザー導入)と `contexts`(GUILD / BOT_DM / PRIVATE_CHANNEL)。`dm_permission` は非推奨

### 1.2 ボタン・セレクト・モーダル(`components/reference`)

- メッセージ: レガシーは最上位に ActionRow を最大 5。ActionRow はボタン最大 5 個、またはセレクト 1 個
- Components v2: `IS_COMPONENTS_V2`(`1 << 15`)で有効化、**メッセージ全体で最大 40 コンポーネント**。`content`・`embeds`・`poll`・`stickers` は使えなくなる(Text Display / Container に置き換え)。一度付けたら外せない。deferred 応答で v2 を使う場合は Edit Original で作る
- セレクト: String / User / Role / Mentionable / Channel。`max_values` は最大 25。String のオプションのラベルは 100 字
- モーダル: 最上位 `components` は 1〜5、`title` 45 字。テキスト入力は `max_length` 最大 4000。Label(ラベル 45 字・説明 100 字)で包む。モーダル内で使えるのはテキスト入力、各種セレクト、Text Display、ラジオグループ、チェックボックス(グループ)、ファイルアップロード(最大 10 ファイル)
- 埋め込み(`resources/message`): title 256、description 4096、field.name 256、field.value 1024、author.name 256、全埋め込みの合計 6000 字、1 メッセージ 10 個。`content` は 2000 字

### 1.3 ephemeral 応答

- `EPHEMERAL`(`1 << 6`)。コマンド応答・コンポーネント応答・followup で指定可
- deferred(type 5)で使えるフラグは EPHEMERAL のみ。「type 5 の直後に followup を投稿するとローディングを編集する(ephemeral は無視)」挙動は非推奨のため、Edit Original を使う

### 1.4 DM

- `POST /users/@me/channels` で DM チャンネルを作成(既存があれば返る)。「サーバー全員への一斉 DM に使うな。DM は原則ユーザーの操作が起点。短時間に大量に開くとレート制限・ブロックされうる」との警告あり
- 相互サーバーが無い相手への送信可否: 文書に記述なし。エラーコード 50007 は存在する。**未検証**(BOT.md の D1 の理解を覆す根拠も裏付ける根拠も一次資料に無い)
- OAuth2 の `guilds.join` スコープで、ユーザーの access token があれば `PUT /guilds/{g}/members/{u}` でサーバーに追加できる(BOT.md 3.4 の保留案の根拠。応募フォーム側に OAuth 実装が必要)
- ユーザー名から ID を引く API は文書化されていない(推測: 引けない)

### 1.5 ロール付与・剥奪

- `PUT/DELETE /guilds/{g}/members/{u}/roles/{r}`。`MANAGE_ROLES` 必須、204、監査ログ理由は `X-Audit-Log-Reason`
- ロール階層: ボットの最高ロールより上のロールは付与できない(Permission Hierarchy)

### 1.6 招待

- 作成: `POST /channels/{c}/invites`(Create Instant Invite)。`max_age` 0〜604800 秒(既定 86400)、`max_uses` 0〜100、`unique`、`temporary`。リクエストボディは必須(空の `{}` でよい)
- 取得: `GET /invites/{code}`、一覧: `GET /channels/{c}/invites`(Manage Channels、`uses` を含むメタデータ)
- 失効: `DELETE /invites/{code}`(招待先チャンネルの Manage Channels、またはギルド全体の Manage Guild)
- 新規: `target_user_ids`(最大 1000)で受け入れ可能なユーザーを限定でき、`Get/Add/Remove/Update/Bulk-Add/Bulk-Delete Target Users` が追加されている。**応募者のユーザー ID が事前に分からない本件では使えない**(推測)

### 1.7 チャンネル・スレッド・ボイスチャンネル

- ギルドチャンネル作成: Manage Channels。作成時の `permission_overwrites` はボットが持つ権限のみ許可/拒否できる。ギルドあたり**チャンネル 500**(エラー 30013)、**権限上書き 1000**(30060)
- スレッド: 公開・非公開・メッセージ起点・フォーラム投稿。**スレッドはチャンネル数に数えない**がアクティブスレッド数に上限あり(エラー 160006)。非公開スレッドは招待された人と `MANAGE_THREADS` 保有者のみ閲覧可。ロックは `MANAGE_THREADS` のみ。作成者は名前・アーカイブ・`auto_archive_duration` を変更可
- VC: `type: 2` で作成、`user_limit` 設定。移動は `PATCH /guilds/{g}/members/{u}` の `channel_id`(Move Members + 移動先 Connect。未接続は 40032)。在室者一覧の REST は無い。`GET /guilds/{g}/voice-states/{u}` で 1 人の状態のみ
- 削除: `DELETE /channels/{id}`。ボイスチャンネルのステータス設定 API もある

### 1.8 スケジュールイベント

- 種別: STAGE_INSTANCE / VOICE / EXTERNAL(外部は場所 1〜100 字と終了時刻が必須)。名前 1〜100 字、説明 1〜1000 字。**SCHEDULED または ACTIVE は同時 100 件**
- 権限は種別で異なる。STAGE は CREATE_EVENTS + MANAGE_CHANNELS + MUTE_MEMBERS + MOVE_MEMBERS。VOICE / EXTERNAL の必要権限は本調査では VOICE・EXTERNAL の節を未精読(要確認)
- 外部イベントは開始・終了時刻で自動的に ACTIVE / COMPLETED になる

### 1.9 Webhook

- 実行: `POST /webhooks/{id}/{token}`。`content` / `embeds` / `components` / `file` / `poll` のいずれか必須
- コンポーネント: **アプリ所有の Webhook はすべて可、非所有は `with_components=true` で非インタラクティブのみ**。`IS_COMPONENTS_V2` 時は `content` などを併用できない
- 404 を返す Webhook は使い続けない(使い続けると制限)。Webhook の具体的な数値上限は一次資料に無い

### 1.10 自動モデレーション(`resources/auto-moderation`)

- ルール作成・更新は `MANAGE_GUILD`。トリガー: KEYWORD(最大 6)、SPAM、KEYWORD_PRESET(1)、MENTION_SPAM(1)、MEMBER_PROFILE(1)
- キーワード: 1 ルール 1000 件・1 件 60 字、正規表現 10 個・260 字。除外ロール 20、除外チャンネル 50
- アクション: メッセージのブロック(カスタム文 150 字)、アラート送信、タイムアウト(最大 4 週間。`MODERATE_MEMBERS` 必須。KEYWORD / MENTION_SPAM のみ)
- ルールの**発火の通知を受ける**には Gateway の `AUTO_MODERATION_*` イベントが必要(Webhook Events には無い)。アラート送信アクションでチャンネルに投稿させる使い方は Gateway 不要

### 1.11 メッセージの編集・ピン留め

- ボット自身のメッセージは編集可。Components v2 のフラグは設定のみ可(外せない)
- ピン: `PUT/DELETE /channels/{c}/messages/{m}/pin`(新エンドポイント)。権限 `PIN_MESSAGES`(`1 << 51`)。取得 `GET /channels/{c}/messages/pins` は 1 回 1〜50 件。旧エンドポイントは deprecated。エラー 30003 の本文は旧仕様の「250」のまま残っている可能性あり(要確認)

### 1.12 Stage / フォーラム

- Stage インスタンス: トピック 1〜120 字。作成はチャンネルに対する管理系権限が必要(詳細は未精読)
- フォーラム/メディア: `POST /channels/{c}/threads` でスレッド + 最初のメッセージを作成(サイズ上限 25 MiB)。メッセージ送信権限があればよい。フォーラムに通常メッセージは投稿できない(エラー 40058)

### 1.13 ユーザーアプリ(DM で使えるコマンド)

- コマンドに `integration_types: [0, 1]`、`contexts: [0, 1, 2]` を付けると、ユーザーがアカウントにアプリを導入して DM / グループ DM でもコマンドを使える。そのときの followup は**1 インタラクション 5 件まで**(サーバー未導入の場合)
- 本プロジェクトの参加者にコマンド実行を求める工程は作らない方針のため、仕様の存在のみ記録する

### 1.14 Entitlements / Monetization

対象外。Webhook Events の `ENTITLEMENT_*` を受ける設定は不要。

---

## 2. HTTP Interactions vs Gateway

### 2.1 HTTP Interactions のみで可能なこと(確定)

- コマンド・コンポーネント・モーダル送信・オートコンプリートの受信と応答(PING/PONG、`X-Signature-Ed25519` と `X-Signature-Timestamp` の検証、不正は 401)
- 受信後の REST 呼び出し全般(ロール・招待・チャンネル作成・メッセージ送信・Webhook 実行)
- Interaction の応答は**グローバルレート制限の対象外**(「Interaction endpoints are not bound to the bot's Global Rate Limit」)。Interaction Webhook は通常の Webhook と同じ制限

### 2.2 応答時間とフォローアップ

| 項目 | 内容 |
|---|---|
| 初回応答 | 受信から **3 秒以内**。超過すると token が無効 |
| token の寿命 | **15 分**(followup を含む) |
| 応答 type | 1 PONG / 4 メッセージ / 5 deferred メッセージ / 6 deferred 更新(コンポーネント・モーダル送信のみ)/ 7 更新(コンポーネントのみ)/ 8 オートコンプリート結果 / 9 モーダル(モーダル送信と PING には不可)/ 10 PREMIUM_REQUIRED(非推奨)/ 12 LAUNCH_ACTIVITY |
| followup | Edit/Delete Original、Create/Edit/Delete Followup。`thread_id`・`avatar_url`・`username` は不可、`wait` は常に true |
| オートコンプリート | 選択肢は最大 25 |

### 2.3 Webhook Events(アプリ向け HTTP イベント配信。確定)

設定: Developer Portal の Webhooks ページで Endpoint を登録し、Events を有効化して購読イベントを選ぶ(または Edit Current Application)。受信側は **3 秒以内に 204(ボディなし)** で応答。無応答は指数バックオフで最大 10 分再送。失敗が続くと配信停止とメール通知。PING(type 0)と署名検証あり。

| イベント | 内容 |
|---|---|
| `APPLICATION_AUTHORIZED` | アプリがサーバー(`integration_type` 0)またはユーザー(1)に導入された。`guild`・`user`・`scopes` を含む |
| `APPLICATION_DEAUTHORIZED` | 導入が取り消された |
| `ENTITLEMENT_CREATE` / `_UPDATE` / `_DELETE` | Monetization(対象外) |
| `QUEST_USER_ENROLLMENT` | 現時点では**受信不可**(設定画面に出るため文書化) |
| `LOBBY_MESSAGE_CREATE` / `_UPDATE` / `_DELETE` | Social SDK のロビー |
| `GAME_DIRECT_MESSAGE_CREATE` / `_UPDATE` / `_DELETE` | Social SDK セッション中の DM |

→ 「`APPLICATION_AUTHORIZED`・`ENTITLEMENT_CREATE` 以外に増えているか」への回答: **増えているが、ギルド運営(参加・退出・ボイス・メッセージ・プレゼンス)に関するものは 1 つも無い**。

### 2.4 Gateway が必要なこと(確定)

| 欲しい情報 | イベント | インテント | HTTP で取れるか |
|---|---|---|---|
| メンバー参加 | `GUILD_MEMBER_ADD` | GUILD_MEMBERS(**特権**) | 取れない(Webhook Events に無い) |
| メンバー退出 | `GUILD_MEMBER_REMOVE` | GUILD_MEMBERS(**特権**) | 取れない。代替は `GET /guilds/{g}/members/{u}` のポーリング(404 = 不在)。この単体取得に特権インテントの注記は文書に無い(D4) |
| ボイス入退室 | `VOICE_STATE_UPDATE` | GUILD_VOICE_STATES(非特権) | 取れない |
| プレゼンス | `PRESENCE_UPDATE` | GUILD_PRESENCES(**特権**) | 取れない |
| 招待の作成・削除 | `INVITE_CREATE` / `INVITE_DELETE` | GUILD_INVITES(非特権) | 取れない |
| チャンネル削除 | `CHANNEL_DELETE` | GUILDS(非特権) | 取れない |
| メッセージ本文 | `MESSAGE_CREATE` 等 | GUILD_MESSAGES + MESSAGE_CONTENT(**特権**) | 取れない |
| AutoMod の発火 | `AUTO_MODERATION_ACTION_EXECUTION` | AUTO_MODERATION_EXECUTION(非特権) | 取れない |

Gateway 接続の仕様: HELLO で heartbeat 間隔 × jitter(0〜1)後に最初の heartbeat、ACK が無ければ 1000/1001 以外のコードで切って再接続。`IDENTIFY` は **24 時間 1000 回**(全シャード合算、`RESUME` は数えない)、超過で全セッション切断とトークンのリセット。`1000`/`1001` で閉じるとセッションが無効になる。`GUILD_CREATE` に `voice_states` を含む(BOT.md D22 のうち「大規模でないサーバーで全件含まれるか」は、`large_threshold`(50〜250)の挙動説明はあるが voice_states の全件保証の明文は未確認)。

---

## 3. 特権インテント

### 3.1 一覧と要否(確定)

| 特権インテント | 影響 | 本プロジェクト |
|---|---|---|
| Server Members(`GUILD_MEMBERS`) | `GUILD_MEMBER_ADD/UPDATE/REMOVE`、`List Guild Members`(REST も) | 不要(`/register` + 招待照合 + 単体取得で代替する設計)。**単体取得に必要かは未検証** |
| Presence(`GUILD_PRESENCES`) | `PRESENCE_UPDATE` | 不要 |
| Message Content(`MESSAGE_CONTENT`) | メッセージの `content` 等が入る | 不要(AutoMod とコマンドで足りる) |

### 3.2 小規模ボット(100 サーバー未満)の申請要否(確定)

- Developer Portal の **Bot ページで「Privileged Gateway Intents」をトグルするだけ**。審査は不要
- 「ユーザーが 10,000 人未満のアプリはトグルのみでアクセス可。10,000 人超(アプリが見えるサーバー全体の固有ユーザー数)で審査が必要になる」旨の記述がある一方、「100 サーバー以上のアプリは認証(verification)が必要で、認証後に特権インテントも承認が必要」とも書かれている。つまり **100 サーバー未満のコミュニティ専用ボットでは申請不要**。本プロジェクトはサーバー 1 つなので該当しない
- 特権インテントを IDENTIFY に渡すのにポータルで有効化していない場合は close code `4014`、無効なインテントは `4013`
- 非特権インテントはポータル設定不要(BOT.md の `129` = GUILDS + GUILD_VOICE_STATES は妥当)

---

## 4. レート制限とサイズ上限

### 4.1 レート制限(確定)

| 項目 | 内容 |
|---|---|
| グローバル | ボット 1 つあたり **50 リクエスト / 秒**。Authorization 無しは IP 単位 |
| Interactions | グローバル制限の**対象外** |
| ルート別 | HTTP メソッド × 最上位リソース(`channel_id` / `guild_id` / `webhook_id`(+ token))単位。別リソースには影響しない。同じ上限を共有するルートは `X-RateLimit-Bucket` で識別 |
| ヘッダー | `X-RateLimit-Limit` / `Remaining` / `Reset` / `Reset-After` / `Bucket` / `Global`(429 時)/ `Scope`(user / global / shared) |
| 429 | `Retry-After` または本文の `retry_after` に従う。上限値のハードコードは非推奨 |
| 無効リクエスト | 401 / 403 / 429 が **10,000 回 / 10 分** で IP が一時ブロック(`Scope: shared` の 429 は数えない) |
| チャンネル改名など個別値 | 数値は一次資料に無い(BOT.md の「10 分に 2 回」は本調査では**未検証**) |

### 4.2 サイズ上限(確定)

| 対象 | 上限 |
|---|---|
| メッセージ本文 | 2000 字 |
| 埋め込み | 10 個 / メッセージ。title 256、description 4096、field name 256、field value 1024、author name 256、**合計 6000 字** |
| メッセージのコンポーネント | レガシー: ActionRow 5 × ボタン 5。v2: 全体 40 |
| セレクト | 選択数 最大 25、オプションのラベル 100 字 |
| モーダル | コンポーネント 1〜5、title 45 字、custom_id 1〜100、テキスト入力 4000 字 |
| オートコンプリート | 25 件 |
| スラッシュコマンド | オプション 25、説明 100、合計 8000 字、グローバル 100 / 15 / 15、作成は 1 日 200 回 / ギルド |
| スケジュールイベント | 同時 100 件 |
| ギルド | チャンネル 500、ロール 250、Webhook 15 / チャンネル・1000 / ギルド、権限上書き 1000 |
| 招待 | `max_age` ≤ 604800、`max_uses` ≤ 100 |
| 添付 | 1 メッセージ 10 個(30015) |

---

## 5. ゲームサーバー連携の典型パターンと OSS 事例

### 5.1 よくある機能(各 OSS の README から。一次資料ではなく**事例**)

| 機能 | RCON 経由での実装 | Discord 側の手段 |
|---|---|---|
| プレイヤー一覧・人数 | RCON / HTTP の status 系を定期取得 | 埋め込みを**編集し続ける**パネル。人数をボットのニックネームやステータスに出す例もある |
| 人数のチャンネル名表示 | 取得値でチャンネル名を更新 | チャンネル名変更は**短時間の回数制限が厳しい**ため、メッセージ編集を使う実装が多い(下記 `msmcpeake` の README に明記)。上限数値は一次資料で未確認 |
| kick / ban / メッセージ送信 / 再起動 | RCON コマンド(または HTTP の POST 系) | 管理者限定のスラッシュコマンド |
| ログ転送・参加/退出通知 | RCON のログ取得 or ゲーム側プラグイン | チャンネル投稿 |
| チャットブリッジ | ゲーム側プラグイン経由(RCON 単体では難しい) | Webhook / Gateway |

### 5.2 代表的な OSS(いずれも 2026-10-15 に `gh` で README を確認。ライセンス・更新日は検索結果)

| ゲーム | リポジトリ | 内容 | 更新 / ライセンス |
|---|---|---|---|
| Palworld | https://github.com/dkoz/palworld-palbot | RCON 連携、サーバー管理、イベントログ(参加/退出)、状態トラッカー、チャットリレー、チケット、経済・ショップなど。**作者が開発を停止し後継(projectsphere)へ移行** | 2025-04 / GPL-3.0 |
| Palworld | https://github.com/projectsphere/sphere | 上記の後継。ホワイトリスト、サーバー・プレイヤー管理 | 2026-07 / (未表記) |
| Minecraft | https://github.com/DiscordSRV/DiscordSRV | ゲーム内チャットと Discord の橋渡し(サーバープラグイン方式。RCON ではない) | 2026-08 / GPL-3.0 |
| Rust | https://github.com/Jakb1202/Rust-server-discord-bot-rcon | Discord ボットから Rust サーバーの RCON を操作 | 2021-05(長期未更新)/ BSD-3-Clause |
| Valheim | https://github.com/camm9909/valheim-discord-bot | ゲーム内のプレイヤー・イベントを Discord に通知 | 2022-04(長期未更新) |

ARK / Source 系は、星の多い代表例を本調査では確認できなかった(検索語を絞っても該当が薄い)。**未検証**。

### 5.3 WARDOGS 専用のボット(存在する。第三者が公開、内容は未検証)

いずれも **README の記述のみ読んだ。コードの実行・監査はしていない**(第三者 OSS はデータとして扱う)。

| リポジトリ | 内容(README より) |
|---|---|
| https://github.com/nobodys-tools/wardogs-discord-status | 「RCON HTTP API」をポーリングし、**1 枚のパネルを編集し続ける**。人数(24 時間グラフ・ピーク・平均)、マップ、試合タイマー、陣営スコア、経済、上位プレイヤー、全プレイヤー一覧。複数サーバー・複数パネル。必要権限は View / Send / Embed Links / Attach Files のみ。**特権インテント不要**。discord.js v14 + Docker + SQLite(常駐プロセス)。MIT |
| https://github.com/unn-corp/sgtpuppers | **読み取り専用**の状態ボット。プレゼンスに人数、約 1 分ごとのパネル更新(現在・次のマップ、参加用 ID、陣営スコア)。Docker 常駐。同リポジトリの `docs/wardogs-api.md` に API カタログ |
| https://github.com/msmcpeake/wardogs-discord-status | ゲーム画面の OCR で参加中サーバーを読み取り、Discord メッセージを 1 件更新し続ける(Gateway 不使用、REST のみ)。Windows 常駐。MIT |

### 5.4 RCON HTTP API について第三者が記述していること(**未検証**。公式ドキュメントは確認できていない)

`unn-corp/sgtpuppers` の `docs/wardogs-api.md`(2026-09-14 調査と記載)より。**API 仕様の根拠は第三者による公式コンソールのクライアントコードの読解と、本人のサーバーへの GET 9 回**であり、本調査では再検証していない。

- 通信は平文 HTTP、**全リクエストに `Authorization: Bearer <パスワード>`**(1 本のパスワード。権限分離・読み取り専用トークンの存在は記述なし = 未検証)
- 上限は「600 リクエスト / 分 / クライアント IP、リクエストボディ 65,536 バイト」と**サーバーが自己申告**(`/v1/capabilities`)。実際の制限は異なりうる
- 読み取り系: `/v1/capabilities`、`/v1/status`(名前・マップ・プレイヤー数・陣営スコア・ローテーション)、`/v1/players`、`/v1/bans`、`/v1/rotation`、`/v1/server-id`、`/v1/audit` ほか
- 書き込み系(第三者は一度も呼んでいない): プレイヤーの kick / kill / メッセージ / チーム変更、ban・解除、全体ブロードキャスト、試合の終了・再開・マップ変更、設定の更新
- 試合の経過時間(`matchSeconds`)などコンソールが参照する項目が実サーバーの応答に無い場合がある

→ 本プロジェクトで「状態の定期表示」を作るなら、上記 OSS と同様に **`/v1/status` 相当の読み取りだけ**を使う設計が先例に沿う。パスワードは書き込み権限を含むと推測されるため Worker Secrets のみで保持する(推測)。

---

## 6. Cloudflare Workers 上の制約

### 6.1 Durable Object からの外向き WebSocket(Gateway 接続)

| 項目 | 内容 | 確度 |
|---|---|---|
| 接続方法 | `fetch(url, { headers: { Upgrade: "websocket" } })` → `res.webSocket` → `accept()`。または `new WebSocket(url)`(自動 accept。`allowHalfOpen` 指定不可)。公式例は `https://` スキーム | 確定(`wss://` を受け付けるかは未検証 = C7) |
| Hibernation | **DO が WebSocket サーバーのときのみ対応。外向き WebSocket は Hibernate しない** | 確定 |
| 退避の防止 | 外向き WebSocket・保留中の I/O・`setTimeout` などは退避を防ぐが、**各操作の防止は開始から最大 15 分**。接続自体は 15 分後も開いたままになりうる。別の I/O を後から始めると滞在時間が延びる | 確定(C8 の前半) |
| 15 分以降に退避されるか | 接続だけが残る状態で退避されるか、受信メッセージ(heartbeat ACK)が「イベント」として延命するかは文書に無い | **未検証**(C8 の後半) |
| 課金 | 退避を防いでいる間、および「アイドルだが Hibernate できない」状態で duration 課金が継続 | 確定 |
| 無料枠 | リクエスト 100,000 / 日、duration **13,000 GB-s / 日**、SQLite ストレージ書き込み 100,000 行 / 日、ストレージ 5 GB。上限超過でその種類の操作が失敗。毎日 00:00 UTC にリセット | 確定 |
| WebSocket のリクエスト課金 | 接続確立に 1 リクエスト。**受信メッセージは 20 通 = 1 リクエスト**、送信メッセージは無料、WebSocket の ping は無料 | 確定 |
| 常時接続の duration | 128 MB × 86,400 秒 = 11,059,200 MB・s ≒ **10,800 GB-s / 日**(無料枠 13,000 の約 83%)。ほかの処理と合わせて超えるおそれ | 確定(算術)/ 実際の計測は未検証(C9) |
| DO のクラス | SQLite バックエンドのみ無料プランで可。クラス数 100(Free) | 確定 |
| 1 受信メッセージの CPU | DO では「HTTP リクエストまたは WebSocket メッセージごとに CPU 残量が 30 秒にリセット」。Workers 無料枠の 10 ms との関係(DO にも 10 ms が適用されるか)は表現が曖昧 | 未検証(C9) |

### 6.2 Service Binding

- Worker 間の呼び出しは Service Binding を使う。**同一ゾーンで Worker から別 Worker のカスタムドメインへグローバル `fetch()` すると失敗する**と明記(BOT.md の「ボット → サイトは `SITE_ORIGIN` へ fetch」は LIVE.md 11-6 の未確認事項に該当。**要再確認**)
- RPC(`WorkerEntrypoint`)の Service Binding も公式に存在(`service-bindings/rpc`)。公開 HTTP からの到達不能性(C1)は本調査では未精読
- Service Binding 先の Worker は同時接続数の制限を共有する
- 無料枠の「内部サービスへのサブリクエスト」は **1,000 / 呼び出し**で、外部への fetch の 50 とは別枠

### 6.3 Cron Triggers

- 無料プランで 1 アカウント **5 個**(Paid 250)。`* * * * *`(毎分)の例が公式にあり、**最小間隔は 1 分**(確定)
- Cron は UTC 基準。変更の反映に最大 15 分。Cron の CPU 時間は 50 ms と読める記載があるが、既存の `cloudflare-free-tier.md` は 10 ms としている(差異あり。**要確認**)
- Cron 実行が 1 日 100,000 リクエストの枠に含まれるかは未確認(既存調査と同じ)

### 6.4 サブリクエスト

- 無料: **1 呼び出しあたり 50**(外部 `fetch`、KV、D1、R2 を含む)。リダイレクトの各段も数える。有料は 10,000
- 同時に応答ヘッダーを待てる接続は 6
- BOT.md の「1 回 40 件まで」の設計は、この 50 の枠内に収まる

---

## 7. 出典 URL 一覧(確認日 2026-10-15)

### Discord(公式。本文は `discord/discord-api-docs` main の `developers/` 配下の .mdx を読んだ)

| 記号 | URL |
|---|---|
| [I] | https://docs.discord.com/developers/interactions/overview |
| [R] | https://docs.discord.com/developers/interactions/receiving-and-responding |
| [A] | https://docs.discord.com/developers/interactions/application-commands |
| [C] | https://docs.discord.com/developers/components/reference |
| [WH-E] | https://docs.discord.com/developers/events/webhook-events |
| [GW] | https://docs.discord.com/developers/events/gateway |
| [GWE] | https://docs.discord.com/developers/events/gateway-events |
| [RL] | https://docs.discord.com/developers/topics/rate-limits |
| [P] | https://docs.discord.com/developers/topics/permissions |
| [TH] | https://docs.discord.com/developers/topics/threads |
| [OC] | https://docs.discord.com/developers/topics/opcodes-and-status-codes |
| [OA] | https://docs.discord.com/developers/topics/oauth2 |
| [G] | https://docs.discord.com/developers/resources/guild |
| [CH] | https://docs.discord.com/developers/resources/channel |
| [M] | https://docs.discord.com/developers/resources/message |
| [INV] | https://docs.discord.com/developers/resources/invite |
| [U] | https://docs.discord.com/developers/resources/user |
| [V] | https://docs.discord.com/developers/resources/voice |
| [GSE] | https://docs.discord.com/developers/resources/guild-scheduled-event |
| [AM] | https://docs.discord.com/developers/resources/auto-moderation |
| [S] | https://docs.discord.com/developers/resources/stage-instance |
| [W] | https://docs.discord.com/developers/resources/webhook |

旧 URL(`https://discord.com/developers/docs/...`)は上記へ 301 転送される。ソース: https://github.com/discord/discord-api-docs

### Cloudflare(公式。`cloudflare/cloudflare-docs` の .mdx を読んだ)

- https://developers.cloudflare.com/workers/platform/limits/
- https://developers.cloudflare.com/workers/configuration/cron-triggers/
- https://developers.cloudflare.com/workers/runtime-apis/websockets/
- https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/
- https://developers.cloudflare.com/durable-objects/best-practices/websockets/
- https://developers.cloudflare.com/durable-objects/platform/limits/
- https://developers.cloudflare.com/durable-objects/platform/pricing/

### OSS(事例。第三者の README のみ。2026-10-15 に `gh` で取得)

- https://github.com/nobodys-tools/wardogs-discord-status
- https://github.com/unn-corp/sgtpuppers
- https://github.com/msmcpeake/wardogs-discord-status
- https://github.com/dkoz/palworld-palbot
- https://github.com/projectsphere/sphere
- https://github.com/DiscordSRV/DiscordSRV
- https://github.com/Jakb1202/Rust-server-discord-bot-rcon
- https://github.com/camm9909/valheim-discord-bot

### 本調査での注意

`WebFetch` による docs.discord.com の整形取得は一部失敗(Webhook Events と Gateway)したため、該当箇所は上記リポジトリの原文(.mdx)で確認した。

---

## 8. 要確認事項

### 8.1 Discord

1. **D1 の実機確認**: 相互サーバー無しの相手に `POST /users/@me/channels` → 送信したときのエラー(50007 の可否)。一次資料に記述が無いため、自分のテストアカウントでのみ検証できる。参加者・運営への工程追加は不要
2. **D3 の実機確認**: `max_uses: 1` の招待を使い切った後に `GET /invites/{code}` が 10006 になるか。ならない場合は `GET /channels/{id}/invites` の `uses` で判定(Manage Channels)
3. **D4**: `GET /guilds/{id}/members/{user_id}` が特権インテントなしで 200/404 を返すか(文書上は注記なし)
4. D9(権限整数の変更)、D12 のうちブースト要否、D14(カテゴリ上書きだけでの作成・削除)、D15 の未在室時の応答コード、D16(VC テキストチャットへの投稿権限)、D17 の作成レート、D22 の細部(INVALID_SESSION 後の待機、再送の順序、GUILD_CREATE の `voice_states` 全件保証)
5. スケジュールイベントの VOICE / EXTERNAL の必要権限(STAGE 以外は未精読)、Stage インスタンスの作成権限、`PIN_MESSAGES` と 30003 の上限値の整合
6. 招待の `target_user_ids` の用途(本件では事前に ID が分からないため対象外と推測)

### 8.2 Cloudflare

1. **C8 の後半**: 15 分を過ぎた外向き WebSocket が、heartbeat ACK の受信で DO を延命するか。実機で DO を常時接続して 1 時間以上のログを取る必要がある
2. **C9**: 無料枠での duration の実使用量(常時接続の理論値は約 10,800 GB-s / 日)、WebSocket メッセージごとの CPU 10 ms / サブリクエスト 50 の適用単位
3. C7: `wss://` を `fetch` に渡せるか(公式例は `https://`)
4. Cron の CPU 時間(50 ms か 10 ms か)、Cron が日次リクエスト枠に含まれるか
5. ボット → サイトの `SITE_ORIGIN` への `fetch`(同一ゾーンのカスタムドメイン宛。文書上は失敗すると明記)。LIVE.md 11-6 の実機結果を確認すること

### 8.3 RCON HTTP API(**公式文書は確認できていない**)

1. 公式ドキュメントの有無(第三者は「公式コンソールのクライアントコード」を根拠にしている)
2. 認証が 1 本のパスワード(Bearer)のみか、読み取り専用の権限があるか
3. 実際のレート制限(自己申告は 600 / 分 / IP)と Workers の共有 IP からの呼び出し可否
4. 業者ページの記述は**未検証**のまま扱うこと(本書の 5.4 も同様)
