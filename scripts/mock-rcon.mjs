#!/usr/bin/env node
// ローカル開発用のモック RCON HTTP API(Node 22 以上、依存なし)。docs/ARCHITECTURE.md 15.10。
// 形式は docs/research/wardogs-rcon.md 2 章(非公式資料ベース・未検証)に合わせた架空のもの。実サーバーの挙動とは異なり得る。
//
//   MOCK_RCON_PORTS     待ち受けポート(カンマ区切り。例 7776,7777)。1 つのプロセスで複数のポートを待ち受け、
//                       ポートごとに状態(プレイヤー・BAN・マップ)を独立に持つ。MOCK_RCON_PORT より優先
//   MOCK_RCON_PORT      待ち受けポート 1 つ(既定 7776。MOCK_RCON_PORTS が無いときだけ使う)
//   MOCK_RCON_PASSWORD  Authorization: Bearer と照合する値(全ポート共通。既定は下記のダミー文字列)。
//                       パネルの「サーバー設定」(/servers)でサーバーを追加するときに、この値を RCON パスワードとして入力する
//   MOCK_RCON_PASSWORDS ポートごとのパスワード(カンマ区切り、MOCK_RCON_PORTS と同じ順。空の要素は MOCK_RCON_PASSWORD)
//
// 127.0.0.1 と ::1 だけで待ち受ける。サーバー名は "Mock Server <ポート>"。
// プレイヤー名・Steam ID は架空(Steam ID は 0 始まりの 17 桁で、実在の SteamID64 の形式ではない)。
// ポートごとにプレイヤー名(末尾に "-<ポート>")・Steam ID・人数を変え、画面でどのサーバーに繋がっているか見分けられるようにする。
import { createServer } from 'node:http';
import { timingSafeEqual, createHash } from 'node:crypto';

const DEFAULT_PASSWORD = process.env.MOCK_RCON_PASSWORD || 'mock-rcon-password-for-local-dev-only';
const MAX_BODY = 64 * 1024;

function parsePorts() {
  const raw = (process.env.MOCK_RCON_PORTS || '').trim();
  const list = raw === '' ? [String(process.env.MOCK_RCON_PORT || 7776)] : raw.split(',');
  const ports = list.map((s) => Number(s.trim()));
  for (const p of ports) {
    if (!Number.isInteger(p) || p < 1 || p > 65535) {
      console.error('MOCK_RCON_PORTS / MOCK_RCON_PORT must be integers between 1 and 65535');
      process.exit(1);
    }
  }
  if (new Set(ports).size !== ports.length) {
    console.error('MOCK_RCON_PORTS has duplicates');
    process.exit(1);
  }
  return ports;
}

const PORTS = parsePorts();
const PASSWORDS = (process.env.MOCK_RCON_PASSWORDS || '').split(',');

const BASE_PLAYERS = [
  { name: 'TestPlayerA', faction: 'Blue', kills: 12, deaths: 3, cash: 1500, pingMs: 24 },
  { name: 'TestPlayerB', faction: 'Red', kills: 7, deaths: 9, cash: 800, pingMs: 41 },
  { name: 'テストプレイヤーC', faction: 'Blue', kills: 0, deaths: 1, cash: 300, pingMs: 88 },
  { name: 'TestPlayerD', faction: 'Red', kills: 4, deaths: 4, cash: 950, pingMs: 57 },
];

/** 架空の 17 桁 ID。先頭 10 桁は 0、続く 5 桁がポート、最後の 2 桁が通し番号 */
function fakeSteamId(port, n) {
  return `0000000000${String(port).padStart(5, '0')}${String(n).padStart(2, '0')}`;
}

function makeState(port, index) {
  // 1 台目は 4 人、2 台目は 3 人…(最低 1 人)
  const count = Math.max(1, BASE_PLAYERS.length - index);
  return {
    port,
    password: PASSWORDS[index] && PASSWORDS[index].trim() !== '' ? PASSWORDS[index] : DEFAULT_PASSWORD,
    serverName: `Mock Server ${port}`,
    map: index % 2 === 0 ? 'mock_map_alpha' : 'mock_map_bravo',
    maxPlayers: 64,
    factionScores: [
      { faction: 'Blue', score: 120 + index * 10 },
      { faction: 'Red', score: 95 + index * 10 },
    ],
    rotation: { nowIndex: index % 3, nextIndex: (index + 1) % 3 },
    players: BASE_PLAYERS.slice(0, count).map((p, i) => ({ ...p, name: `${p.name}-${port}`, steamId: fakeSteamId(port, i + 1) })),
    bans: [{ steamId: fakeSteamId(port, 99), bannedAtUtc: '2026-10-01T12:00:00Z', bannedBy: 'mock', reason: 'example ban' }],
    maps: [
      { id: 'mock_map_alpha', displayName: 'Mock Map Alpha' },
      { id: 'mock_map_bravo', displayName: 'Mock Map Bravo' },
      { id: 'mock_map_charlie', displayName: 'Mock Map Charlie' },
    ],
    startedAt: Date.now(),
  };
}

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
function authorized(req, password) {
  const h = req.headers.authorization || '';
  const m = /^Bearer (.+)$/.exec(h);
  if (!m) return false;
  return timingSafeEqual(digest(m[1]), digest(password));
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

// 簡易ログ(パスワード・本文は出さない)
function log(port, method, path, status) {
  console.log(`${new Date().toISOString()} :${port} ${method} ${path.replace(/\d{17}/g, '{steamId}')} -> ${status}`);
}

function makeHandler(state) {
  const findPlayer = (steamId) => state.players.find((p) => p.steamId === steamId);
  return async function handler(req, res) {
    const url = new URL(req.url || '/', 'http://localhost');
    const method = req.method || 'GET';
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const reply = (status, body) => {
      log(state.port, method, path, status);
      send(res, status, body);
    };

    if (!authorized(req, state.password)) return reply(401, { error: 'unauthorized' });

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
      if (!findPlayer(id)) return reply(409, { error: 'player must be online to ban' });
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
  };
}

// ループバックだけで待ち受ける(localhost が IPv4 / IPv6 のどちらに解決されても届くように両方)
PORTS.forEach((port, index) => {
  const state = makeState(port, index);
  const handler = makeHandler(state);
  createServer(handler)
    .on('error', (err) => {
      console.error(`mock RCON: cannot listen on port ${port} (${err.code || 'error'})`);
      process.exit(1);
    })
    .listen(port, '127.0.0.1', () => {
      console.log(`mock RCON listening on http://localhost:${port} (${state.serverName}, ${state.players.length} players)`);
    });
  createServer(handler)
    .on('error', () => undefined)
    .listen(port, '::1');
});
