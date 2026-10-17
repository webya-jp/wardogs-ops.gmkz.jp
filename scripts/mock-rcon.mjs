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
//   MOCK_SCORE_STEP_SEC 陣営スコアを増やす間隔(秒。既定 60、0 で増やさない)。1 回ごとに 1 陣営目 +2・2 陣営目 +1、
//                       プレイヤーの cash も +10 する。スコアは上限(scoreCap、無ければ 100)で止まる。
//                       ブラウザで「上限到達で記録が終わる」を数分で確かめるなら 3〜5 程度にする
//   MOCK_SCORE_CAP      1 台目(MOCK_RCON_PORTS の先頭)の status に入れる scoreCap(既定 100。0 で入れない)。
//                       2 台目以降は scoreCap を返さない(パネル側の設定値・既定値の経路を確かめるため。ビルドによって無い。R-21)
//   MOCK_FEED_URL       与えるとキルフィードの送信モード: 2 秒ごとに <MOCK_FEED_URL>/api/ingest/events へ
//                       ダミーの killed バッチと空のバッチを交互に POST する(MOCK_FEED_URL はパネルの URL。例 http://127.0.0.1:4322)
//   MOCK_FEED_TOKEN     その送信に使う受信用トークン(パネルの設定タブで発行したもの。ログに出さない)
//   MOCK_FEED_SEC       送信の間隔(秒。既定 2)
//   MOCK_FEED_SHAPE     送信する本文の形(docs/ARCHITECTURE.md 17.10.10)。basic(既定)= 第 1 段階のまま /
//                       mixed = 正規化の対応表の確認用に 10 種類の変種を順番に混ぜる(1 バッチ 1〜3 件)。
//                       変種の項目名もすべて推測(実サーバーの形式は未検証 K-1)。6 番の変種だけ Steam ID を
//                       引用符無しの 17 桁の数値で書く(JSON の数値は 0 で始められないため、先頭を 1 にした架空の ID)
//
// 試合: POST /v1/match/map・/v1/match/end で新しい試合になり、スコアと cash を初期値に戻す(マップも変わる)。
// キルフィードの本文の形({ type: 'killed', killer, victim, weapon, distance, headshot, time } の配列)は
// docs/research/wardogs-rcon.md 2.4 からの**推測**で、実サーバーの形式は未検証(K-1)。
//
// 127.0.0.1 と ::1 だけで待ち受ける。サーバー名は "Mock Server <ポート>"。
// プレイヤー名・Steam ID は架空(Steam ID は 0 始まりの 17 桁で、実在の SteamID64 の形式ではない)。
// ポートごとにプレイヤー名(末尾に "-<ポート>")・Steam ID・人数・experiences・ローテーションを変え、
// 画面でどのサーバーに繋がっているか見分けられるようにする。experiences の値(mock_mode_*)・ローテーションの要素の形
// ({ map, displayName })は架空。POST /v1/match/map・/v1/match/end でローテーション位置を 1 つ進める。
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

function envNumber(name, fallback) {
  const raw = (process.env[name] || '').trim();
  if (raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    console.error(`${name} must be a number >= 0`);
    process.exit(1);
  }
  return n;
}

