-- スコア記録とキルフィード(第 1 段階: 観測モード)。docs/ARCHITECTURE.md 第 17 章・8.9〜8.13。2026-10-17。
-- 0001・0002 の表は稼働中のため**追加のみ**(既存テーブルの作り直し・列の削除・CHECK の変更はしない。8 章)。
-- 時刻はすべて UTC epoch ミリ秒(INTEGER)。
-- 受信用トークンは平文で保存しない(SHA-256 のハッシュのみ)。実際のホスト名・トークン・パスワードをこのファイル・テスト・ドキュメントに書かない。
-- 外部キーは張らない(サーバーを削除しても記録・ログは保持期間まで残す。15.2 と同じ)。

-- ------------------------------------------------------------
-- サーバーごとのスコア上限の設定値(設定タブで変更)。NULL = 既定(SCORE_CAP_DEFAULT = 100)。
-- RCON の status.scoreCap が取れる場合はそちらを優先する(17.5)
-- ------------------------------------------------------------
ALTER TABLE servers ADD COLUMN score_cap INTEGER CHECK (score_cap IS NULL OR score_cap BETWEEN 1 AND 100000);

-- ------------------------------------------------------------
-- 設定変更ログに確認トークンの nonce を足す(record_start / record_stop を prepare → execute の二段階で 1 回限りにするため。17.2)。
-- 既存の行・サーバー設定の行は NULL(NULL 同士は UNIQUE に掛からない)
-- ------------------------------------------------------------
ALTER TABLE settings_audit_log ADD COLUMN confirm_nonce TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_settings_audit_log_nonce ON settings_audit_log (confirm_nonce);

