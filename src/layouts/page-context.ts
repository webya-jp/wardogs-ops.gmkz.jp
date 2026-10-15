// ログイン後のページ(Astro)で使う共通の値。サーバー側専用(React アイランドから import しない)。
// 言語・タイムゾーンはここで 1 回だけ決め、アイランドには props で渡す(docs/ARCHITECTURE.md 13.3)。
// warnings は設定と D1 の状態から作る初期値。LOGIN_FAILURES_HIGH を含む最新値はアイランドが /api/session で取り直す。
// サーバーの選択(docs/ARCHITECTURE.md 15.5): クエリ ?server= → Cookie(__Host-wo_server)→ 表示順で最初に使えるサーバー → 先頭。
// RCON パスワード(平文・暗号文)はここで扱う値に含めない(ServerSummary には入っていない)。
import { collectWarnings, getFeatures } from '../lib/config';
import { getKeys } from '../lib/keys';
import { getEnv, IS_DEV } from '../lib/runtime';
import { clearServerCookie, listServers, selectServer, serializeServerCookie, serverCookieName } from '../lib/servers';
import { readCookie } from '../lib/session';
import { getTranslator, resolveLanguage, resolveTimeZone } from '../i18n';
import type { Language, Translator } from '../i18n';
import type { Features, ServerId, ServerSummary, SessionInfo, SetupWarning } from '../types/api';

export interface PageContext {
  language: Language;
  timeZone: string;
  t: Translator;
  session: SessionInfo | null;
  features: Features;
  warnings: SetupWarning[];
  /** サーバー一覧(表示順)。パスワードは含まない */
  servers: ServerSummary[];
  /** 選択中のサーバーの id(0 台、または ?server= が見つからないときは null) */
  serverId: ServerId | null;
  /** 選択中のサーバー(serverId と同じものを一覧から引いたもの) */
  server: ServerSummary | null;
  /**
   * ?server= で指定されたサーバーが無い・形式不正(SERVER_NOT_FOUND を表示する。ほかのサーバーに切り替えない)。
   * 0 台(NO_SERVERS)は servers.length === 0 で判定する
   */
  serverNotFound: boolean;
}

/**
 * response(Astro.response)を渡すと、?server= で決まったときに選択 Cookie を発行し、
 * Cookie が指す先が無いときは Cookie を消す(渡さなければ Cookie は触らない)
 */
export async function getPageContext(
  request: Request,
  locals: App.Locals,
  response?: { headers: Headers },
): Promise<PageContext> {
  const env = getEnv();
  const language = resolveLanguage(env.LANGUAGE, request.headers.get('Accept-Language'));
  const timeZone = resolveTimeZone(env.TIMEZONE);
  const state = await getFeatures(env);
  // ログイン後のページは middleware が D1 の判定を通してから来るので db はある(無ければ 0 台として扱う)
  const list = state.db
    ? await listServers({ db: state.db, key: (await getKeys(state.db)).serverPassword })
    : { servers: [], unreadable: false };
  const warnings = collectWarnings(list.unreadable);

  const query = new URL(request.url).searchParams.get('server');
  const cookie = readCookie(request, serverCookieName(IS_DEV));
  const sel = selectServer(list.servers, query, cookie);
  if (response) {
    if (sel.fromQuery && sel.selected) response.headers.append('Set-Cookie', serializeServerCookie(sel.selected.id, IS_DEV));
    else if (sel.staleCookie) response.headers.append('Set-Cookie', clearServerCookie(IS_DEV));
  }

  return {
    language,
    timeZone,
    t: getTranslator(language),
    session: locals.session,
    features: state.features,
    warnings,
    servers: list.servers,
    serverId: sel.selected?.id ?? null,
    server: sel.selected,
    serverNotFound: sel.notFound,
  };
}
