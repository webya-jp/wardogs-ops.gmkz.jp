-- 複数サーバー + 管理者 + 設定(Worker Secrets の廃止)。docs/ARCHITECTURE.md 第 5・8・15 章。
-- 2026-10-16 に書き換え: 本番は 0001_init.sql のみ適用済みで、このファイルはどの本番にも未適用のため、
-- servers・admins・settings を 1 本にまとめた(ローカルの D1 は作り直す。README「開発者向け」)。
-- 本番に適用した後は、このファイルを変更しない(以後の変更は 0003 以降に追加のみ)。
-- 0001 の表は稼働中のため**追加のみ**(既存テーブルの作り直し・列の削除・CHECK の変更はしない)。
-- 時刻はすべて UTC epoch ミリ秒(INTEGER)。
-- 管理パスワードは平文で保存しない(PBKDF2 のハッシュのみ)。RCON パスワードは平文で保存しない(AES-256-GCM の暗号文のみ)。
-- 実際のホスト名・ポート・パスワード・鍵をこのファイル・テスト・ドキュメントに書かない(例はダミーのみ)。

-- ------------------------------------------------------------
-- 管理者(パネルにログインする人)。/setup で 0 件のときだけ 1 行登録できる(docs/ARCHITECTURE.md 5.1)。
-- 現状は 1 名運用だが、将来の複数管理者に備えて複数行を許す形にしてある。
-- パスワードを忘れた・乗っ取られたときは、Cloudflare のダッシュボードでこの表の行を削除して /setup で登録し直す(README 6 章)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS admins (
  -- AUTOINCREMENT: 削除した id を再利用しない(ログイン Cookie に id を含めるため、登録し直すと古い Cookie が通らなくなる)
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  -- 'pbkdf2-sha256$<反復回数>$<salt>$<導出値>'(salt 16 バイト・導出値 32 バイト、いずれも base64url)。src/types/env.ts の PASSWORD_HASH_*
  password_hash TEXT    NOT NULL,
  -- ログイン Cookie の署名に混ぜるランダム値(16 バイトの base64url)。変えるとこの管理者の全セッションが失効する
  -- (登録時に生成。将来のパスワード変更・「全端末からログアウト」で作り直す)
  session_stamp TEXT    NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- ------------------------------------------------------------
-- パネルの設定(key / value)。現状のキーは instance_key だけ(src/types/env.ts の SETTINGS_KEYS)。
-- instance_key: 32 バイトの乱数(base64url)。セッション Cookie・確認トークン・IP ハッシュの HMAC 鍵と、
--   RCON パスワードの暗号鍵の元(HKDF で用途別に派生)。必要になった時点で INSERT OR IGNORE で 1 回だけ作り、以後変えない。
--   **この行を消すと保存済みの RCON パスワードが読めなくなり、全員ログアウトされる**。どの API の応答にも出さない
-- 将来 vars(LANGUAGE / TIMEZONE)を画面の設定に移すときもこの表に置く
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT    PRIMARY KEY,
  value      TEXT    NOT NULL,
  updated_at INTEGER NOT NULL
);

-- ------------------------------------------------------------
-- 画面から追加した RCON の接続先(docs/ARCHITECTURE.md 第 15 章)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS servers (
  -- AUTOINCREMENT: 削除した id を再利用しない(audit_log.server_id・server_snapshots が過去の id を指し続けるため)
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  -- 表示名(1〜32 文字。運営者が付ける名前。UNIQUE)
  name              TEXT    NOT NULL,
  -- ホスト名のみ(小文字に正規化。スキーム・ポート・パス・認証情報を含めない。IP アドレス不可)
  host              TEXT    NOT NULL,
  port              INTEGER NOT NULL CHECK (port BETWEEN 1 AND 65535),
  -- 当面は 'http' 固定(画面に出さない)。RCON の TLS 対応が確認できたら https を選べるようにする(要確認 R-3 / R-5)
  scheme            TEXT    NOT NULL DEFAULT 'http' CHECK (scheme IN ('http', 'https')),
  -- 'v2.<iv>.<ct>'(AES-256-GCM。鍵は instance_key から HKDF で派生。iv 12 バイト、ct は暗号文 + タグ 16 バイト。いずれも base64url)
  rcon_password_enc TEXT    NOT NULL,
  enabled           INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  -- 一覧・切り替えの並び順(小さい順、同じなら id 順)
  sort_order        INTEGER NOT NULL DEFAULT 0,
  -- 直近の接続テスト(GET /v1/status)の時刻と結果('ok' または ApiErrorCode の RCON_*)。未実施は NULL
  last_test_at      INTEGER,
  last_test_result  TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_servers_name ON servers (name);
CREATE UNIQUE INDEX IF NOT EXISTS idx_servers_endpoint ON servers (scheme, host, port);

-- 操作ログにサーバーを記録する。既存行(0001 の時点の行)は NULL。
-- 書き込み操作の行で NULL = 対象サーバー不明(複数サーバー対応前の行)。login / logout はサーバーに関係しないので常に NULL
ALTER TABLE audit_log ADD COLUMN server_id INTEGER;
-- 操作時点のサーバーの表示名(サーバーを削除・改名した後も読めるように残す)
ALTER TABLE audit_log ADD COLUMN server_name TEXT;

CREATE INDEX IF NOT EXISTS idx_audit_log_server ON audit_log (server_id, id);

-- 人数スナップショット(サーバーごと)。status_snapshots は bucket だけが主キーで 1 bucket に 1 行しか入らないため、
-- 複合キーの新テーブルに切り替える。旧 status_snapshots は以後書かず、保持期間(90 日)の掃除で自然に空になる
CREATE TABLE IF NOT EXISTS server_snapshots (
  -- servers.id(主キーに NULL を入れると重複判定が効かないため NOT NULL)。0 は旧「既定サーバー」用に予約していた値で、現在は使わない
  server_id       INTEGER NOT NULL,
  -- floor(unix 秒 / 300)。INSERT OR IGNORE でサーバーごとに 5 分に 1 行
  bucket          INTEGER NOT NULL,
  taken_at        INTEGER NOT NULL,
  players_current INTEGER,
  players_max     INTEGER,
  map             TEXT,
  PRIMARY KEY (server_id, bucket)
);

CREATE INDEX IF NOT EXISTS idx_server_snapshots_taken_at ON server_snapshots (taken_at);

-- パネル設定の変更ログ(サーバーの追加・変更・削除、管理者の登録)。
-- audit_log.event の CHECK は ALTER で変えられず、作り直しもしない方針のため別テーブルにする。
-- event は CHECK を付けず、コード側(src/types/api.ts の SETTINGS_EVENTS)で検証する(今後の設定イベントの追加でマイグレーションを要らなくするため)
CREATE TABLE IF NOT EXISTS settings_audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at  INTEGER NOT NULL,
  -- 'server_add' | 'server_update' | 'server_delete' | 'admin_register'
  event       TEXT    NOT NULL,
  operator    TEXT,
  session_tag TEXT,
  ip_hash     TEXT,
  -- 対象サーバー(servers.id。削除後も残す)と、その時点の表示名。admin_register は NULL
  server_id   INTEGER,
  server_name TEXT,
  -- 変更内容の JSON(サーバー: name / host / port / enabled と passwordChanged: boolean。admin_register: {})。
  -- パスワード・ハッシュ・暗号文・鍵は入れない
  params_json TEXT    NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_settings_audit_log_created_at ON settings_audit_log (created_at);
