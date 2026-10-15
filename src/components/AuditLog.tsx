// 操作ログ画面(/audit)。手動更新。50 件ずつ before でページングする(docs/ARCHITECTURE.md 9 章、docs/API.md 3 章)。
// 文はカタログ(audit.event.<event>・audit.status.<status>・audit.param.*)で組み立て、Worker の文言は使わない。
// 操作者名・対象名・理由・メッセージ本文・サーバーの表示名は入力値/RCON の生データなので翻訳しない。
// 複数サーバー(docs/ARCHITECTURE.md 15.7): 「操作」(audit_log)と「設定変更」(settings_audit_log)のタブ(kind)。
// 「操作」はサーバーで絞り込める(既定は全サーバー server=all)。各行にサーバー名(記録時点の表示名)を出す。
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AuditEntry, AuditKind, AuditResponse, ServerId } from '../types/api';
import { apiGet } from './lib/api';
import type { ClientError } from './lib/api';
import { useI18n } from './lib/hooks';
import type { I18nProps } from './lib/hooks';
import { isMessageKey } from './lib/keys';
import { auditServerLabel } from './lib/servers';
import ErrorView, { errorText } from './ErrorView';

const PAGE_SIZE = 50;
/** pending のまま これ以上経った行は「結果不明」と表示する(docs/ARCHITECTURE.md 4.3) */
const PENDING_UNKNOWN_MS = 60_000;
/** 文字列の params(操作の reason / message / map、設定変更の name / host) */
const STRING_PARAM_KEYS = ['reason', 'message', 'map', 'name', 'host'] as const;
const KINDS: readonly AuditKind[] = ['operations', 'settings'];
const ALL = 'all';

interface Props extends I18nProps {
  /** 絞り込みに出すサーバー(現在登録されているもの。削除済みのサーバーのログは「すべてのサーバー」で見る) */
  servers: { id: ServerId; label: string }[];
}

export default function AuditLog({ language, timeZone, servers }: Props) {
  const i18n = useI18n({ language, timeZone });
  const { t, time, dateTime, num } = i18n;
  const [kind, setKind] = useState<AuditKind>('operations');
  const [serverFilter, setServerFilter] = useState<string>(ALL);
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [available, setAvailable] = useState<boolean | null>(null);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [error, setError] = useState<ClientError | null>(null);
  const [loading, setLoading] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  /** 種類・絞り込みを変えた後に、古い条件の応答で上書きしないための通し番号 */
  const seq = useRef(0);

  const load = useCallback(async (before: number | null, k: AuditKind, server: string) => {
    const mySeq = ++seq.current;
    setLoading(true);
    const qs = new URLSearchParams({ kind: k, server: k === 'operations' ? server : ALL, limit: String(PAGE_SIZE) });
    if (before !== null) qs.set('before', String(before));
    const r = await apiGet<AuditResponse>(`/api/audit?${qs.toString()}`);
    if (mySeq !== seq.current) return;
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
    setEntries([]);
    setNextBefore(null);
    setAvailable(null);
    void load(null, kind, serverFilter);
  }, [load, kind, serverFilter]);

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
    const lines: { key: string; text: string }[] = STRING_PARAM_KEYS.flatMap((key) => {
      const v = e.params[key];
      return typeof v === 'string' && v !== '' ? [{ key, text: t(`audit.param.${key}`, { value: v }) }] : [];
    });
    // 設定変更の行(settings_audit_log)の数値・真偽の項目。パスワードそのものは記録されていない
    const port = e.params.port;
    if (typeof port === 'number') lines.push({ key: 'port', text: t('audit.param.port', { value: String(port) }) });
    const enabled = e.params.enabled;
    if (typeof enabled === 'boolean') {
      lines.push({ key: 'enabled', text: t(enabled ? 'audit.param.enabledTrue' : 'audit.param.enabledFalse') });
    }
    if (e.params.passwordChanged === true) lines.push({ key: 'passwordChanged', text: t('audit.param.passwordChanged') });
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

  const isSettings = kind === 'settings';

  return (
    <section aria-labelledby="audit-title">
      <div className="toolbar">
        <h1 id="audit-title">{t('audit.title')}</h1>
        <span className="spacer" />
        <button type="button" className="button-small" onClick={() => void load(null, kind, serverFilter)} disabled={loading}>
          {loading ? t('common.loading') : t('common.refresh')}
        </button>
      </div>
      <div className="segmented" role="group" aria-label={t('audit.kind.label')}>
        {KINDS.map((k) => (
          <button
            key={k}
            type="button"
            className={k === kind ? 'is-active' : undefined}
            aria-pressed={k === kind}
            onClick={() => setKind(k)}
          >
            {t(`audit.kind.${k}`)}
          </button>
        ))}
      </div>
      {!isSettings && servers.length > 0 && (
        <div className="field filter-field">
          <label htmlFor="audit-server-filter">{t('audit.serverFilter.label')}</label>
          <select id="audit-server-filter" value={serverFilter} onChange={(e) => setServerFilter(e.target.value)}>
            <option value={ALL}>{t('audit.serverFilter.all')}</option>
            {servers.map((sv) => (
              <option key={sv.id} value={sv.id}>
                {sv.label}
              </option>
            ))}
          </select>
          <small>{t('audit.serverFilter.help')}</small>
        </div>
      )}
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
                <th scope="col">{t('audit.col.server')}</th>
                <th scope="col">{t('audit.col.event')}</th>
                {!isSettings && <th scope="col">{t('audit.col.target')}</th>}
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
                  <td data-label={t('audit.col.server')}>{auditServerLabel(e.serverId, e.serverName, t)}</td>
                  <td data-label={t('audit.col.event')}>{eventLabel(e.event)}</td>
                  {!isSettings && <td data-label={t('audit.col.target')}>{targetCell(e)}</td>}
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
            <button type="button" onClick={() => void load(nextBefore, kind, serverFilter)} disabled={loading}>
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
