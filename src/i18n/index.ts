/**
 * 多言語化の入口。docs/ARCHITECTURE.md 第 13 章。外部ライブラリは使わない。
 *
 * 命名(2026-10-15 ユーザー決定):
 * - Language: 利用者が触る名前。vars `LANGUAGE` の値(`ja` / `en` などの言語コード)。カタログのファイル名も言語コード
 * - Locale: コード内部で `Intl` に渡す値(`ja-JP` など)。Language → Locale の対応表はこのファイルで持つ
 *
 * - 文言は `t(key, params?)`(既定の言語)、言語を指定する場合は `getTranslator(language)`
 * - 言語の決め方: vars LANGUAGE(対応言語ならそれに固定)→ "auto" のときだけ Accept-Language → 既定 ja
 * - 日時・数値は formatDateTime / formatNumber(Intl に locale とタイムゾーンを渡す。JST 固定で書かない)
 * - サーバー(Astro)とクライアント(React アイランド)の両方から import する。Worker 固有 API に依存させない
 */
import { ja, type Catalog, type MessageKey } from './ja';

export type { Catalog, MessageKey } from './ja';

/** 対応する言語コード。言語を足すときはここ・型 Locale・LANGUAGE_TO_LOCALE・CATALOGS の 4 か所に追加する */
export const SUPPORTED_LANGUAGES = ['ja'] as const;
export type Language = (typeof SUPPORTED_LANGUAGES)[number];

/** Intl に渡す locale(BCP 47)。言語を足すときに追加する(例 'en-US') */
export type Locale = 'ja-JP';

export const LANGUAGE_TO_LOCALE: Record<Language, Locale> = {
  ja: 'ja-JP',
};

export const DEFAULT_LANGUAGE: Language = 'ja';
export const DEFAULT_TIMEZONE = 'Asia/Tokyo';

const CATALOGS: Record<Language, Catalog> = { ja };

export type MessageParams = Record<string, string | number>;

export function isLanguage(value: string): value is Language {
  return (SUPPORTED_LANGUAGES as readonly string[]).includes(value);
}

export function toLocale(language: Language): Locale {
  return LANGUAGE_TO_LOCALE[language];
}

/**
 * 表示する言語を決める。
 * @param configured vars LANGUAGE。対応言語ならそれに固定。"auto" のときだけ Accept-Language を見る
 * @param acceptLanguage リクエストの Accept-Language ヘッダ
 */
export function resolveLanguage(configured: string | undefined, acceptLanguage?: string | null): Language {
  const c = (configured ?? '').trim().toLowerCase();
  if (isLanguage(c)) return c;
  if (c === 'auto' && acceptLanguage) {
    const ranked = acceptLanguage
      .split(',')
      .map((part) => {
        const [tag = '', ...rest] = part.trim().split(';');
        const q = rest.find((r) => r.trim().startsWith('q='));
        const weight = q ? Number(q.trim().slice(2)) : 1;
        return { tag: tag.trim().toLowerCase(), weight: Number.isFinite(weight) ? weight : 0 };
      })
      .filter((x) => x.tag !== '' && x.weight > 0)
      .sort((a, b) => b.weight - a.weight);
    for (const { tag } of ranked) {
      // 'ja-JP' → 'ja'。言語コードだけで照合する
      const base = tag.split('-')[0] ?? '';
      if (isLanguage(base)) return base;
    }
  }
  return DEFAULT_LANGUAGE;
}

/** vars TIMEZONE を検証する。Intl が受け付けない値なら既定(Asia/Tokyo) */
export function resolveTimeZone(configured: string | undefined): string {
  const tz = (configured ?? '').trim();
  if (tz === '') return DEFAULT_TIMEZONE;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return DEFAULT_TIMEZONE;
  }
}

function interpolate(template: string, params?: MessageParams): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : whole,
  );
}

export type Translator = (key: MessageKey, params?: MessageParams) => string;

export function getTranslator(language: Language): Translator {
  const catalog = CATALOGS[language];
  return (key, params) => interpolate(catalog[key] ?? ja[key], params);
}

/** 既定の言語で文言を引く */
export const t: Translator = getTranslator(DEFAULT_LANGUAGE);

/** 日時(UTC epoch ミリ秒)を locale・タイムゾーン指定で整形する */
export function formatDateTime(
  epochMs: number,
  locale: Locale,
  timeZone: string,
  options: Intl.DateTimeFormatOptions = { dateStyle: 'medium', timeStyle: 'medium' },
): string {
  return new Intl.DateTimeFormat(locale, { ...options, timeZone }).format(new Date(epochMs));
}

export function formatNumber(value: number, locale: Locale, options?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(locale, options).format(value);
}
