import { describe, expect, it } from 'vitest';
import { CONFIRM_TTL_MS } from '../types/api';
import { canonicalJson, confirmTokenBaseValid, issueConfirmToken, verifyConfirmToken } from './confirm';
import { bytesToB64url, hmac, utf8ToB64url } from './keys';
import { testKeys } from './testing/keys';

const SID = 'AAAAAAAAAAAAAAAAAAAAAA';
const NOW = 1_800_000_000_000;
const params = { steamId: '00000000000000001', reason: 'test' };
const SV = '3';
const URL_A = 'http://rcon-a.example.com:7777';
const URL_B = 'http://rcon-b.example.com:7777';
const target = { server: SV, baseUrl: URL_A };

describe('confirm', () => {
  it('canonicalJson はキー順に依存しない', () => {
    expect(canonicalJson({ b: 1, a: 'x' })).toBe(canonicalJson({ a: 'x', b: 1 }));
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
  });

  it('発行したトークンを検証できる(params のキー順が違っても同じ)', async () => {
    const keys = await testKeys(1);
    const t = await issueConfirmToken(keys.confirm, { action: 'kick', params, sid: SID, targetName: 'Alice', ...target, now: NOW });
    expect(t.expiresAt).toBe(NOW + CONFIRM_TTL_MS);
    // baseUrl そのものはトークンに入れない(ハッシュだけ)
    expect(atob(t.token.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/'))).not.toContain('example.com');
    const r = await verifyConfirmToken(keys.confirm, t.token, {
      action: 'kick',
      params: { reason: 'test', steamId: params.steamId },
      sid: SID,
      ...target,
      now: NOW + 1,
    });
    expect(r).toEqual({ ok: true, nonce: t.nonce, targetName: 'Alice', expiresAt: t.expiresAt });
  });

  it('改ざん・別セッション・内容不一致・別の鍵は CONFIRM_INVALID、期限切れは CONFIRM_EXPIRED', async () => {
    const keys = await testKeys(1);
    const t = await issueConfirmToken(keys.confirm, { action: 'kick', params, sid: SID, ...target, now: NOW });
    const base = { action: 'kick' as const, params, sid: SID, ...target, now: NOW + 1 };
    const invalid = { ok: false, code: 'CONFIRM_INVALID' };
    const parts = t.token.split('.');
    expect(await verifyConfirmToken(keys.confirm, `${parts[0]}.${parts[1]}x.${parts[2]}`, base)).toEqual(invalid);
    expect(await verifyConfirmToken(keys.confirm, 123, base)).toEqual(invalid);
    expect(await verifyConfirmToken(keys.confirm, '', base)).toEqual(invalid);
    expect(await verifyConfirmToken(keys.confirm, t.token, { ...base, sid: 'BBBBBBBBBBBBBBBBBBBBBB' })).toEqual(invalid);
    expect(await verifyConfirmToken(keys.confirm, t.token, { ...base, action: 'ban' })).toEqual(invalid);
    expect(await verifyConfirmToken(keys.confirm, t.token, { ...base, params: { ...params, reason: 'other' } })).toEqual(invalid);
    const other = await testKeys(2);
    expect(await verifyConfirmToken(other.confirm, t.token, base)).toEqual(invalid);
    expect(await verifyConfirmToken(keys.confirm, t.token, { ...base, now: NOW + CONFIRM_TTL_MS })).toEqual({
      ok: false,
      code: 'CONFIRM_EXPIRED',
    });
  });

  it('別サーバーへのすり替え(sv)と、prepare 後の宛先の変更(sh)は CONFIRM_INVALID', async () => {
    const keys = await testKeys(1);
    const t = await issueConfirmToken(keys.confirm, { action: 'kick', params, sid: SID, ...target, now: NOW });
    const base = { action: 'kick' as const, params, sid: SID, now: NOW + 1 };
    const invalid = { ok: false, code: 'CONFIRM_INVALID' };
    // 別のサーバー id(宛先が同じでも)
    expect(await verifyConfirmToken(keys.confirm, t.token, { ...base, server: '4', baseUrl: URL_A })).toEqual(invalid);
    expect(await verifyConfirmToken(keys.confirm, t.token, { ...base, server: 'default', baseUrl: URL_A })).toEqual(invalid);
    // 同じ id で宛先(ホスト名・ポート)が変わった
    expect(await verifyConfirmToken(keys.confirm, t.token, { ...base, server: SV, baseUrl: URL_B })).toEqual(invalid);
    expect(await verifyConfirmToken(keys.confirm, t.token, { ...base, server: SV, baseUrl: 'http://rcon-a.example.com:7778' })).toEqual(invalid);
    // 期限切れでも、すり替えの方を先に判定する(順序 3' → 4)
    expect(await verifyConfirmToken(keys.confirm, t.token, { ...base, server: '4', baseUrl: URL_A, now: NOW + CONFIRM_TTL_MS })).toEqual(invalid);
    // 1〜3 だけなら通る(サーバーの解決に失敗したときに SERVER_* を返すための判定)
    expect(await confirmTokenBaseValid(keys.confirm, t.token, base)).toBe(true);
    expect(await confirmTokenBaseValid(keys.confirm, t.token, { ...base, action: 'ban' })).toBe(false);
  });

  it('sv の無い旧形式のトークン(署名は正しい)は CONFIRM_INVALID', async () => {
    const keys = await testKeys(1);
    const t = await issueConfirmToken(keys.confirm, { action: 'kick', params, sid: SID, ...target, now: NOW });
    const payload = JSON.parse(atob(t.token.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/'))) as Record<string, unknown>;
    delete payload.sv;
    delete payload.sh;
    const body = `v1.${utf8ToB64url(JSON.stringify(payload))}`;
    const legacy = `${body}.${bytesToB64url(await hmac(keys.confirm, body))}`;
    expect(await verifyConfirmToken(keys.confirm, legacy, { action: 'kick', params, sid: SID, ...target, now: NOW + 1 })).toEqual({
      ok: false,
      code: 'CONFIRM_INVALID',
    });
  });

  it('検証の順序: 署名が正しくても内容が違えば期限切れより先に CONFIRM_INVALID', async () => {
    const keys = await testKeys(1);
    const t = await issueConfirmToken(keys.confirm, { action: 'kick', params, sid: SID, ...target, now: NOW });
    const r = await verifyConfirmToken(keys.confirm, t.token, { action: 'unban', params, sid: SID, ...target, now: NOW + CONFIRM_TTL_MS * 2 });
    expect(r).toEqual({ ok: false, code: 'CONFIRM_INVALID' });
  });
});
