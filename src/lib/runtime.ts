// Worker のランタイム値の入口(cloudflare:workers に依存するのはこのファイルと middleware・ページだけ)。
// 単体テストする lib は env を引数で受け取る。
import { env as workersEnv } from 'cloudflare:workers';
import type { APIContext, APIRoute } from 'astro';
import { discardBody, errName, jsonError, methodNotAllowed } from './http';
import type { OpsEnv } from '../types/env';
import { checkConfig, collectWarnings, getFeatures } from './config';
import type { ConfigCheck, FeatureState } from './config';
import { getKeys, getServerPasswordKeys } from './keys';
import type { DerivedKeys } from './keys';
import { resolveServerForRead, serverCookieName } from './servers';
import type { ResolvedServer, ServerContext, ServerOutcome } from './servers';
import { getAttachedSession, readCookie } from './session';
import type { SessionData } from './session';
import type { SetupWarning } from '../types/api';

export function getEnv(): OpsEnv {
  return workersEnv as unknown as OpsEnv;
}

/** 開発時(astro dev)か。Cookie 名と Secure 属性の切り替えに使う(要確認 C-14) */
export const IS_DEV = import.meta.env.DEV;

export interface ApiContext {
  env: OpsEnv;
  config: ConfigCheck;
  keys: DerivedKeys;
  session: SessionData;
  state: FeatureState;
  /** 設定と D1 の警告(SERVER_PASSWORDS_UNREADABLE は含まない。/api/session が一覧から足す) */
  warnings: SetupWarning[];
  /** 対象サーバーの解決・サーバー API に使う */
  servers: ServerContext;
}

/**
 * middleware を通った後の /api/* ハンドラ用。設定不足・未ログインは middleware で弾かれているので、
 * ここで null になるのは想定外(呼び出し側は INTERNAL_ERROR を返す)
 */
export async function getApiContext(locals: object): Promise<ApiContext | null> {
  const env = getEnv();
  const config = checkConfig(env);
  const session = getAttachedSession(locals);
  if (!config.ok || !session) return null;
  const [keys, state, serverKeys] = await Promise.all([getKeys(env), getFeatures(env), getServerPasswordKeys(env)]);
  return {
    env,
    config,
    keys,
    session,
    state,
    warnings: collectWarnings(config, state),
    servers: { env, db: state.features.servers ? state.db : null, keys: serverKeys },
  };
}

/**
 * 読み取り API の対象サーバー(docs/API.md 1.2): クエリ `server` → 選択 Cookie → 最初に使えるサーバー
 */
export function resolveReadTarget(api: ApiContext, request: Request): Promise<ServerOutcome<ResolvedServer>> {
  const query = new URL(request.url).searchParams.get('server');
  return resolveServerForRead(api.servers, query, readCookie(request, serverCookieName(IS_DEV)));
}

/**
 * /api/* のハンドラを包む: ApiContext を用意し、想定外の例外は INTERNAL_ERROR にする
 * (例外のメッセージには入力値・接続先が含まれ得るので、ログには名前だけを出す)
 */
export function apiHandler(fn: (api: ApiContext, context: APIContext) => Promise<Response>): APIRoute {
  return async (context) => {
    try {
      const api = await getApiContext(context.locals);
      if (!api) return jsonError('INTERNAL_ERROR');
      return await fn(api, context);
    } catch (err) {
      console.error(JSON.stringify({ kind: 'api-error', path: new URL(context.request.url).pathname, error: errName(err) }));
      return jsonError('INTERNAL_ERROR');
    }
  };
}

export const methodNotAllowedRoute: APIRoute = async (context) => {
  await discardBody(context.request);
  return methodNotAllowed();
};