const SCORE_STEP_SEC = envNumber('MOCK_SCORE_STEP_SEC', 60);
const SCORE_CAP = envNumber('MOCK_SCORE_CAP', 100);
const FEED_URL = (process.env.MOCK_FEED_URL || '').trim().replace(/\/+$/, '');
const FEED_TOKEN = (process.env.MOCK_FEED_TOKEN || '').trim();
const FEED_SEC = envNumber('MOCK_FEED_SEC', 2);
const FEED_SHAPE = (process.env.MOCK_FEED_SHAPE || 'basic').trim().toLowerCase();

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
    map: ROTATION_SETS[index % ROTATION_SETS.length][0].map,
    maxPlayers: 64,
    // 試合の初期値(時間とともに増える。currentScores)
    baseScores: [
      { faction: 'Blue', score: 10 + index * 5 },
      { faction: 'Red', score: 5 + index * 5 },
    ],
    scoreCap: index === 0 && SCORE_CAP > 0 ? SCORE_CAP : null,
    matchStartedAt: Date.now(),
    experiences: EXPERIENCE_SETS[index % EXPERIENCE_SETS.length],
    rotationEntries: ROTATION_SETS[index % ROTATION_SETS.length],
    rotation: { nowIndex: 0, nextIndex: 1 },
    players: BASE_PLAYERS.slice(0, count).map((p, i) => ({ ...p, name: `${p.name}-${port}`, steamId: fakeSteamId(port, i + 1) })),
    bans: [{ steamId: fakeSteamId(port, 99), bannedAtUtc: '2026-10-01T12:00:00Z', bannedBy: 'mock', reason: 'example ban' }],
    maps: [
      { id: 'Zestafona', displayName: 'Zestafona' },
      { id: 'Ozeti', displayName: 'Ozeti' },
      { id: 'Bakurani', displayName: 'Bakurani' },
    ],
    startedAt: Date.now(),
  };
}

/** 試合開始からの経過で増えたスコア(上限で止める) */
function steps(state) {
  if (SCORE_STEP_SEC <= 0) return 0;
  return Math.floor((Date.now() - state.matchStartedAt) / (SCORE_STEP_SEC * 1000));
}

function currentScores(state) {
  const n = steps(state);
  const cap = state.scoreCap ?? 100;
  return state.baseScores.map((s, i) => ({ faction: s.faction, score: Math.min(cap, s.score + n * (i === 0 ? 2 : 1)) }));
}

function currentPlayers(state) {
  const n = steps(state);
  return state.players.map((p) => ({ ...p, cash: p.cash + n * 10 }));
}

/** 新しい試合(マップ変更・試合終了の後) */
function newMatch(state) {
  state.matchStartedAt = Date.now();
}

/** ポートごとの experiences(架空) */
const EXPERIENCE_SETS = [['mock_mode_conquest'], ['mock_mode_frontline', 'mock_mode_night'], []];

// 実際の WARDOGS のマップ名(2026-10-18 時点)。id の正式な形式は未確認なので表示名をそのまま使う
const MAP_NAMES = { Zestafona: 'Zestafona', Ozeti: 'Ozeti', Bakurani: 'Bakurani' };
const entry = (id) => ({ map: id, displayName: MAP_NAMES[id] });
/** ポートごとのローテーション(件数と順番を変える) */
const ROTATION_SETS = [
  ['Zestafona', 'Ozeti', 'Bakurani'].map(entry),
  ['Ozeti', 'Bakurani', 'Zestafona', 'Bakurani'].map(entry),
  ['Bakurani', 'Zestafona'].map(entry),
];

/** ローテーション位置を 1 つ進め、現在のマップをその位置のマップにする */
function advanceRotation(state) {
  const n = state.rotationEntries.length;
  const now = state.rotation.nextIndex;
  state.rotation = { nowIndex: now, nextIndex: (now + 1) % n };
  state.map = state.rotationEntries[now].map;
}

const ROUTES = [
  'GET /v1/status',
  'GET /v1/players',
  'GET /v1/health',
  'GET /v1/capabilities',
  'GET /v1/bans',
  'GET /v1/catalog/maps',
  'GET /v1/rotation',
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
        experiences: state.experiences,
        lighting: 'Day',
        alternator: false,
        scoreTick: 1,
        players: { current: state.players.length, max: state.maxPlayers },
        factionScores: currentScores(state),
        rotation: state.rotation,
        matchSeconds: Math.floor((Date.now() - state.matchStartedAt) / 1000),
        ...(state.scoreCap === null ? {} : { scoreCap: state.scoreCap }),
      });
    }
    if (method === 'GET' && path === '/v1/players') {
      return reply(200, { players: currentPlayers(state), count: state.players.length });
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
    if (method === 'GET' && path === '/v1/rotation') {
      return reply(200, { enabled: true, mode: 'sequential', entries: state.rotationEntries });
    }

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
      advanceRotation(state);
      state.map = found.id;
      newMatch(state);
      return reply(200, { ok: true });
    }
    if (method === 'POST' && path === '/v1/match/end') {
      advanceRotation(state);
      newMatch(state);
      return reply(200, { ok: true });
    }
    return reply(404, { error: 'route not found' });
  };
}

