import { describe, expect, it } from 'vitest';
import { parseAuditQuery, validateActionRequest, validateMessage, validateReason } from './validate';

const SID = '00000000000000001';
const LS = String.fromCharCode(0x2028);

describe('validate', () => {
  it('kick: Steam ID 形式と理由の正規化(余分な項目は捨てる)', () => {
    expect(validateActionRequest({ action: 'kick', params: { steamId: SID, reason: '  暴言  ', extra: 1 } })).toEqual({
      ok: true,
      request: { action: 'kick', params: { steamId: SID, reason: '暴言' } },
    });
    expect(validateActionRequest({ action: 'kick', params: { steamId: SID, reason: '   ' } })).toEqual({
      ok: true,
      request: { action: 'kick', params: { steamId: SID } },
    });
    expect(validateActionRequest({ action: 'kick', params: { steamId: '123' } })).toEqual({ ok: false, fields: { steamId: 'invalid_format' } });
    expect(validateActionRequest({ action: 'kick', params: {} })).toEqual({ ok: false, fields: { steamId: 'required' } });
    expect(validateActionRequest({ action: 'kick', params: { steamId: Number('76561198000000000') } })).toEqual({
      ok: false,
      fields: { steamId: 'invalid_format' },
    });
  });

  it('action・params の形', () => {
    expect(validateActionRequest(null)).toEqual({ ok: false, fields: { action: 'required' } });
    expect(validateActionRequest({ action: 'kill', params: {} })).toEqual({ ok: false, fields: { action: 'invalid_format' } });
    expect(validateActionRequest({ action: 'broadcast', params: 'x' })).toEqual({ ok: false, fields: { params: 'invalid_format' } });
    expect(validateActionRequest({ action: 'match_end', params: { anything: 1 } })).toEqual({
      ok: true,
      request: { action: 'match_end', params: {} },
    });
  });

  it('broadcast / message: 1〜256 文字、改行・制御文字不可', () => {
    expect(validateMessage('  こんにちは  ')).toEqual({ ok: true, value: 'こんにちは' });
    expect(validateMessage('a'.repeat(256))).toEqual({ ok: true, value: 'a'.repeat(256) });
    expect(validateMessage('😀'.repeat(256)).ok).toBe(true);
    expect(validateMessage('a'.repeat(257))).toEqual({ ok: false, issue: 'too_long' });
    expect(validateMessage('a\nb')).toEqual({ ok: false, issue: 'invalid_characters' });
    expect(validateMessage(`a${LS}b`)).toEqual({ ok: false, issue: 'invalid_characters' });
    expect(validateMessage('a\u0007')).toEqual({ ok: false, issue: 'invalid_characters' });
    expect(validateMessage('   ')).toEqual({ ok: false, issue: 'required' });
    expect(validateMessage(undefined)).toEqual({ ok: false, issue: 'required' });
    expect(validateMessage(5)).toEqual({ ok: false, issue: 'invalid_format' });
    expect(validateActionRequest({ action: 'message', params: { steamId: SID } })).toEqual({ ok: false, fields: { message: 'required' } });
  });

  it('理由は 200 文字まで', () => {
    expect(validateReason('a'.repeat(200)).ok).toBe(true);
    expect(validateReason('a'.repeat(201))).toEqual({ ok: false, issue: 'too_long' });
    expect(validateReason(undefined)).toEqual({ ok: true, value: undefined });
  });

  it('map の id 形式', () => {
    expect(validateActionRequest({ action: 'map', params: { map: 'Map_01/Night.v2-a' } }).ok).toBe(true);
    expect(validateActionRequest({ action: 'map', params: { map: 'bad map' } })).toEqual({ ok: false, fields: { map: 'invalid_format' } });
    expect(validateActionRequest({ action: 'map', params: { map: 'a'.repeat(129) } })).toEqual({ ok: false, fields: { map: 'invalid_format' } });
  });

  it('/api/audit の kind / server / limit / before', () => {
    const q = (s: string) => parseAuditQuery(new URL(`https://x.test/api/audit${s}`), 100);
    expect(q('')).toEqual({ ok: true, kind: 'operations', server: 'all', limit: 50, before: null });
    expect(q('?limit=100&before=42')).toEqual({ ok: true, kind: 'operations', server: 'all', limit: 100, before: 42 });
    expect(q('?kind=settings&server=3')).toMatchObject({ ok: true, kind: 'settings', server: '3' });
    // 既定サーバー(default)は 2026-10-16 に廃止。形式不正(400)
    expect(q('?server=default')).toEqual({ ok: false, fields: { server: 'invalid_format' } });
    expect(q('?kind=x&server=03')).toEqual({ ok: false, fields: { kind: 'invalid_format', server: 'invalid_format' } });
    expect(q('?limit=0')).toEqual({ ok: false, fields: { limit: 'invalid_format' } });
    expect(q('?limit=101')).toEqual({ ok: false, fields: { limit: 'invalid_format' } });
    expect(q('?before=-1')).toEqual({ ok: false, fields: { before: 'invalid_format' } });
  });
});
