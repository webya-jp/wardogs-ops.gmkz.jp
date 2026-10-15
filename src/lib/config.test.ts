import { describe, expect, it } from 'vitest';
import { checkConfig, parseRconUrl } from './config';
import { normalizeIp } from './keys';

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

  it('必須 Secrets と強度', () => {
    expect(checkConfig(env({ ...good }))).toEqual({ ok: true, missing: [], warnings: [] });
    const missing = checkConfig(env({}));
    expect(missing.ok).toBe(false);
    expect(missing.missing).toEqual(['ADMIN_PASSWORD', 'RCON_URL', 'RCON_PASSWORD']);
    expect(checkConfig(env({ ...good, ADMIN_PASSWORD: 'short' })).warnings).toContain('ADMIN_PASSWORD_TOO_SHORT');
    const same = checkConfig(env({ ...good, ADMIN_PASSWORD: good.RCON_PASSWORD }));
    expect(same.ok).toBe(false);
    expect(same.warnings).toContain('ADMIN_PASSWORD_EQUALS_RCON_PASSWORD');
    const weakRcon = checkConfig(env({ ...good, RCON_PASSWORD: 'c'.repeat(10) }));
    expect(weakRcon.ok).toBe(true);
    expect(weakRcon.warnings).toEqual(['RCON_PASSWORD_SHORT']);
    expect(checkConfig(env({ ...good, SESSION_SECRET: 'x' })).ok).toBe(false);
    expect(checkConfig(env({ ...good, SESSION_SECRET: 'x'.repeat(32) })).ok).toBe(true);
  });

  it('IP の正規化(IPv6 は /64)', () => {
    expect(normalizeIp('203.0.113.5')).toBe('203.0.113.5');
    expect(normalizeIp('::ffff:203.0.113.5')).toBe('203.0.113.5');
    expect(normalizeIp('2001:db8:1:2:3:4:5:6')).toBe('2001:db8:1:2::/64');
    expect(normalizeIp('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(normalizeIp('2001:0DB8:0001:0002::')).toBe('2001:db8:1:2::/64');
  });
});
