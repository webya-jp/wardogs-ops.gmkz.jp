// 状態画面(/)。/api/status を 30 秒ごとに取得し、broadcast・マップ変更・試合終了を操作する(docs/ARCHITECTURE.md 9 章)。
// サーバー名・マップ名・陣営名は RCON の生データなので翻訳しない。
import { Fragment, useMemo, useState } from 'react';
import { MESSAGE_MAX_LENGTH, POLL_MIN_INTERVAL_SEC } from '../types/api';
import type { MapsResponse, StatusResponse } from '../types/api';
import { useCapabilities, useI18n, useResource } from './lib/hooks';
import type { I18nProps } from './lib/hooks';
import { gateFor } from './lib/gate';
import { withServer } from './lib/api';
import ConfirmDialog from './ConfirmDialog';
import type { ActionRequestSpec, TargetServer } from './ConfirmDialog';
import ErrorView from './ErrorView';
import GateNotes from './GateNotes';

interface Props extends I18nProps {
  writesEnabled: boolean;
  /** 選択中のサーバー。すべての API 呼び出しに明示して送る(docs/ARCHITECTURE.md 15.5) */
  server: TargetServer;
}

const ACTIONS = ['broadcast', 'map', 'match_end'] as const;

export default function StatusPanel({ language, timeZone, writesEnabled, server }: Props) {
  const i18n = useI18n({ language, timeZone });
  const { t, time, num } = i18n;
  const status = useResource<StatusResponse>(withServer('/api/status', server.id), POLL_MIN_INTERVAL_SEC);
  const maps = useResource<MapsResponse>(withServer('/api/maps', server.id), null);
  const caps = useCapabilities(server.id);
  const [request, setRequest] = useState<ActionRequestSpec | null>(null);
  const [message, setMessage] = useState('');
  const [mapId, setMapId] = useState('');

  const mapNames = useMemo(() => {
    const out: Record<string, string | null> = {};
    for (const m of maps.data?.maps ?? []) out[m.id] = m.displayName;
    return out;
  }, [maps.data]);

  const s = status.data;
  const broadcastGate = gateFor('broadcast', caps, writesEnabled);
  const mapGate = gateFor('map', caps, writesEnabled);
  const endGate = gateFor('match_end', caps, writesEnabled);
  const currentMapName = s?.map ? (mapNames[s.map] ?? null) : null;

  return (
    <>
      <section className="card" aria-labelledby="status-title">
        <div className="toolbar">
          <h1 id="status-title">
            {t('status.title')}
          </h1>
          <span className="spacer" />
          <button type="button" className="button-small" onClick={status.refresh} disabled={status.loading}>
            {status.loading ? t('common.loading') : t('common.refresh')}
          </button>
        </div>
        <p className="muted">
          {status.updatedAt !== null && <>{t('common.lastUpdated', { time: time(status.updatedAt) })} </>}
          {t('common.autoRefresh', { seconds: POLL_MIN_INTERVAL_SEC })}
        </p>
        {status.error && (
          <>
            <ErrorView error={status.error} t={t} />
            {s && <p className="muted">{t('common.staleData')}</p>}
          </>
        )}
        {!s && !status.error && <p aria-live="polite">{t('common.loading')}</p>}
        {s && (
          <>
            <div className="stat-grid">
              <div className="stat">
                <span className="stat-label">{t('status.serverName')}</span>
                <span className="stat-value">{s.serverName ?? t('common.unknown')}</span>
              </div>
              <div className="stat">
                <span className="stat-label">{t('status.map')}</span>
                <span className="stat-value">{currentMapName ?? s.map ?? t('common.unknown')}</span>
                {currentMapName && s.map && <span className="muted mono">{s.map}</span>}
              </div>
              <div className="stat">
                <span className="stat-label">{t('status.players')}</span>
                <span className="stat-value">
                  {t('status.playersValue', { current: num(s.players.current), max: num(s.players.max) })}
                </span>
              </div>
              <div className="stat">
                <span className="stat-label">{t('status.rotation')}</span>
                <span className="stat-value">
                  {t('status.rotationValue', { now: num(s.rotation.nowIndex), next: num(s.rotation.nextIndex) })}
                </span>
              </div>
            </div>
            <h2>{t('status.factionScores')}</h2>
            {s.factionScores.length === 0 ? (
              <p className="muted">{t('status.noScores')}</p>
            ) : (
              <dl className="kv">
                {s.factionScores.map((f, i) => (
                  <Fragment key={i}>
                    <dt>{f.faction ?? t('common.unknown')}</dt>
                    <dd>{num(f.score)}</dd>
                  </Fragment>
                ))}
              </dl>
            )}
          </>
        )}
      </section>

      <GateNotes actions={ACTIONS} caps={caps} writesEnabled={writesEnabled} t={t} />

      <div className="grid-2">
        <section className="card" aria-labelledby="broadcast-title">
          <h2 id="broadcast-title">{t('status.broadcast.title')}</h2>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (message.trim() === '') return;
              setRequest({ action: 'broadcast', params: { message } });
            }}
          >
            <div className="field">
              <label htmlFor="broadcast-message">{t('status.broadcast.label', { max: MESSAGE_MAX_LENGTH })}</label>
              <input
                id="broadcast-message"
                type="text"
                value={message}
                maxLength={MESSAGE_MAX_LENGTH}
                autoComplete="off"
                disabled={broadcastGate.disabled}
                onChange={(e) => setMessage(e.target.value)}
              />
            </div>
            <button type="submit" className="button-primary" disabled={broadcastGate.disabled || message.trim() === ''}>
              {t('status.broadcast.submit')}
            </button>
          </form>
        </section>

        <section className="card" aria-labelledby="map-title">
          <h2 id="map-title">{t('status.mapChange.title')}</h2>
          {maps.error && <ErrorView error={maps.error} t={t} lead={t('status.mapChange.unavailable')} />}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (mapId === '') return;
              setRequest({ action: 'map', params: { map: mapId } });
            }}
          >
            <div className="field">
              <label htmlFor="map-select">{t('status.mapChange.label')}</label>
              <select
                id="map-select"
                value={mapId}
                disabled={mapGate.disabled || !maps.data}
                onChange={(e) => setMapId(e.target.value)}
              >
                <option value="">{t('status.mapChange.placeholder')}</option>
                {(maps.data?.maps ?? []).map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.displayName ? t('confirm.mapValue', { name: m.displayName, id: m.id }) : m.id}
                  </option>
                ))}
              </select>
            </div>
            <div className="button-row tight">
              <button type="button" className="button-small" onClick={maps.refresh} disabled={maps.loading}>
                {t('common.refresh')}
              </button>
              <button type="submit" className="button-outline-danger push-end" disabled={mapGate.disabled || mapId === ''}>
                {t('status.mapChange.submit')}
              </button>
            </div>
          </form>
        </section>
      </div>

      <section className="card danger-zone" aria-labelledby="danger-title">
        <h2 id="danger-title">{t('status.dangerZone')}</h2>
        <p>{t('status.matchEnd.help')}</p>
        <div className="button-row">
          <button
            type="button"
            className="button-outline-danger push-end"
            disabled={endGate.disabled}
            onClick={() => setRequest({ action: 'match_end', params: {} })}
          >
            {t('status.matchEnd.submit')}
          </button>
        </div>
      </section>

      <ConfirmDialog
        i18n={i18n}
        server={server}
        request={request}
        mapNames={mapNames}
        onClose={() => setRequest(null)}
        onDone={(action) => {
          if (action === 'broadcast') setMessage('');
          if (action === 'map') setMapId('');
          status.refresh();
        }}
      />
    </>
  );
}
