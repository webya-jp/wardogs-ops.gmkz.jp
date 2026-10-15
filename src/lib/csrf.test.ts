import { describe, expect, it } from 'vitest';
import { checkSameOrigin } from './csrf';

const req = (method: string, headers: Record<string, string> = {}) =>
  new Request('https://ops.example.com/api/actions/prepare', { method, headers });

describe('csrf', () => {
  it('GET / HEAD は検査しない', () => {
    expect(checkSameOrigin(req('GET', { Origin: 'https://evil.example' }))).toBe(true);
    expect(checkSameOrigin(req('HEAD'))).toBe(true);
  });
  it('Origin が完全一致すれば通す', () => {
    expect(checkSameOrigin(req('POST', { Origin: 'https://ops.example.com' }))).toBe(true);
  });
  it('Origin が違えば拒否(Sec-Fetch-Site が same-origin でも)', () => {
    expect(checkSameOrigin(req('POST', { Origin: 'https://evil.example', 'Sec-Fetch-Site': 'same-origin' }))).toBe(false);
    expect(checkSameOrigin(req('POST', { Origin: 'null' }))).toBe(false);
    expect(checkSameOrigin(req('POST', { Origin: 'http://ops.example.com' }))).toBe(false);
    expect(checkSameOrigin(req('POST', { Origin: 'https://ops.example.com.evil.example' }))).toBe(false);
  });
  it('Origin が無ければ Sec-Fetch-Site: same-origin を要求し、どちらも無ければ拒否', () => {
    expect(checkSameOrigin(req('POST', { 'Sec-Fetch-Site': 'same-origin' }))).toBe(true);
    expect(checkSameOrigin(req('POST', { 'Sec-Fetch-Site': 'same-site' }))).toBe(false);
    expect(checkSameOrigin(req('POST', { 'Sec-Fetch-Site': 'cross-site' }))).toBe(false);
    expect(checkSameOrigin(req('POST'))).toBe(false);
    expect(checkSameOrigin(req('DELETE'))).toBe(false);
  });
});
