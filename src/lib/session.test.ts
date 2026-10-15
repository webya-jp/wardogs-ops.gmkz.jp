import { describe, expect, it } from 'vitest';
import { SESSION_TTL_MS } from '../types/api';
import { deriveKeysFrom } from './keys';
import { issueSession, readCookie, sanitizeOperator, serializeSessionCookie, verifySession } from './session';

const PW = 'test-admin-password-0123456789';
const NOW = 1_800_000_000_000;

describe('session', () => {
  it('発行した Cookie を検証できる', async () => {
    const keys = await deriveKeysFrom('', PW);
    const { value, data } = await issueSession(keys.session, { operator: '運営A', now: NOW });
    const v = await verifySession(keys.session, value, NOW + 1000);
    expect(v).toEqual(data);
    expect(v?.operator).toBe('運営A');
    expect(v?.exp).toBe(NOW + SESSION_TTL_MS);
  });

  it('改ざんされた Cookie は拒否する', async () => {
    const keys = await deriveKeysFrom('', PW);
    const { value } = await issueSession(keys.session, { now: NOW });
    const parts = value.split('.');
    const longer = [...parts];
    longer[3] = String(Number(parts[3]) + 1000);
    expect(await verifySession(keys.session, longer.join('.'), NOW)).toBeNull();
    const sig = parts[5] ?? '';
    const flipped = [...parts.slice(0, 5), (sig[0] === 'A' ? 'B' : 'A') + sig.slice(1)].join('.');
    expect(await verifySession(keys.session, flipped, NOW)).toBeNull();
    const otherOp = [...parts];
    otherOp[4] = 'YWRtaW4';
    expect(await verifySession(keys.session, otherOp.join('.'), NOW)).toBeNull();
    expect(await verifySession(keys.session, 'garbage', NOW)).toBeNull();
    expect(await verifySession(keys.session, '', NOW)).toBeNull();
    expect(await verifySession(keys.session, null, NOW)).toBeNull();
  });

  it('鍵が変わる(パスワード変更・SESSION_SECRET 追加)と通らない', async () => {
    const a = await deriveKeysFrom('', PW);
    const b = await deriveKeysFrom('', `${PW}x`);
    const c = await deriveKeysFrom('s'.repeat(32), PW);
    const { value } = await issueSession(a.session, { now: NOW });
    expect(await verifySession(b.session, value, NOW)).toBeNull();
    expect(await verifySession(c.session, value, NOW)).toBeNull();
  });

  it('期限切れ・未来の発行時刻は拒否する', async () => {
    const keys = await deriveKeysFrom('', PW);
    const { value } = await issueSession(keys.session, { now: NOW });
    expect(await verifySession(keys.session, value, NOW + SESSION_TTL_MS - 1)).not.toBeNull();
    expect(await verifySession(keys.session, value, NOW + SESSION_TTL_MS)).toBeNull();
    expect(await verifySession(keys.session, value, NOW - 10 * 60 * 1000)).toBeNull();
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
