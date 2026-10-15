#!/usr/bin/env node
// ローカル開発用のモック RCON HTTP API(Node 22 以上、依存なし)。
// 形式は docs/research/wardogs-rcon.md 2 章(非公式資料ベース・未検証)に合わせた架空のもの。実サーバーの挙動とは異なり得る。
//
//   MOCK_RCON_PORT     待ち受けポート(既定 7776)。127.0.0.1 のみで待ち受ける
//   MOCK_RCON_PASSWORD Authorization: Bearer と照合する値(既定は下記のダミー文字列)
//
// プレイヤー名・Steam ID は架空(Steam ID は 0 始まりの 17 桁で、実在の SteamID64 の形式ではない)。
import { createServer } from 'node:http';
import { timingSafeEqual, createHash } from 'node:crypto';

const PORT = Number(process.env.MOCK_RCON_PORT || 7776);
const PASSWORD = process.env.MOCK_RCON_PASSWORD || 'mock-rcon-password-for-local-dev-only';
const MAX_BODY = 64 * 1024;

const state = {
  serverName: 'Mock Server (local)',
  map: 'mock_map_alpha',
  maxPlayers: 64,
  factionScores: [
    { faction: 'Blue', score: 120 },
    { faction: 'Red', score: 95 },
  ],
  rotation: { nowIndex: 0, nextIndex: 1 },
  players: [
    { name: 'TestPlayerA', steamId: '00000000000000001', faction: 'Blue', kills: 12, deaths: 3, cash: 1500, pingMs: 24 },
    { name: 'TestPlayerB', steamId: '00000000000000002', faction: 'Red', kills: 7, deaths: 9, cash: 800, pingMs: 41 },
    { name: 'テストプレイヤーC', steamId: '00000000000000003', faction: 'Blue', kills: 0, deaths: 1, cash: 300, pingMs: 88 },
    { name: 'TestPlayerD', steamId: '00000000000000004', faction: 'Red', kills: 4, deaths: 4, cash: 950, pingMs: 57 },
  ],
  bans: [{ steamId: '00000000000000099', bannedAtUtc: '2026-10-01T12:00:00Z', bannedBy: 'mock', reason: 'example ban' }],
  maps: [
    { id: 'mock_map_alpha', displayName: 'Mock Map Alpha' },
    { id: 'mock_map_bravo', displayName: 'Mock Map Bravo' },
    { id: 'mock_map_charlie', displayName: 'Mock Map Charlie' },
  ],
  startedAt: Date.now(),
};

const ROUTES = [
  'GET /v1/status',
  'GET /v1/players',
  'GET /v1/health',
  'GET /v1/capabilities',
  'GET /v1/bans',
  'GET /v1/catalog/maps',
  'POST /v1/players/{steamId}/kick',
  'POST /v1/players/{steamId}/message',
  'POST /v1/broadcast',
  'POST /v1/bans',
  'DELETE /v1/bans/{steamId}',
  'POST /v1/match/map',
  'POST /v1/match/end',
];

const digest = (s) => createHash('sha256').update(s).digest();
function authorized(req) {
  const h = req.headers.authorization || '';
  const m = /^Bearer (.+)$/.exec(h);
  if (!m) return false;
  return timingSafeEqual(digest(m[1]), digest(PASSWORD));
}

function send(res, status, body) {
  const text = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > MAX_BODY) {
        resolve({ error: 'too_large' });
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (text === '') return resolve({ value: {} });
      try {
        resolve({ value: JSON.parse(text) });
      } catch {
        resolve({ error: 'bad_json' });
      }
    });
    req.on('error', () => resolve({ error: 'read_error' }));
  });
}

function checkMessage(msg) {
  return typeof msg === 'string' && msg.length > 0 && msg.length <= 256;
}

function findPlayer(steamId) {
  return state.players.find((p) => p.steamId === steamId);
}

// 簡易ログ(パスワード・本文は出さない)
function log(method, path, status) {
  console.log(`${new Date().toISOString()} ${method} ${path.replace(/\d{17}/g, '{steamId}')} -> ${status}`);
}

