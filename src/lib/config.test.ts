import { describe, expect, it } from 'vitest';
import { checkConfig, collectWarnings, getDefaultServerState, getFeatures, parseRconUrl, probeD1, resetD1Cache } from './config';
import { normalizeIp } from './keys';
import { makeD1 } from './testing/sqlite-d1';

const good = {
  ADMIN_PASSWORD: 'a'.repeat(20),
  RCON_URL: 'http://rcon.example.com:7776',
  RCON_PASSWORD: 'b'.repeat(32),
} as const;
const env = (o: Record<string, string | undefined>) => ({ ASSETS: {} as Fetcher, ...o });

describe('config', () => {
  it('RCON_URL の検証', () => {
    expect(parseRconUrl('http://rcon.example.com:7776/')).toEqual({ ok: true, baseUrl: 'http://rcon.example.com:7776' });
    expect(parseRconUrl('https://proxy.example.com/rcon/')).toEqual({ ok: true, baseUrl: 'https://proxy.example.com/rcon' });
    // ポートは任意(提供元ごとに 7776 以外もある)
    expect(parseRconUrl('http://rcon.example.com:7789')).toEqual({ ok: true, baseUrl: 'http://rcon.example.com:7789' });
    expect(parseRconUrl('')).toEqual({ ok: false, warning: 'RCON_URL_MISSING' });
    expect(parseRconUrl('rcon.example.com:7776')).toEqual({ ok: false, warning: 'RCON_URL_INVALID' });
    expect(parseRconUrl('ftp://x.example.com')).toEqual({ ok: false, warning: 'RCON_URL_INVALID' });
    expect(parseRconUrl('http://u:p@x.example.com')).toEqual({ ok: false, warning: 'RCON_URL_HAS_CREDENTIALS' });
    expect(parseRconUrl('http://192.0.2.10:7776')).toEqual({ ok: false, warning: 'RCON_URL_IS_IP_ADDRESS' });
    expect(parseRconUrl('http://[2001:db8::1]:7776')).toEqual({ ok: false, warning: 'RCON_URL_IS_IP_ADDRESS' });
    // 10 進 1 語・16 進表記も IPv4 とみなす
    expect(parseRconUrl('http://3221225994:7776')).toEqual({ ok: false, warning: 'RCON_URL_IS_IP_ADDRESS' });
    expect(parseRconUrl('http://0xC000020A:7776')).toEqual({ ok: false, warning: 'RCON_URL_IS_IP_ADDRESS' });
    expect(parseRconUrl('http://x.example.com/?a=1')).toEqual({ ok: false, warning: 'RCON_URL_INVALID' });
  });

  it('ログインに必須なのは ADMIN_PASSWORD だけ(RCON 系はログインを止めない警告)', () => {
    expect(checkConfig(env({ ...good }))).toEqual({ ok: true, missing: [], warnings: [] });
    // 既定サーバー無し(RCON 系が両方とも未設定)は正常。警告も出さない
    expect(checkConfig(env({ ADMIN_PASSWORD: good.ADMIN_PASSWORD }))).toEqual({ ok: true, missing: [], warnings: [] });
    const missing = checkConfig(env({}));
    expect(missing.ok).toBe(false);
    expect(missing.missing).toEqual(['ADMIN_PASSWORD']);
    expect(missing.warnings).toEqual(['ADMIN_PASSWORD_MISSING']);
    // 片方だけ・不正な RCON_URL はログインを止めない
    const onlyUrl = checkConfig(env({ ADMIN_PASSWORD: good.ADMIN_PASSWORD, RCON_URL: good.RCON_URL }));
    expect(onlyUrl).toEqual({ ok: true, missing: [], warnings: ['RCON_PASSWORD_MISSING'] });
    const onlyPw = checkConfig(env({ ADMIN_PASSWORD: good.ADMIN_PASSWORD, RCON_PASSWORD: good.RCON_PASSWORD }));
    expect(onlyPw).toEqual({ ok: true, missing: [], warnings: ['RCON_URL_MISSING'] });
    const ip = checkConfig(env({ ...good, RCON_URL: 'http://192.0.2.10:7776' }));
    expect(ip).toEqual({ ok: true, missing: [], warnings: ['RCON_URL_IS_IP_ADDRESS'] });
    expect(checkConfig(env({ ...good, RCON_URL: 'http://u:p@x.example.com' })).ok).toBe(true);
  });

  it('ADMIN_PASSWORD 系と SESSION_SECRET_TOO_SHORT だけがログインを止める', () => {
    expect(checkConfig(env({ ...good, ADMIN_PASSWORD: 'short' })).warnings).toContain('ADMIN_PASSWORD_TOO_SHORT');
    expect(checkConfig(env({ ...good, ADMIN_PASSWORD: 'short' })).ok).toBe(false);
    const same = checkConfig(env({ ...good, ADMIN_PASSWORD: good.RCON_PASSWORD }));
    expect(same.ok).toBe(false);
    expect(same.warnings).toContain('ADMIN_PASSWORD_EQUALS_RCON_PASSWORD');
    const weakRcon = checkConfig(env({ ...good, RCON_PASSWORD: 'c'.repeat(10) }));
    expect(weakRcon.ok).toBe(true);
    expect(weakRcon.warnings).toEqual(['RCON_PASSWORD_SHORT']);
    expect(checkConfig(env({ ...good, SESSION_SECRET: 'x' })).ok).toBe(false);
    expect(checkConfig(env({ ...good, SESSION_SECRET: 'x'.repeat(32) })).ok).toBe(true);
  });

  it('既定サーバーの状態', () => {
    expect(getDefaultServerState(env({}))).toEqual({ kind: 'none' });
    expect(getDefaultServerState(env({ ...good }))).toEqual({
      kind: 'ok',
      rcon: { baseUrl: 'http://rcon.example.com:7776', password: good.RCON_PASSWORD },
    });
    expect(getDefaultServerState(env({ RCON_URL: good.RCON_URL }))).toEqual({ kind: 'issue', warning: 'RCON_PASSWORD_MISSING' });
    expect(getDefaultServerState(env({ RCON_PASSWORD: 'x' }))).toEqual({ kind: 'issue', warning: 'RCON_URL_MISSING' });
    expect(getDefaultServerState(env({ RCON_URL: 'nope', RCON_PASSWORD: 'x' }))).toEqual({ kind: 'issue', warning: 'RCON_URL_INVALID' });
  });

  it('D1 の判定は 0002 の表・列まで含める(0001 だけなら not_migrated)', async () => {
    resetD1Cache();
    const old = await makeD1({ migrations: ['0001_init.sql'] });
    expect(await probeD1(old)).toBe('not_migrated');
    resetD1Cache();
    const s0 = await getFeatures({ ...env({ ...good }), DB: old });
    expect(s0.features).toEqual({ audit: false, snapshots: false, writes: false, servers: false });
    resetD1Cache();
    const cur = await makeD1();
    const s = await getFeatures({ ...env({ ...good }), DB: cur });
    expect(s.d1).toBe('ok');
    expect(s.features).toEqual({ audit: true, snapshots: true, writes: true, servers: true });
    expect(collectWarnings(checkConfig(env({ ...good })), s, true)).toEqual(['SERVER_PASSWORDS_UNREADABLE']);
    resetD1Cache();
  });

  it('IP の正規化(IPv6 は /64)', () => {
    expect(normalizeIp('203.0.113.5')).toBe('203.0.113.5');
    expect(normalizeIp('::ffff:203.0.113.5')).toBe('203.0.113.5');
    expect(normalizeIp('2001:db8:1:2:3:4:5:6')).toBe('2001:db8:1:2::/64');
    expect(normalizeIp('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(normalizeIp('2001:0DB8:0001:0002::')).toBe('2001:db8:1:2::/64');
  });
});
