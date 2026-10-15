// 人数スナップショット(読み取り時の間引き)。docs/ARCHITECTURE.md 4.4・8.2・15.6。
// /api/status が RCON から状態を取れたときだけ、(server_id, bucket = floor(unix 秒 / 300)) を主キーに
// server_snapshots へ INSERT OR IGNORE(サーバーごとに 5 分に最大 1 行)。既定サーバーの server_id は 0。
// プレイヤー情報は入れない(人数とマップだけ)。旧 status_snapshots は以後書かない。
import type { ServerId, StatusResponse } from '../types/api';
import { snapshotServerIdOf } from './servers';

export const SNAPSHOT_BUCKET_SEC = 300;

export function snapshotBucket(nowMs: number): number {
  return Math.floor(nowMs / 1000 / SNAPSHOT_BUCKET_SEC);
}

/** この isolate で記録済みの bucket(サーバーごと。同じ bucket では D1 を呼ばない) */
const lastBucket = new Map<number, number>();
const MAX_TRACKED = 64;

export function resetSnapshotsForTest(): void {
  lastBucket.clear();
}

export async function recordSnapshot(db: D1Database, server: ServerId, status: StatusResponse, now = Date.now()): Promise<void> {
  const serverId = snapshotServerIdOf(server);
  const bucket = snapshotBucket(now);
  if (lastBucket.get(serverId) === bucket) return;
  await db
    .prepare(
      `INSERT OR IGNORE INTO server_snapshots (server_id, bucket, taken_at, players_current, players_max, map)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    )
    .bind(serverId, bucket, now, status.players.current, status.players.max, status.map)
    .run();
  lastBucket.delete(serverId);
  lastBucket.set(serverId, bucket);
  if (lastBucket.size > MAX_TRACKED) {
    const first = lastBucket.keys().next();
    if (!first.done) lastBucket.delete(first.value);
  }
}
