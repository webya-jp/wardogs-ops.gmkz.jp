-- wardogs-ops 初期スキーマ。docs/ARCHITECTURE.md 第 8 章。
-- 時刻はすべて UTC epoch ミリ秒(INTEGER)。画面で JST に変換する。
-- 生の IP アドレス・パスワード・Cookie・RCON の接続先は保存しない。

-- 操作の監査ログ(誰が・いつ・何を・結果)
CREATE TABLE IF NOT EXISTS audit_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at      INTEGER NOT NULL,
  finished_at     INTEGER,
  event           TEXT    NOT NULL CHECK (event IN (
                    'kick', 'ban', 'unban', 'broadcast', 'message', 'map', 'match_end',
                    'login', 'logout'
                  )),
  status          TEXT    NOT NULL CHECK (status IN ('pending', 'succeeded', 'failed')),
  -- ログイン時に入力した操作者名(自己申告。任意)
  operator        TEXT,
  -- セッション ID の先頭 8 文字
  session_tag     TEXT,
  -- 接続元 IP の HMAC(先頭 16 桁の 16 進)。生の IP は保存しない
  ip_hash         TEXT,
  target_steam_id TEXT,
  -- 操作時点のプレイヤー名(BAN 一覧で名前を補完するために残す)
  target_name     TEXT,
  -- 検証済みパラメータの JSON。表示文言は保存しない(画面が event + params からロケールに応じて組み立てる)
  params_json     TEXT    NOT NULL DEFAULT '{}',
  -- 呼んだ RCON ルート("POST /v1/broadcast" の形。接続先ホストは含めない)
  rcon_route      TEXT,
  rcon_status     INTEGER,
  error_code      TEXT,
  -- 確認トークンの nonce。UNIQUE で同じトークンの 2 回目の実行を防ぐ(login/logout は NULL)
  confirm_nonce   TEXT    UNIQUE
);

CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log (created_at);
CREATE INDEX IF NOT EXISTS idx_audit_log_target ON audit_log (target_steam_id, created_at);

-- 人数スナップショット(読み取り時の間引き記録。5 分に 1 行まで)
CREATE TABLE IF NOT EXISTS status_snapshots (
  -- floor(unix 秒 / 300)。INSERT OR IGNORE で 5 分に 1 行に間引く
  bucket          INTEGER PRIMARY KEY,
  taken_at        INTEGER NOT NULL,
  players_current INTEGER,
  players_max     INTEGER,
  map             TEXT
);

-- ログイン失敗の回数(固定窓のレート制限)
CREATE TABLE IF NOT EXISTS login_throttle (
  -- 'ip:<HMAC 先頭 16 桁>' または 'global'
  key          TEXT    PRIMARY KEY,
  -- 窓の開始(UTC epoch ミリ秒)
  window_start INTEGER NOT NULL,
  failures     INTEGER NOT NULL DEFAULT 0
);
