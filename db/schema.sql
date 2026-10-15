-- wardogs-ops の現行スキーマ(参照用のまとめ)。docs/ARCHITECTURE.md 第 8 章。
-- 本番への適用は db/migrations/ を `wrangler d1 migrations apply DB --remote` で行う。
-- このファイルは migrations をすべて適用した後の状態と一致させること(現在は 0001_init.sql のみ)。
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
  confirm_nonce   TEXT    UNIQUE
);

CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log (created_at);
CREATE INDEX IF NOT EXISTS idx_audit_log_target ON audit_log (target_steam_id, created_at);

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
