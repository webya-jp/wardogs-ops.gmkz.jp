import { describe, expect, it } from 'vitest';
import { collectWarnings, d1Warning, getFeatures, parseRconUrl, probeD1, resetD1Cache } from './config';
import { normalizeIp } from './keys';
import { makeD1 } from './testing/sqlite-d1';

const env = (o: Record<string, unknown> = {}) => ({ ASSETS: {} as Fetcher, ...o });

describe('config', () => {
  it('RCON の接続先の検証', () => {
    expect(parseRconUrl('http://rcon.example.com:7776/')).toEqual({ ok: true, baseUrl: 'http://rcon.example.com:7776' });
    expect(parseRconUrl('https://proxy.example.com/rcon/')).toEqual({ ok: true, baseUrl: 'https://proxy.example.com/rcon' });
    expect(parseRconUrl('http://rcon.example.com:7789')).toEqual({ ok: true, baseUrl: 'http://rcon.example.com:7789' });
    expect(parseRconUrl('')).toEqual({ ok: false, issue: 'RCON_URL_MISSING' });
    expect(parseRconUrl('rcon.example.com:7776')).toEqual({ ok: false, issue: 'RCON_URL_INVALID' });
    expect(parseRconUrl('ftp://x.example.com')).toEqual({ ok: false, issue: 'RCON_URL_INVALID' });
    expect(parseRconUrl('http://u:p@x.example.com')).toEqual({ ok: false, issue: 'RCON_URL_HAS_CREDENTIALS' });
    expect(parseRconUrl('http://192.0.2.10:7776')).toEqual({ ok: false, issue: 'RCON_URL_IS_IP_ADDRESS' });
    expect(parseRconUrl('http://[2001:db8::1]:7776')).toEqual({ ok: false, issue: 'RCON_URL_IS_IP_ADDRESS' });
    // 10 進 1 語・16 進表記も IPv4 とみなす
    expect(parseRconUrl('http://3221225994:7776')).toEqual({ ok: false, issue: 'RCON_URL_IS_IP_ADDRESS' });
    expect(parseRconUrl('http://0xC000020A:7776')).toEqual({ ok: false, issue: 'RCON_URL_IS_IP_ADDRESS' });
    expect(parseRconUrl('http://x.example.com/?a=1')).toEqual({ ok: false, issue: 'RCON_URL_INVALID' });
  });

  it('D1 が無いと missing、features はすべて false(旧 Secrets・AUDIT_REQUIRED は読まない)', async () => {
    resetD1Cache();
    const s = await getFeatures(env({ AUDIT_REQUIRED: 'false', ADMIN_PASSWORD: 'x'.repeat(20) }));
    expect(s).toEqual({ features: { audit: false, snapshots: false, writes: false }, d1: 'missing', db: null });
    expect(d1Warning(s.d1)).toBe('D1_MISSING');
  });

  it('D1 の判定は 0003 の表・列まで(admins / settings を含む)。0001 だけなら not_migrated', async () => {
    resetD1Cache();
    const old = await makeD1({ migrations: ['0001_init.sql'] });
    expect(await probeD1(old)).toBe('not_migrated');
    resetD1Cache();
    const s0 = await getFeatures(env({ DB: old }));
    expect(s0.features).toEqual({ audit: false, snapshots: false, writes: false });
    expect(s0.db).toBeNull();
    expect(d1Warning(s0.d1)).toBe('D1_NOT_MIGRATED');
    resetD1Cache();
    const cur = await makeD1();
    const s = await getFeatures(env({ DB: cur }));
    expect(s.d1).toBe('ok');
    expect(s.db).toBe(cur);
    expect(s.features).toEqual({ audit: true, snapshots: true, writes: true });
    expect(d1Warning(s.d1)).toBeNull();
    resetD1Cache();
  });

  it('admins または settings が欠けた D1 は not_migrated', async () => {
    for (const table of ['admins', 'settings']) {
      resetD1Cache();
      const db = await makeD1();
      await db.prepare(`DROP TABLE ${table}`).run();
      expect(await probeD1(db)).toBe('not_migrated');
    }
    resetD1Cache();
  });

  it('0003 の表・列が無い D1(0002 まで)は not_migrated', async () => {
    resetD1Cache();
    expect(await probeD1(await makeD1({ migrations: ['0001_init.sql', '0002_servers.sql'] }))).toBe('not_migrated');
    for (const table of ['match_recordings', 'match_samples', 'server_feeds', 'feed_raw_events', 'feed_daily']) {
      resetD1Cache();
      const db = await makeD1();
      await db.prepare(`DROP TABLE ${table}`).run();
      expect(await probeD1(db)).toBe('not_migrated');
    }
    resetD1Cache();
  });

  it('警告の初期値は SERVER_PASSWORDS_UNREADABLE だけ', () => {
    expect(collectWarnings()).toEqual([]);
    expect(collectWarnings(true)).toEqual(['SERVER_PASSWORDS_UNREADABLE']);
  });

  it('IP の正規化(IPv6 は /64)', () => {
    expect(normalizeIp('203.0.113.5')).toBe('203.0.113.5');
    expect(normalizeIp('::ffff:203.0.113.5')).toBe('203.0.113.5');
    expect(normalizeIp('2001:db8:1:2:3:4:5:6')).toBe('2001:db8:1:2::/64');
    expect(normalizeIp('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(normalizeIp('2001:0DB8:0001:0002::')).toBe('2001:db8:1:2::/64');
  });
});
