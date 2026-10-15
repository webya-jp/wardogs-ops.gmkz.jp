// ログイン後のページ(Astro)で使う共通の値。サーバー側専用(React アイランドから import しない)。
// 言語・タイムゾーンはここで 1 回だけ決め、アイランドには props で渡す(docs/ARCHITECTURE.md 13.3)。
// warnings は設定と D1 の状態から作る初期値。LOGIN_FAILURES_HIGH を含む最新値はアイランドが /api/session で取り直す。
import { checkConfig, collectWarnings, getFeatures } from '../lib/config';
import { getEnv } from '../lib/runtime';
import { getTranslator, resolveLanguage, resolveTimeZone } from '../i18n';
import type { Language, Translator } from '../i18n';
import type { Features, SessionInfo, SetupWarning } from '../types/api';

export interface PageContext {
  language: Language;
  timeZone: string;
  t: Translator;
  session: SessionInfo | null;
  features: Features;
  warnings: SetupWarning[];
}

export async function getPageContext(request: Request, locals: App.Locals): Promise<PageContext> {
  const env = getEnv();
  const language = resolveLanguage(env.LANGUAGE, request.headers.get('Accept-Language'));
  const timeZone = resolveTimeZone(env.TIMEZONE);
  const state = await getFeatures(env);
  const warnings = collectWarnings(checkConfig(env), state);
  return { language, timeZone, t: getTranslator(language), session: locals.session, features: state.features, warnings };
}

