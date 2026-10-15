// API の失敗を表示する。文言は code でカタログ(error.<code>・validation.<issue>)から引く。
// rconMessage は RCON の生データなので翻訳せず、補足としてそのまま出す(docs/ARCHITECTURE.md 3.1・13.5)。
import { MESSAGE_MAX_LENGTH, POLL_MIN_INTERVAL_SEC, REASON_MAX_LENGTH } from '../types/api';
import type { MessageKey, Translator } from '../i18n';
import type { ClientError } from './lib/api';
import { isMessageKey } from './lib/keys';

const FIELD_LABELS: Record<string, MessageKey> = {
  steamId: 'field.steamId',
  reason: 'field.reason',
  message: 'field.message',
  map: 'field.map',
};

const FIELD_MAX: Record<string, number> = {
  reason: REASON_MAX_LENGTH,
  message: MESSAGE_MAX_LENGTH,
};

export function errorText(error: ClientError, t: Translator): string {
  const key = `error.${error.code}`;
  if (!isMessageKey(key)) return t('error.INTERNAL_ERROR');
  return t(key, { seconds: error.retryAfterSec ?? POLL_MIN_INTERVAL_SEC });
}

export function fieldIssueText(field: string, error: ClientError | null, t: Translator): string | null {
  const issue = error?.fields?.[field];
  if (!issue) return null;
  const key = `validation.${issue}`;
  return isMessageKey(key) ? t(key, { max: FIELD_MAX[field] ?? '' }) : t('error.VALIDATION_FAILED');
}

interface Props {
  error: ClientError;
  t: Translator;
  /** 先頭に出す見出し(例 「実行できませんでした」) */
  lead?: string;
  /** 入力欄の近くに個別に出している項目(ここでは繰り返さない) */
  inlineFields?: readonly string[];
}

export default function ErrorView({ error, t, lead, inlineFields = [] }: Props) {
  const fields = Object.entries(error.fields ?? {}).filter(([name]) => !inlineFields.includes(name));
  return (
    <div className="alert alert-error" role="alert">
      {lead && <p><strong>{lead}</strong></p>}
      <p>{errorText(error, t)}</p>
      {fields.length > 0 && (
        <ul>
          {fields.map(([name, issue]) => {
            const label = FIELD_LABELS[name];
            const issueKey = `validation.${issue}`;
            const issueText = isMessageKey(issueKey) ? t(issueKey, { max: FIELD_MAX[name] ?? '' }) : t('error.VALIDATION_FAILED');
            return <li key={name}>{label ? t('common.fieldLine', { field: t(label), issue: issueText }) : issueText}</li>;
          })}
        </ul>
      )}
      {error.rconMessage && (
        <p>
          {t('common.rconDetail')} <code>{error.rconMessage}</code>
        </p>
      )}
    </div>
  );
}
