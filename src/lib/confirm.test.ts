import { describe, expect, it } from 'vitest';
import { CONFIRM_TTL_MS } from '../types/api';
import { canonicalJson, claimNonceInMemory, issueConfirmToken, verifyConfirmToken } from './confirm';
import { deriveKeysFrom } from './keys';

const SID = 'AAAAAAAAAAAAAAAAAAAAAA';
const NOW = 1_800_000_000_000;
const params = { steamId: '00000000000000001', reason: 'test' };

describe('confirm', () => {
  it('canonicalJson はキー順に依存しない', () => {
    expect(canonicalJson({ b: 1, a: 'x' })).toBe(canonicalJson({ a: 'x', b: 1 }));
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
  });

  it('発行したトークンを検証できる(params のキー順が違っても同じ)', async () => {
    const keys = await deriveKeysFrom('', 'pw-pw-pw-pw-pw-pw-pw');
    const t = await issueConfirmToken(keys.confirm, { action: 'kick', params, sid: SID, targetName: 'Alice', now: NOW });
    expect(t.expiresAt).toBe(NOW + CONFIRM_TTL_MS);
    const r = await verifyConfirmToken(keys.confirm, t.token, {
      action: 'kick',
      params: { reason: 'test', steamId: params.steamId },
      sid: SID,
      now: NOW + 1,
    });
    expect(r).toEqual({ ok: true, nonce: t.nonce, targetName: 'Alice', expiresAt: t.expiresAt });
  });

  it('改ざん・別セッション・内容不一致・別の鍵は CONFIRM_INVALID、期限切れは CONFIRM_EXPIRED', async () => {
    const keys = await deriveKeysFrom('', 'pw-pw-pw-pw-pw-pw-pw');
    const t = await issueConfirmToken(keys.confirm, { action: 'kick', params, sid: SID, now: NOW });
    const base = { action: 'kick' as const, params, sid: SID, now: NOW + 1 };
    const invalid = { ok: false, code: 'CONFIRM_INVALID' };
    const parts = t.token.split('.');
    expect(await verifyConfirmToken(keys.confirm, `${parts[0]}.${parts[1]}x.${parts[2]}`, base)).toEqual(invalid);
    expect(await verifyConfirmToken(keys.confirm, 123, base)).toEqual(invalid);
    expect(await verifyConfirmToken(keys.confirm, '', base)).toEqual(invalid);
    expect(await verifyConfirmToken(keys.confirm, t.token, { ...base, sid: 'BBBBBBBBBBBBBBBBBBBBBB' })).toEqual(invalid);
    expect(await verifyConfirmToken(keys.confirm, t.token, { ...base, action: 'ban' })).toEqual(invalid);
    expect(await verifyConfirmToken(keys.confirm, t.token, { ...base, params: { ...params, reason: 'other' } })).toEqual(invalid);
    const other = await deriveKeysFrom('', 'another-password-xx');
    expect(await verifyConfirmToken(other.confirm, t.token, base)).toEqual(invalid);
    expect(await verifyConfirmToken(keys.confirm, t.token, { ...base, now: NOW + CONFIRM_TTL_MS })).toEqual({
      ok: false,
      code: 'CONFIRM_EXPIRED',
    });
  });

  it('検証の順序: 署名が正しくても内容が違えば期限切れより先に CONFIRM_INVALID', async () => {
    const keys = await deriveKeysFrom('', 'pw-pw-pw-pw-pw-pw-pw');
    const t = await issueConfirmToken(keys.confirm, { action: 'kick', params, sid: SID, now: NOW });
    const r = await verifyConfirmToken(keys.confirm, t.token, { action: 'unban', params, sid: SID, now: NOW + CONFIRM_TTL_MS * 2 });
    expect(r).toEqual({ ok: false, code: 'CONFIRM_INVALID' });
  });

  it('メモリの nonce は 1 回限り', () => {
    expect(claimNonceInMemory('n1', NOW + 1000, NOW)).toBe(true);
    expect(claimNonceInMemory('n1', NOW + 1000, NOW)).toBe(false);
    expect(claimNonceInMemory('n2', NOW + 1000, NOW)).toBe(true);
  });
});
