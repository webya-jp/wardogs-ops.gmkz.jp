// 操作ログ画面(/audit)。手動更新。50 件ずつ before でページングする(docs/ARCHITECTURE.md 9 章、docs/API.md 3 章)。
// 文はカタログ(audit.event.<event>・audit.status.<status>・audit.param.*)で組み立て、Worker の文言は使わない。
// 操作者名・対象名・理由・メッセージ本文は入力値/RCON の生データなので翻訳しない。
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AuditEntry, AuditResponse } from '../types/api';
import { apiGet } from './lib/api';
import type { ClientError } from './lib/api';
import { useI18n } from './lib/hooks';
import type { I18nProps } from './lib/hooks';
import { isMessageKey } from './lib/keys';
import ErrorView, { errorText } from './ErrorView';

const PAGE_SIZE = 50;
/** pending のまま これ以上経った行は「結果不明」と表示する(docs/ARCHITECTURE.md 4.3) */
const PENDING_UNKNOWN_MS = 60_000;
const PARAM_KEYS = ['reason', 'message', 'map'] as const;

export default function AuditLog({ language, timeZone }: I18nProps) {
  const i18n = useI18n({ language, timeZone });
  const { t, time, dateTime, num } = i18n;
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [error, setError] = useState<ClientError | null>(null);
  const [loading, setLoading] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const busy = useRef(false);

  const load = useCallback(async (before: number | null) => {
    if (busy.current) return;
    busy.current = true;
    setLoading(true);
    const qs = new URLSearchParams({ limit: String(PAGE_SIZE) });
    if (before !== null) qs.set('before', String(before));
    const r = await apiGet<AuditResponse>(`/api/audit?${qs.toString()}`);
    busy.current = false;
    setLoading(false);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    setError(null);
    setAvailable(r.data.available);
    setNextBefore(r.data.nextBefore);
    setEntries((prev) => (before === null ? r.data.entries : [...prev, ...r.data.entries]));
    if (before === null) setUpdatedAt(Date.now());
  }, []);

  useEffect(() => {
    void load(null);
  }, [load]);

  const now = Date.now();

  const eventLabel = (event: string) => {
    const key = `audit.event.${event}`;
    return isMessageKey(key) ? t(key) : event;
  };

  const resultCell = (e: AuditEntry) => {
    if (e.status === 'unknown') {
      return (
        <>
          <span className="badge badge-warn">{t('audit.status.unknown')}</span>
          <div className="muted">{t('audit.status.unknownHelp')}</div>
        </>
      );
    }
    if (e.status === 'pending') {
      const unknown = now - e.createdAt >= PENDING_UNKNOWN_MS;
      return (
        <>
          <span className="badge badge-warn">{unknown ? t('audit.status.unknown') : t('audit.status.pending')}</span>
          {unknown && <div className="muted">{t('audit.status.unknownHelp')}</div>}
        </>
      );
    }
    if (e.status === 'succeeded') return <span className="badge badge-ok">{t('audit.status.succeeded')}</span>;
    return (
      <>
        <span className="badge badge-error">{t('audit.status.failed')}</span>
        {e.errorCode && <div className="muted">{errorText({ code: e.errorCode }, t)}</div>}
        {e.rconStatus !== null && <div className="muted">{t('audit.rconStatus', { status: e.rconStatus })}</div>}
      </>
    );
  };

  const detailsCell = (e: AuditEntry) => {
    const lines = PARAM_KEYS.flatMap((key) => {
      const v = e.params[key];
      return typeof v === 'string' && v !== '' ? [{ key, text: t(`audit.param.${key}`, { value: v }) }] : [];
    });
    if (lines.length === 0) return t('common.none');
    return lines.map((l) => <div key={l.key}>{l.text}</div>);
  };

  const targetCell = (e: AuditEntry) => {
    if (!e.targetName && !e.targetSteamId) return t('common.none');
    return (
      <>
        {e.targetName && <div>{e.targetName}</div>}
        {e.targetSteamId && <div className="steam-id">{e.targetSteamId}</div>}
      </>
    );
  };

  return (
    <section aria-labelledby="audit-title">
      <div className="toolbar">
        <h1 id="audit-title">{t('audit.title')}</h1>
        <span className="spacer" />
        <button type="button" className="button-small" onClick={() => void load(null)} disabled={loading}>
          {loading ? t('common.loading') : t('common.refresh')}
        </button>
      </div>
      <p className="muted">
        {updatedAt !== null && <>{t('common.lastUpdated', { time: time(updatedAt) })} </>}
        {t('common.manualRefresh')}
      </p>
      {error && <ErrorView error={error} t={t} />}
      {available === null && !error && <p aria-live="polite">{t('common.loading')}</p>}
      {available === false && <p className="alert alert-warn">{t('audit.unavailable')}</p>}
      {available === true && entries.length === 0 && <p className="card">{t('audit.empty')}</p>}
      {entries.length > 0 && (
        <div className="table-wrap">
          <table className="table-cards">
            <thead>
              <tr>
                <th scope="col">{t('audit.col.time')}</th>
                <th scope="col">{t('audit.col.operator')}</th>
                <th scope="col">{t('audit.col.event')}</th>
                <th scope="col">{t('audit.col.target')}</th>
                <th scope="col">{t('audit.col.details')}</th>
                <th scope="col">{t('audit.col.result')}</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id}>
                  <td data-label={t('audit.col.time')} className="num">
                    {dateTime(e.createdAt)}
                  </td>
                  <td data-label={t('audit.col.operator')}>
                    {e.operator ?? t('audit.anonymous', { tag: e.sessionTag ?? t('common.unknown') })}
                  </td>
                  <td data-label={t('audit.col.event')}>{eventLabel(e.event)}</td>
                  <td data-label={t('audit.col.target')}>{targetCell(e)}</td>
                  <td data-label={t('audit.col.details')}>{detailsCell(e)}</td>
                  <td data-label={t('audit.col.result')}>{resultCell(e)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {available === true && entries.length > 0 && (
        <div className="button-row">
          {nextBefore !== null ? (
            <button type="button" onClick={() => void load(nextBefore)} disabled={loading}>
              {loading ? t('common.loading') : t('audit.loadMore', { count: num(PAGE_SIZE) })}
            </button>
          ) : (
            <p className="muted">{t('audit.end')}</p>
          )}
        </div>
      )}
    </section>
  );
}