-- ------------------------------------------------------------
-- スコア記録(試合 1 つ = 1 行)。「記録を開始」で作り、終了条件(17.5)で ended にする
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS match_recordings (
  -- AUTOINCREMENT: 削除した id を再利用しない(feed_raw_events.recording_id・画面の選択が古い id を指し続けるため)
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  -- servers.id(削除後も残す)と開始時点の表示名
  server_id        INTEGER NOT NULL,
  server_name      TEXT,
  status           TEXT    NOT NULL DEFAULT 'recording' CHECK (status IN ('recording', 'ended')),
  started_at       INTEGER NOT NULL,
  ended_at         INTEGER,
  -- MatchEndReason(src/types/api.ts の MATCH_END_REASONS)。CHECK は付けずコードで検証(理由を足すときにマイグレーションを要らなくするため)
  end_reason       TEXT,
  -- 開始時点のマップ(RCON の生データ)。Cron はこれと status.map を比べてマップ変更を検出する
  map              TEXT,
  -- 判定に使う上限と出所('status' | 'setting' | 'default')。Cron が status.scoreCap を読めたらその値で更新することがある(17.5)
  score_cap        INTEGER NOT NULL,
  score_cap_source TEXT    NOT NULL,
  -- 人数 0 を最初に観測した時刻(人数が 1 以上になったら NULL に戻す)。人数 0 が 10 分続いたら empty で終了
  empty_since      INTEGER,
  -- 終了時の最後の陣営スコア(FactionScore[] の JSON)。一覧の表示用。記録中は NULL(一覧は最後のサンプルから引く)
  last_scores_json TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

-- 1 サーバーにつき記録中は 1 つだけ(並行した「記録を開始」・二重送信を D1 で弾く)。Cron の「記録中の一覧」もこの索引で引ける
CREATE UNIQUE INDEX IF NOT EXISTS idx_match_recordings_active ON match_recordings (server_id) WHERE status = 'recording';
-- サーバーごとの一覧(新しい順)と、保持数を超えた試合の削除
CREATE INDEX IF NOT EXISTS idx_match_recordings_server ON match_recordings (server_id, id);

-- ------------------------------------------------------------
-- 試合の 1 分ごとのサンプル。主キー (recording_id, bucket_minute) で INSERT OR IGNORE(Cron が同じ分に 2 回動いても 1 行。17.3)
-- WITHOUT ROWID: 主キー以外の索引を持たないため、書き込みを 1 行分に抑える(要確認 C-17)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS match_samples (
  recording_id        INTEGER NOT NULL,
  -- floor(unix 秒 / 60)。Cron は scheduledTime から、開始時は実行時刻から求める
  bucket_minute       INTEGER NOT NULL,
  taken_at            INTEGER NOT NULL,
  map                 TEXT,
  players_current     INTEGER,
  players_max         INTEGER,
  -- status.factionScores(FactionScore[] の JSON。最大 MATCH_FACTIONS_MAX 件。陣営名は RCON の生データ)
  faction_scores_json TEXT    NOT NULL DEFAULT '[]',
  -- GET /v1/players の players[].cash の合計(取れなければ NULL。cash の意味は要確認 R-22)
  cash_total          REAL,
  -- players[].faction ごとの人数と cash の合計(FactionStat[] の JSON。取れなければ '[]')
  faction_stats_json  TEXT    NOT NULL DEFAULT '[]',
  PRIMARY KEY (recording_id, bucket_minute)
) WITHOUT ROWID;

-- ------------------------------------------------------------
-- キルフィードの受信設定(サーバーごと。トークンを発行したときに作り、取り消し・サーバー削除で消す)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS server_feeds (
  -- servers.id
  server_id            INTEGER PRIMARY KEY,
  -- 'sha256$<SHA-256(トークン全体) の base64url>'。平文は保存しない(発行時の応答で 1 回だけ返す)
  token_hash           TEXT    NOT NULL,
  -- トークンの末尾 4 文字(画面でどのトークンかを見分ける用。秘密ではない)
  token_hint           TEXT    NOT NULL,
  token_created_at     INTEGER NOT NULL,
  -- 0 = 受けて捨てる(204)。ゲーム側の送信は止まらない(止めるには ServerSettings.ini から Url を消す。17.6)
  enabled              INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  -- 受信の状況(画面の確認用)。D1 への反映は isolate ごとに 1 分に 1 回まで(書き込み枠の節約)
  last_received_at     INTEGER,
  last_stored_at       INTEGER,
  last_rejected_at     INTEGER,
  -- FeedRejectReason(CHECK なし。コードで検証)
  last_rejected_reason TEXT,
  last_dropped_at      INTEGER,
  -- FeedDropReason(CHECK なし)
  last_dropped_reason  TEXT,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL
);

-- ------------------------------------------------------------
-- 受信した生データ(観測モード。本文は JSON 文字列のまま。保持 FEED_RETENTION_DAYS = 7 日)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS feed_raw_events (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  server_id    INTEGER NOT NULL,
  received_at  INTEGER NOT NULL,
  -- 本文のバイト数(FEED_MAX_BODY_BYTES 以下)
  bytes        INTEGER NOT NULL,
  -- 配列の長さ、または events 配列の長さ。分からなければ NULL
  event_count  INTEGER,
  -- 受信時に記録中だった試合(match_recordings.id)。無ければ NULL
  recording_id INTEGER,
  body         TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_feed_raw_events_server ON feed_raw_events (server_id, id);
CREATE INDEX IF NOT EXISTS idx_feed_raw_events_received_at ON feed_raw_events (received_at);

-- ------------------------------------------------------------
-- 受信の日次カウンタ(保存した件数と本文の合計。上限の判定に使う)。server_id = 0 は全サーバーの合計
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS feed_daily (
  server_id INTEGER NOT NULL,
  -- floor(epoch ミリ秒 / 86,400,000)(UTC の日。Cloudflare の無料枠のリセットと同じ区切り)
  day       INTEGER NOT NULL,
  batches   INTEGER NOT NULL DEFAULT 0,
  bytes     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (server_id, day)
) WITHOUT ROWID;
