import { describe, expect, it } from 'vitest';
import { extractRconMessage, parseRetryAfter, rconRequest } from './client';
import type { FetchFn } from './client';
import { READ_ROUTES, WRITE_ROUTES } from './routes';

const cfg = { baseUrl: 'http://rcon.example.invalid:7776', password: 'secret-rcon-password' };
const read = { route: READ_ROUTES.status, path: '/v1/status', timeoutMs: 50 };
const logs: unknown[] = [];
const log = (e: unknown) => logs.push(e);

const respond = (body: BodyInit | null, init: ResponseInit = {}): FetchFn => async () => new Response(body, init);

describe('rcon client', () => {
  it('成功: Bearer・リダイレクト非追従・JSON を解釈', async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const fetchFn: FetchFn = async (url, init) => {
      seen = { url, init };
      return new Response(JSON.stringify({ serverName: 'x' }), { status: 200 });
    };
    const r = await rconRequest(cfg, read, { fetchFn, log });
    expect(r).toEqual({ ok: true, status: 200, data: { serverName: 'x' } });
    expect(seen!.url).toBe('http://rcon.example.invalid:7776/v1/status');
    expect((seen!.init.headers as Record<string, string>).Authorization).toBe('Bearer secret-rcon-password');
    expect(seen!.init.redirect).toBe('manual');
  });

  it('書き込みは本文を JSON で送る', async () => {
    let init: RequestInit | undefined;
    const fetchFn: FetchFn = async (_u, i) => {
      init = i;
      return new Response(null, { status: 204 });
    };
    const r = await rconRequest(
      cfg,
      { route: WRITE_ROUTES.broadcast, path: '/v1/broadcast', body: { message: 'hi' }, timeoutMs: 50, allowNonJson: true },
      { fetchFn, log },
    );
    expect(r.ok).toBe(true);
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe('{"message":"hi"}');
    expect((init?.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('タイムアウト → RCON_TIMEOUT', async () => {
    const fetchFn: FetchFn = (_u, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
    const r = await rconRequest(cfg, { ...read, timeoutMs: 20 }, { fetchFn, log });
    expect(r).toMatchObject({ ok: false, code: 'RCON_TIMEOUT', status: null });
  });

  it('接続失敗 → RCON_UNREACHABLE(例外の文字列は返さない)', async () => {
    const fetchFn: FetchFn = async () => {
      throw new TypeError('connect ECONNREFUSED rcon.example.invalid:7776');
    };
    const r = await rconRequest(cfg, read, { fetchFn, log });
    expect(r).toEqual({ ok: false, code: 'RCON_UNREACHABLE', status: null });
  });

  it('ステータスの分類', async () => {
    const cases: [number, string][] = [
      [401, 'RCON_AUTH_FAILED'],
      [403, 'RCON_AUTH_FAILED'],
      [404, 'RCON_ROUTE_NOT_FOUND'],
      [409, 'RCON_REJECTED'],
      [500, 'RCON_ERROR'],
      [503, 'RCON_ERROR'],
      [302, 'RCON_BAD_RESPONSE'],
    ];
    for (const [status, code] of cases) {
      const r = await rconRequest(cfg, read, { fetchFn: respond('{}', { status }), log });
      expect(r).toMatchObject({ ok: false, code, status });
    }
  });

  it('429 は Retry-After を秒で返す', async () => {
    const r = await rconRequest(cfg, read, { fetchFn: respond('', { status: 429, headers: { 'Retry-After': '12' } }), log });
    expect(r).toMatchObject({ ok: false, code: 'RCON_RATE_LIMITED', retryAfterSec: 12 });
    expect(parseRetryAfter(null)).toBe(30);
    expect(parseRetryAfter('999999')).toBe(3600);
  });

  it('その他の 4xx は rconMessage を切り詰めて返す', async () => {
    const r = await rconRequest(cfg, read, {
      fetchFn: respond(JSON.stringify({ error: `player\nis offline ${'x'.repeat(300)}` }), { status: 409 }),
      log,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.code).toBe('RCON_REJECTED');
      expect(r.rconMessage?.length).toBe(200);
      expect(r.rconMessage).not.toMatch(/\n/);
    }
    // HTML の本文は返さない
    const h = await rconRequest(cfg, read, { fetchFn: respond('<html>err</html>', { status: 400 }), log });
    expect(h).toEqual({ ok: false, code: 'RCON_REJECTED', status: 400 });
    expect(extractRconMessage({ error: { message: 'nested' } })).toBe('nested');
  });

  it('JSON として不正な 2xx → RCON_BAD_RESPONSE(書き込みは成功扱い)', async () => {
    expect(await rconRequest(cfg, read, { fetchFn: respond('not json', { status: 200 }), log })).toMatchObject({
      ok: false,
      code: 'RCON_BAD_RESPONSE',
    });
    expect(await rconRequest(cfg, { ...read, allowNonJson: true }, { fetchFn: respond('OK', { status: 200 }), log })).toEqual({
      ok: true,
      status: 200,
      data: null,
    });
  });

  it('512 KiB を超える応答 → RCON_BAD_RESPONSE', async () => {
    const big = new Uint8Array(512 * 1024 + 1).fill(0x20);
    const r = await rconRequest(cfg, read, { fetchFn: respond(big, { status: 200 }), log });
    expect(r).toMatchObject({ ok: false, code: 'RCON_BAD_RESPONSE' });
  });

  it('ログに接続先・パスワードを出さない', () => {
    const text = JSON.stringify(logs);
    expect(text).not.toContain('rcon.example.invalid');
    expect(text).not.toContain('secret-rcon-password');
    expect(text).toContain('GET /v1/status');
  });
});