async function handler(req, res) {
  const url = new URL(req.url || '/', 'http://localhost');
  const method = req.method || 'GET';
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const reply = (status, body) => {
    log(method, path, status);
    send(res, status, body);
  };

  if (!authorized(req)) return reply(401, { error: 'unauthorized' });

  const body = method === 'POST' || method === 'PUT' || method === 'PATCH' ? await readBody(req) : { value: {} };
  if (body.error === 'too_large') return reply(413, { error: 'payload too large' });
  if (body.error) return reply(400, { error: 'invalid JSON body' });
  const b = body.value && typeof body.value === 'object' ? body.value : {};

  let m;
  if (method === 'GET' && path === '/v1/status') {
    return reply(200, {
      serverName: state.serverName,
      map: state.map,
      experiences: [],
      lighting: 'Day',
      alternator: false,
      scoreTick: 1,
      players: { current: state.players.length, max: state.maxPlayers },
      factionScores: state.factionScores,
      rotation: state.rotation,
    });
  }
  if (method === 'GET' && path === '/v1/players') {
    return reply(200, { players: state.players, count: state.players.length });
  }
  if (method === 'GET' && path === '/v1/health') {
    return reply(200, {
      status: 'ok',
      uptimeSeconds: Math.floor((Date.now() - state.startedAt) / 1000),
      connections: { active: 1 },
      gameThreadQueue: 0,
    });
  }
  if (method === 'GET' && path === '/v1/capabilities') {
    return reply(200, {
      apiVersion: 'mock-1',
      build: 'mock',
      auth: { scheme: 'bearer' },
      limits: { messageMaxLength: 256 },
      config: {},
      routes: ROUTES,
    });
  }
  if (method === 'GET' && path === '/v1/bans') return reply(200, { bans: state.bans, count: state.bans.length });
  if (method === 'GET' && path === '/v1/catalog/maps') return reply(200, { maps: state.maps });

  if (method === 'POST' && (m = /^\/v1\/players\/([^/]+)\/kick$/.exec(path))) {
    const id = decodeURIComponent(m[1]);
    const i = state.players.findIndex((p) => p.steamId === id);
    if (i < 0) return reply(409, { error: 'player is not online' });
    state.players.splice(i, 1);
    return reply(200, { ok: true });
  }
  if (method === 'POST' && (m = /^\/v1\/players\/([^/]+)\/message$/.exec(path))) {
    const id = decodeURIComponent(m[1]);
    if (!findPlayer(id)) return reply(409, { error: 'player is not online' });
    if (!checkMessage(b.message)) return reply(400, { error: 'message must be 1-256 characters' });
    return reply(200, { ok: true });
  }
  if (method === 'POST' && path === '/v1/broadcast') {
    if (!checkMessage(b.message)) return reply(400, { error: 'message must be 1-256 characters' });
    return reply(200, { ok: true });
  }
  if (method === 'POST' && path === '/v1/bans') {
    const id = typeof b.steamId === 'string' ? b.steamId : '';
    const player = findPlayer(id);
    if (!player) return reply(409, { error: 'player must be online to ban' });
    state.players = state.players.filter((p) => p.steamId !== id);
    state.bans.push({
      steamId: id,
      bannedAtUtc: new Date().toISOString(),
      bannedBy: 'rcon',
      reason: typeof b.reason === 'string' ? b.reason : '',
    });
    return reply(200, { ok: true });
  }
  if (method === 'DELETE' && (m = /^\/v1\/bans\/([^/]+)$/.exec(path))) {
    const id = decodeURIComponent(m[1]);
    const before = state.bans.length;
    state.bans = state.bans.filter((x) => x.steamId !== id);
    if (state.bans.length === before) return reply(404, { error: 'ban not found' });
    return reply(200, { ok: true });
  }
  if (method === 'POST' && path === '/v1/match/map') {
    const found = state.maps.find((x) => x.id === b.map);
    if (!found) return reply(400, { error: 'unknown map' });
    state.map = found.id;
    return reply(200, { ok: true });
  }
  if (method === 'POST' && path === '/v1/match/end') {
    state.rotation = { nowIndex: state.rotation.nextIndex, nextIndex: (state.rotation.nextIndex + 1) % state.maps.length };
    return reply(200, { ok: true });
  }
  return reply(404, { error: 'route not found' });
}

// ループバックだけで待ち受ける(localhost が IPv4 / IPv6 のどちらに解決されても届くように両方)
createServer(handler).listen(PORT, '127.0.0.1', () => {
  console.log(`mock RCON listening on http://localhost:${PORT} (${state.players.length} players)`);
});
createServer(handler)
  .on('error', () => undefined)
  .listen(PORT, '::1');
