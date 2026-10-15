// Worker のランタイム値の入口(cloudflare:workers に依存するのはこのファイルと middleware・ページだけ)。
// 単体テストする lib は env を引数で受け取る。
import { env as workersEnv } from 'cloudflare:workers';
import type { APIContext, APIRoute } from 'astro';
import { discardBody, errName, jsonError, methodNotAllowed } from './http';
import type { OpsEnv } from '../types/env';
import { checkConfig, collectWarnings, getFeatures, getRconConfig } from './config';
import type { ConfigCheck, FeatureState, RconConfig } from './config';
import { getKeys } from './keys';
import type { DerivedKeys } from './keys';
import { getAttachedSession } from './session';
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
  rcon: RconConfig;
  keys: DerivedKeys;
  session: SessionData;
  state: FeatureState;
  warnings: SetupWarning[];
}

/**
 * middleware を通った後の /api/* ハンドラ用。設定不足・未ログインは middleware で弾かれているので、
 * ここで null になるのは想定外(呼び出し側は INTERNAL_ERROR を返す)
 */
export async function getApiContext(locals: object): Promise<ApiContext | null> {
  const env = getEnv();
  const config = checkConfig(env);
  const rcon = getRconConfig(env);
  const session = getAttachedSession(locals);
  if (!config.ok || !rcon || !session) return null;
  const [keys, state] = await Promise.all([getKeys(env), getFeatures(env)]);
  return { env, config, rcon, keys, session, state, warnings: collectWarnings(config, state) };
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
