import { describe, expect, it } from 'vitest';
import { SESSION_TTL_MS } from '../types/api';
import { getAdminById } from './admins';
import { issueSession, readCookie, sanitizeOperator, serializeSessionCookie, verifySession } from './session';
import type { SessionAdmin } from './session';
import { testKeys } from './testing/keys';
import { makeD1 } from './testing/sqlite-d1';

const NOW = 1_800_000_000_000;
const ADMIN: SessionAdmin = { id: 1, session_stamp: 'stamp-AAAAAAAAAAAAAAAAAAAA' };
const lookupOf = (row: SessionAdmin | null) => async (aid: number) => (row && row.id === aid ? row : null);

describe('session(Cookie v2)', () => {
  it('発行した Cookie を検証できる。形式は v2.<aid>.<sid>.<iat>.<exp>.<op>.<sig>', async () => {
    const keys = await testKeys();
    const { value, data } = await issueSession(keys.session, ADMIN, { operator: '運営A', now: NOW });
    expect(value.split('.')).toHaveLength(7);
    expect(value.startsWith('v2.1.')).toBe(true);
    expect(value).not.toContain(ADMIN.session_stamp);
    const v = await verifySession(keys.session, value, lookupOf(ADMIN), NOW + 1000);
    expect(v).toEqual(data);
    expect(v).toMatchObject({ aid: 1, operator: '運営A', exp: NOW + SESSION_TTL_MS });
  });

  it('改ざんされた Cookie は拒否する(aid の差し替えを含む)', async () => {
    const keys = await testKeys();
    const { value } = await issueSession(keys.session, ADMIN, { now: NOW });
    const parts = value.split('.');
    const lookup = lookupOf(ADMIN);
    const longer = [...parts];
    longer[4] = String(Number(parts[4]) + 1000);
    expect(await verifySession(keys.session, longer.join('.'), lookup, NOW)).toBeNull();
    const sig = parts[6] ?? '';
    const flipped = [...parts.slice(0, 6), (sig[0] === 'A' ? 'B' : 'A') + sig.slice(1)].join('.');
    expect(await verifySession(keys.session, flipped, lookup, NOW)).toBeNull();
    const otherOp = [...parts];
    otherOp[5] = 'YWRtaW4';
    expect(await verifySession(keys.session, otherOp.join('.'), lookup, NOW)).toBeNull();
    // 別の管理者(同じ stamp を持つと仮定しても)に付け替えると署名が合わない
    const otherAid = [...parts];
    otherAid[1] = '2';
    expect(await verifySession(keys.session, otherAid.join('.'), async () => ({ id: 2, session_stamp: ADMIN.session_stamp }), NOW)).toBeNull();
    for (const bad of ['garbage', '', null, value.replace(/^v2\./, 'v1.'), parts.slice(0, 6).join('.')]) {
      expect(await verifySession(keys.session, bad, lookup, NOW)).toBeNull();
    }
  });

  it('旧形式(v1)の Cookie は形式不正', async () => {
    const keys = await testKeys();
    const v1 = 'v1.AAAAAAAAAAAAAAAAAAAAAA.1.43200001..AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    expect(await verifySession(keys.session, v1, lookupOf(ADMIN), NOW)).toBeNull();
  });

  it('session_stamp が変わる・管理者の行が無い・鍵(instance_key)が変わると通らない', async () => {
    const keys = await testKeys(1);
    const { value } = await issueSession(keys.session, ADMIN, { now: NOW });
    expect(await verifySession(keys.session, value, lookupOf({ ...ADMIN, session_stamp: 'changed' }), NOW)).toBeNull();
    expect(await verifySession(keys.session, value, lookupOf(null), NOW)).toBeNull();
    expect(await verifySession((await testKeys(2)).session, value, lookupOf(ADMIN), NOW)).toBeNull();
  });

  it('D1 の admins を読む: 行を消して登録し直す(新しい id・stamp)と既存の Cookie は通らない', async () => {
    const db = await makeD1();
    const keys = await testKeys();
    await db.prepare(`INSERT INTO admins (password_hash, session_stamp, created_at, updated_at) VALUES ('x', 'stamp-1', 0, 0)`).run();
    const admin = (await getAdminById(db, 1))!;
    const { value } = await issueSession(keys.session, admin, { now: NOW });
    const lookup = (aid: number) => getAdminById(db, aid);
    expect(await verifySession(keys.session, value, lookup, NOW)).not.toBeNull();
    await db.prepare(`UPDATE admins SET session_stamp = 'stamp-2' WHERE id = 1`).run();
    expect(await verifySession(keys.session, value, lookup, NOW)).toBeNull();
    await db.prepare(`UPDATE admins SET session_stamp = 'stamp-1' WHERE id = 1`).run();
    expect(await verifySession(keys.session, value, lookup, NOW)).not.toBeNull();
    await db.prepare('DELETE FROM admins').run();
    await db.prepare(`INSERT INTO admins (password_hash, session_stamp, created_at, updated_at) VALUES ('x', 'stamp-1', 0, 0)`).run();
    // AUTOINCREMENT で id は 2 になる(削除した id を再利用しない)
    expect((await db.prepare('SELECT id FROM admins').first())?.id).toBe(2);
    expect(await verifySession(keys.session, value, lookup, NOW)).toBeNull();
  });

  it('期限切れ・未来の発行時刻は拒否する', async () => {
    const keys = await testKeys();
    const lookup = lookupOf(ADMIN);
    const { value } = await issueSession(keys.session, ADMIN, { now: NOW });
    expect(await verifySession(keys.session, value, lookup, NOW + SESSION_TTL_MS - 1)).not.toBeNull();
    expect(await verifySession(keys.session, value, lookup, NOW + SESSION_TTL_MS)).toBeNull();
    expect(await verifySession(keys.session, value, lookup, NOW - 10 * 60 * 1000)).toBeNull();
  });

  it('操作者名は制御文字を除き 32 文字に切る', () => {
    expect(sanitizeOperator('  a\nb\tc  ')).toBe('abc');
    expect(sanitizeOperator('あ'.repeat(40))).toBe('あ'.repeat(32));
    expect(sanitizeOperator('   ')).toBeNull();
    expect(sanitizeOperator(null)).toBeNull();
  });

  it('Cookie の属性と読み取り', () => {
    const prod = serializeSessionCookie('v', false);
    expect(prod.startsWith('__Host-wo_session=v; ')).toBe(true);
    for (const attr of ['HttpOnly', 'SameSite=Strict', 'Secure', 'Path=/', 'Max-Age=43200']) expect(prod).toContain(attr);
    expect(prod).not.toContain('Domain');
    expect(serializeSessionCookie('v', true)).not.toContain('Secure');
    const req = new Request('https://x.test/', { headers: { Cookie: 'a=1; __Host-wo_session=abc.def; b=2' } });
    expect(readCookie(req, '__Host-wo_session')).toBe('abc.def');
    expect(readCookie(req, 'zzz')).toBeNull();
  });
});
