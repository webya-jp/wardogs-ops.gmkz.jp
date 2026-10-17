-- キルフィード 第 2 段階(正規化したキルの保存)。docs/ARCHITECTURE.md 17.10・8.14。2026-10-17。
-- 0001〜0003 の表は稼働中のため**追加のみ**(既存テーブルの作り直し・列の削除・CHECK の変更はしない。8 章)。
-- 時刻はすべて UTC epoch ミリ秒(INTEGER)。
-- プレイヤー名・Steam ID を保存する(ログイン済みの運営者にだけ返す)。実際の名前・ID・ホスト名をこのファイル・テスト・ドキュメントに書かない。
-- 外部キーは張らない(15.2 と同じ)。

-- ------------------------------------------------------------
-- 正規化したキル(1 キル = 1 行)。受信時に生データ(本文)から作る(17.10.3)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS feed_kills (
  -- AUTOINCREMENT は付けない(1 行ごとに sqlite_sequence を書き換えて書き込みが増えるため)。
  -- 最大の id の行が消えると再利用され得るが、差分の取得は (received_at, id) の組で進めるため支障は無い
  id               INTEGER PRIMARY KEY,
  -- servers.id(削除後も、試合に属する行は試合の保持期間まで残す)
  server_id        INTEGER NOT NULL,
  -- 受信時に記録中だった試合(match_recordings.id)。0 = 記録外(NULL にしないのは索引の等号検索を 1 通りにするため)
  recording_id     INTEGER NOT NULL DEFAULT 0,
  received_at      INTEGER NOT NULL,
  -- イベント自体の時刻(本文にあれば)と、ゲーム内時刻(試合開始からの経過秒)
  event_at         INTEGER,
  game_time_sec    REAL,
  -- キラー(環境による死亡・読めないときは 3 列とも NULL)。steam_id は STEAM_ID_PATTERN に合うものだけ
  killer_name      TEXT,
  killer_steam_id  TEXT,
  killer_faction   TEXT,
  -- 陣営の出所('event' | 'roster')。CHECK は付けずコードで検証
  killer_faction_source TEXT,
  victim_name      TEXT,
  victim_steam_id  TEXT,
  victim_faction   TEXT,
  victim_faction_source TEXT,
  weapon_id        TEXT,
  weapon_name      TEXT,
  vehicle_id       TEXT,
  vehicle_name     TEXT,
  -- 印のビット: 1 = headshot、2 = penetration、4 = roadkill、8 = vehicleExplosion、16 = suicide(KILL_FLAGS の順)
  flags            INTEGER NOT NULL DEFAULT 0,
  -- 距離(m)。不明は NULL
  distance_m       REAL
);

-- 試合ごと(recording_id > 0)・記録外(0)の一覧と差分の取得(received_at, id の順)、試合の削除、記録外の保持期限の削除をこの 1 本で引く
CREATE INDEX IF NOT EXISTS idx_feed_kills_scope ON feed_kills (server_id, recording_id, received_at);

-- ------------------------------------------------------------
-- 陣営の付与に使う「直近のプレイヤー一覧の観測」。Cron がサンプルと同じ INSERT で書く(クエリは増やさない。17.10.4)。
-- 形: {"f":["<陣営名>",...],"p":{"<SteamID>":<f の添字>,...}}(名前は入れない。最大 KILLFEED_ROSTER_MAX_PLAYERS 人)。
-- /v1/players が取れない・陣営が無ければ NULL
-- ------------------------------------------------------------
ALTER TABLE match_samples ADD COLUMN roster_json TEXT;

-- ------------------------------------------------------------
-- 生データ(feed_raw_events)の保存を、キルの保存とは別に止められるようにする。1 = 保存する(第 1 段階と同じ)。
-- server_feeds.enabled = 0 のときは従来どおり両方とも保存しない
-- ------------------------------------------------------------
ALTER TABLE server_feeds ADD COLUMN raw_enabled INTEGER NOT NULL DEFAULT 1 CHECK (raw_enabled IN (0, 1));

-- ------------------------------------------------------------
-- 日次カウンタに正規化の件数を足す(server_id = 0 は全体)。kills は上限の判定にも使う。
-- other_events / incomplete は isolate 内で数えて 1 分に 1 回までまとめて足す(書き込み枠の節約。17.10.3)
-- ------------------------------------------------------------
ALTER TABLE feed_daily ADD COLUMN kills INTEGER NOT NULL DEFAULT 0;
ALTER TABLE feed_daily ADD COLUMN other_events INTEGER NOT NULL DEFAULT 0;
ALTER TABLE feed_daily ADD COLUMN incomplete INTEGER NOT NULL DEFAULT 0;
ALTER TABLE feed_daily ADD COLUMN dropped_kills INTEGER NOT NULL DEFAULT 0;

-- ------------------------------------------------------------
-- 試合・サーバーを消したら、属するキルも消す(トリガー。Cron・削除 API のクエリ数を増やさないため。17.10.9。D1 での動作は要確認 C-26)
-- - 試合(match_recordings)の削除: その試合のキル
-- - サーバー(servers)の削除: そのサーバーの記録外のキル(試合に属するキルは試合の保持に従う)
-- ------------------------------------------------------------
CREATE TRIGGER IF NOT EXISTS trg_match_recordings_delete_kills
AFTER DELETE ON match_recordings
BEGIN
  DELETE FROM feed_kills WHERE server_id = OLD.server_id AND recording_id = OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_servers_delete_unrecorded_kills
AFTER DELETE ON servers
BEGIN
  DELETE FROM feed_kills WHERE server_id = OLD.id AND recording_id = 0;
END;
