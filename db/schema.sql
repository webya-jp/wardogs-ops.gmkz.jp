-- wardogs-ops の現行スキーマ(参照用のまとめ)。docs/ARCHITECTURE.md 第 5 章・第 8 章・第 15 章。
-- 本番への適用は db/migrations/ を `wrangler d1 migrations apply DB --remote` で行う。
-- このファイルは migrations をすべて適用した後の状態と一致させること(0001_init.sql + 0002_servers.sql)。
-- 列の順序は ALTER TABLE ADD COLUMN の結果(末尾に追加)に合わせてある。
-- 時刻はすべて UTC epoch ミリ秒(INTEGER)。

CREATE TABLE IF NOT EXISTS audit_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at      INTEGER NOT NULL,
  finished_at     INTEGER,
  event           TEXT    NOT NULL CHECK (event IN (
                    'kick', 'ban', 'unban', 'broadcast', 'message', 'map', 'match_end',
                    'login', 'logout'
                  )),
  status          TEXT    NOT NULL CHECK (status IN ('pending', 'succeeded', 'failed')),
  operator        TEXT,
  session_tag     TEXT,
  ip_hash         TEXT,
  target_steam_id TEXT,
  target_name     TEXT,
  params_json     TEXT    NOT NULL DEFAULT '{}',
  rcon_route      TEXT,
  rcon_status     INTEGER,
  error_code      TEXT,
  confirm_nonce   TEXT    UNIQUE,
  -- 0002: 書き込み操作で NULL = 対象サーバー不明(複数サーバー対応前の行)。login / logout は常に NULL
  server_id       INTEGER,
  -- 0002: 操作時点のサーバーの表示名
  server_name     TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log (created_at);
CREATE INDEX IF NOT EXISTS idx_audit_log_target ON audit_log (target_steam_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_log_server ON audit_log (server_id, id);

-- 0001 の人数スナップショット(サーバー 1 台時代)。0002 以降は書かない。90 日の掃除で空になる
CREATE TABLE IF NOT EXISTS status_snapshots (
  bucket          INTEGER PRIMARY KEY,
  taken_at        INTEGER NOT NULL,
  players_current INTEGER,
  players_max     INTEGER,
  map             TEXT
);

CREATE TABLE IF NOT EXISTS login_throttle (
  key          TEXT    PRIMARY KEY,
  window_start INTEGER NOT NULL,
  failures     INTEGER NOT NULL DEFAULT 0
);

-- 0002: 管理者(/setup で登録。password_hash は 'pbkdf2-sha256$<反復回数>$<salt>$<導出値>'。平文は保存しない)
CREATE TABLE IF NOT EXISTS admins (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  password_hash TEXT    NOT NULL,
  session_stamp TEXT    NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- 0002: パネルの設定(key / value)。instance_key(全鍵の元。API で返さない・消さない)
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT    PRIMARY KEY,
  value      TEXT    NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 0002: 画面から追加した RCON の接続先(rcon_password_enc は 'v2.<iv>.<ct>'。平文は保存しない)
CREATE TABLE IF NOT EXISTS servers (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  name              TEXT    NOT NULL,
  host              TEXT    NOT NULL,
  port              INTEGER NOT NULL CHECK (port BETWEEN 1 AND 65535),
  scheme            TEXT    NOT NULL DEFAULT 'http' CHECK (scheme IN ('http', 'https')),
  rcon_password_enc TEXT    NOT NULL,
  enabled           INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  sort_order        INTEGER NOT NULL DEFAULT 0,
  last_test_at      INTEGER,
  last_test_result  TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_servers_name ON servers (name);
CREATE UNIQUE INDEX IF NOT EXISTS idx_servers_endpoint ON servers (scheme, host, port);

-- 0002: 人数スナップショット(サーバーごと。server_id = servers.id)
CREATE TABLE IF NOT EXISTS server_snapshots (
  server_id       INTEGER NOT NULL,
  bucket          INTEGER NOT NULL,
  taken_at        INTEGER NOT NULL,
  players_current INTEGER,
  players_max     INTEGER,
  map             TEXT,
  PRIMARY KEY (server_id, bucket)
);

CREATE INDEX IF NOT EXISTS idx_server_snapshots_taken_at ON server_snapshots (taken_at);

-- 0002: パネル設定の変更ログ(server_add / server_update / server_delete / admin_register。event は CHECK なし。コードで検証)
CREATE TABLE IF NOT EXISTS settings_audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at  INTEGER NOT NULL,
  event       TEXT    NOT NULL,
  operator    TEXT,
  session_tag TEXT,
  ip_hash     TEXT,
  server_id   INTEGER,
  server_name TEXT,
  params_json TEXT    NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_settings_audit_log_created_at ON settings_audit_log (created_at);
