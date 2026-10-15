-- 複数サーバー対応。docs/ARCHITECTURE.md 第 15 章・8 章。
-- 本番は 0001_init.sql 適用済みで稼働中のため、**追加のみ**(既存テーブルの作り直し・列の削除・CHECK の変更はしない)。
-- 時刻はすべて UTC epoch ミリ秒(INTEGER)。RCON パスワードは平文で保存しない(AES-256-GCM で暗号化した文字列のみ)。
-- 実際のホスト名・ポート・パスワードをこのファイル・テスト・ドキュメントに書かない(例はダミーのみ)。

-- 画面から追加した RCON の接続先。Secrets の RCON_URL / RCON_PASSWORD による「既定サーバー」はここに入れない(id 'default')
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
  -- 'v1.<k>.<iv>.<ct>'(AES-256-GCM。k = 's' | 'a' は鍵の出所、iv 12 バイト、ct は暗号文 + タグ 16 バイト。いずれも base64url)
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

-- 操作ログにサーバーを記録する。既存行は NULL。
-- 書き込み操作の行(kick 等)で NULL = 既定サーバー(Secrets の RCON_URL)。login / logout はサーバーに関係しないので常に NULL
ALTER TABLE audit_log ADD COLUMN server_id INTEGER;
-- 操作時点のサーバーの表示名(サーバーを削除・改名した後も読めるように残す)。既定サーバーは NULL(画面がカタログで表示)
ALTER TABLE audit_log ADD COLUMN server_name TEXT;

CREATE INDEX IF NOT EXISTS idx_audit_log_server ON audit_log (server_id, id);

-- 人数スナップショット(サーバーごと)。status_snapshots は bucket だけが主キーで 1 bucket に 1 行しか入らないため、
-- 複合キーの新テーブルに切り替える。旧 status_snapshots は以後書かず、保持期間(90 日)の掃除で自然に空になる
CREATE TABLE IF NOT EXISTS server_snapshots (
  -- servers.id。既定サーバーは 0(主キーに NULL を入れると重複判定が効かないため、NULL ではなく 0 にする)
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

-- パネル設定の変更ログ(サーバーの追加・変更・削除)。
-- audit_log.event の CHECK は ALTER で変えられず、作り直しもしない方針のため別テーブルにする。
-- event は CHECK を付けず、コード側(src/types/api.ts の SETTINGS_EVENTS)で検証する(今後の設定イベントの追加でマイグレーションを要らなくするため)
CREATE TABLE IF NOT EXISTS settings_audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at  INTEGER NOT NULL,
  -- 'server_add' | 'server_update' | 'server_delete'
  event       TEXT    NOT NULL,
  operator    TEXT,
  session_tag TEXT,
  ip_hash     TEXT,
  -- 対象サーバー(servers.id。削除後も残す)と、その時点の表示名
  server_id   INTEGER,
  server_name TEXT,
  -- 変更内容の JSON(name / host / port / enabled と passwordChanged: boolean)。パスワード・暗号文は入れない
  params_json TEXT    NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_settings_audit_log_created_at ON settings_audit_log (created_at);
