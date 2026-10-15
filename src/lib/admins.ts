// 管理者(D1 admins)の有無・取得・初期設定での登録・ハッシュの保存し直し。docs/ARCHITECTURE.md 5.1.1・5.2・8.7。
// - 登録は admins が 0 行のときだけ、条件付きの 1 文(INSERT … SELECT … WHERE NOT EXISTS)で行う。変更行数 0 = 先に誰かが登録した
// - 登録は settings_audit_log に admin_register として記録する(登録とは別に INSERT。記録の失敗で登録は取り消さない)
// パスワード・ハッシュ・session_stamp をログや戻り値(API 応答)に出さない。
import { SESSION_STAMP_BYTES } from '../types/env';
import { randomB64url } from './keys';
import { hashPassword, verifyPasswordHash } from './password';

export interface AdminRow {
  id: number;
  password_hash: string;
  session_stamp: string;
}

/** 管理者が 1 人以上登録されているか(キャッシュしない) */
export async function hasAdmin(db: D1Database): Promise<boolean> {
  return (await db.prepare('SELECT 1 AS x FROM admins LIMIT 1').first()) !== null;
}

/** ログイン Cookie の aid から主キーで読む(キャッシュしない。docs/ARCHITECTURE.md 5.3) */
export async function getAdminById(db: D1Database, id: number): Promise<AdminRow | null> {
  return db.prepare('SELECT id, password_hash, session_stamp FROM admins WHERE id = ?1').bind(id).first<AdminRow>();
}

/** ログインで検証する管理者(複数管理者は未実装のため id が最小の行。8.7) */
export async function getPrimaryAdmin(db: D1Database): Promise<AdminRow | null> {
  return db.prepare('SELECT id, password_hash, session_stamp FROM admins ORDER BY id LIMIT 1').first<AdminRow>();
}

/**
 * 入力が登録済みの管理パスワードのどれかと同じか(RCON パスワードの保存時に使う。PBKDF2 を管理者の行数分)。
 * 保存値が壊れている行は一致しないものとして扱う
 */
export async function isSameAsAdminPassword(db: D1Database, candidate: string): Promise<boolean> {
  const { results } = await db.prepare('SELECT password_hash FROM admins ORDER BY id').all<{ password_hash: string }>();
  for (const r of results ?? []) {
    if ((await verifyPasswordHash(candidate, r.password_hash)).ok) return true;
  }
  return false;
}

export type RegisterResult = { kind: 'registered' } | { kind: 'already_done' };

/**
 * 管理者を登録する(admins が 0 行のときだけ)。SQLite の 1 文は原子的で、D1 は書き込みを直列に実行するため、
 * 並行した 2 つの登録が両方成功することは無い(docs/ARCHITECTURE.md 5.1.1)
 */
export async function registerAdmin(
  db: D1Database,
  input: { password: string; now?: number; iterations?: number },
): Promise<RegisterResult> {
  const now = input.now ?? Date.now();
  const hash = await hashPassword(input.password, input.iterations);
  const r = await db
    .prepare(
      `INSERT INTO admins (password_hash, session_stamp, created_at, updated_at)
       SELECT ?1, ?2, ?3, ?3 WHERE NOT EXISTS (SELECT 1 FROM admins)`,
    )
    .bind(hash, randomB64url(SESSION_STAMP_BYTES), now)
    .run();
  return Number(r.meta?.changes ?? 0) > 0 ? { kind: 'registered' } : { kind: 'already_done' };
}

/** 登録の記録(operator / session_tag は NULL、ip_hash は登録した接続元、params は {}。8.6) */
export async function recordAdminRegister(db: D1Database, e: { now: number; ipHash: string | null }): Promise<void> {
  await db
    .prepare(
      `INSERT INTO settings_audit_log (created_at, event, operator, session_tag, ip_hash, server_id, server_name, params_json)
       VALUES (?1, 'admin_register', NULL, NULL, ?2, NULL, NULL, '{}')`,
    )
    .bind(e.now, e.ipHash)
    .run();
}

/**
 * ログイン成功時、保存値の反復回数が現在の値と違えば新しい salt・回数で保存し直す(session_stamp は変えない = 追い出さない)。
 * 途中で別の変更があった行は上書きしない(WHERE で旧値を照合)
 */
export async function rehashAdminPassword(db: D1Database, admin: AdminRow, password: string, now = Date.now()): Promise<void> {
  const next = await hashPassword(password);
  await db
    .prepare('UPDATE admins SET password_hash = ?1, updated_at = ?2 WHERE id = ?3 AND password_hash = ?4')
    .bind(next, now, admin.id, admin.password_hash)
    .run();
}