// ループバックだけで待ち受ける(localhost が IPv4 / IPv6 のどちらに解決されても届くように両方)
const states = [];
PORTS.forEach((port, index) => {
  const state = makeState(port, index);
  states.push(state);
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

// ---- キルフィードの送信モード(MOCK_FEED_URL / MOCK_FEED_TOKEN)。本文の形は資料からの推測(K-1) ----
if (FEED_URL !== '') {
  if (FEED_TOKEN === '') {
    console.error('MOCK_FEED_TOKEN is required when MOCK_FEED_URL is set');
    process.exit(1);
  }
  if (FEED_SHAPE !== 'basic' && FEED_SHAPE !== 'mixed') {
    console.error('MOCK_FEED_SHAPE must be basic or mixed');
    process.exit(1);
  }
  const target = `${FEED_URL}/api/ingest/events`;
  let tick = 0;
  let variant = 0;
  const send = async () => {
    tick += 1;
    // 1 回おきに空のバッチ(ゲームが空のときも送るかは未検証 K-3)
    const state = states[0];
    let body = '[]';
    let label = 'empty';
    if (tick % 2 === 1 && state && state.players.length >= 2) {
      if (FEED_SHAPE === 'mixed') {
        const batch = mixedBatch(state, tick);
        body = batch.body;
        label = `mixed ${batch.variants.join('+')}`;
      } else {
        const a = state.players[tick % state.players.length];
        const b = state.players[(tick + 1) % state.players.length];
        body = JSON.stringify([
          {
            type: 'killed',
            time: new Date().toISOString(),
            killer: { name: a.name, steamId: a.steamId, faction: a.faction },
            victim: { name: b.name, steamId: b.steamId, faction: b.faction },
            weapon: 'mock_rifle',
            distance: 50 + (tick % 7) * 25,
            headshot: tick % 3 === 0,
          },
        ]);
        label = 'killed x1';
      }
    }
    try {
      const res = await fetch(target, {
        method: 'POST',
        headers: { Authorization: `Bearer ${FEED_TOKEN}`, 'Content-Type': 'application/json' },
        body,
      });
      await res.arrayBuffer().catch(() => undefined);
      // トークン・本文は出さない(変種の番号と応答の状態だけ)
      console.log(`${new Date().toISOString()} feed POST /api/ingest/events (${label}) -> ${res.status}`);
    } catch (err) {
      console.log(`${new Date().toISOString()} feed POST /api/ingest/events -> error (${err && err.name ? err.name : 'Error'})`);
    }
  };

  /**
   * mixed の 1 バッチ(17.10.10 の変種 1〜10 を順番に。1 バッチ 1〜3 件)。10 番(events で包んだオブジェクト)は単独で送る。
   * 6 番は Steam ID を引用符無しの数値で書くため、本文の文字列を手で組み立てる(JSON.stringify を使わない)
   */
  function mixedBatch(st, t) {
    const count = 1 + (t % 3);
    const parts = [];
    const variants = [];
    for (let i = 0; i < count; i += 1) {
      const v = (variant % 10) + 1;
      if (v === 10 && parts.length > 0) break;
      variant += 1;
      variants.push(v);
      if (v === 10) {
        return { body: JSON.stringify({ events: [mixedVariant(st, 1, t), mixedVariant(st, 2, t)] }), variants };
      }
      parts.push(v === 6 ? numericSteamIdVariant(st, t) : JSON.stringify(mixedVariant(st, v, t)));
    }
    return { body: `[${parts.join(',')}]`, variants };
  }

  function pick(st, n) {
    return st.players[n % st.players.length];
  }

  /** 同じ陣営の 2 人(無ければ先頭の 2 人) */
  function sameFactionPair(st) {
    for (const a of st.players) {
      const b = st.players.find((p) => p !== a && p.faction === a.faction);
      if (b) return [a, b];
    }
    return [st.players[0], st.players[1]];
  }

  function mixedVariant(st, v, t) {
    const a = pick(st, t);
    const b = pick(st, t + 1);
    switch (v) {
      case 1:
        return {
          type: 'killed',
          killer: { name: a.name, steamId: a.steamId, faction: a.faction },
          victim: { name: b.name, steamId: b.steamId, faction: b.faction },
          weapon: { id: 'WEPN_031', name: 'Test Rifle' },
          distanceM: 37.2,
          headshot: true,
          gameTime: 3151,
        };
      case 2:
        // 陣営なし(記録中なら roster から付く)
        return {
          event: 'kill',
          killerName: a.name,
          killerSteamId: a.steamId,
          victimName: b.name,
          victimSteamId: b.steamId,
          weaponName: 'Test Pistol',
          distance: 12,
          isHeadshot: false,
          flags: ['PENETRATION'],
        };
      case 3:
        return {
          type: 'killed',
          attacker: { name: a.name, steamId: a.steamId },
          victim: { name: b.name, steamId: b.steamId },
          vehicle: { id: 'TNK_01', name: 'Test Tank' },
          weapon: 'Anti Air',
          range: 180,
          tags: 'ROADKILL',
        };
      case 4:
        // 自殺・距離不明
        return {
          type: 'killed',
          killer: { name: a.name, steamId: a.steamId, faction: a.faction },
          victim: { name: a.name, steamId: a.steamId, faction: a.faction },
          weapon: { id: 'GRENADE_TEST' },
        };
      case 5: {
        // チームキル(同じ陣営の 2 人)
        const [x, y] = sameFactionPair(st);
        return {
          type: 'killed',
          killer: { name: x.name, steamId: x.steamId, faction: x.faction },
          victim: { name: y.name, steamId: y.steamId, faction: y.faction },
          weapon: { id: 'WEPN_031', name: 'Test Rifle' },
          distanceM: 8.4,
        };
      }
      case 7:
        // 環境による死亡(キラーなし)
        return { type: 'killed', victim: { name: b.name, steamId: b.steamId, faction: b.faction }, cause: 'Test Fall' };
      case 8:
        return { type: 'test_unknown_event', foo: 1 };
      case 9:
        return { type: 'killed', a: 1 };
      default:
        return mixedVariant(st, 1, t);
    }
  }

  /** 6 番: killer.steamId を引用符無しの 17 桁の数値で書いた本文(先頭を 1 にした架空の ID。実在の SteamID64 の形式ではない) */
  function numericSteamIdVariant(st, t) {
    const a = pick(st, t);
    const b = pick(st, t + 2);
    const numericId = `1${a.steamId.slice(1)}`;
    const victim = JSON.stringify({ name: b.name, steamId: b.steamId, faction: b.faction });
    return `{"type":"killed","killer":{"name":${JSON.stringify(a.name)},"steamId":${numericId},"faction":${JSON.stringify(a.faction)}},"victim":${victim},"weapon":{"id":"WEPN_031"},"distanceM":64.5}`;
  }

  setInterval(send, Math.max(0.5, FEED_SEC) * 1000);
  console.log(`mock feed: posting every ${FEED_SEC}s (shape: ${FEED_SHAPE}) to ${FEED_URL}/api/ingest/events (token not shown)`);
}
