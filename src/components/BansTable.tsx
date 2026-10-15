// BAN 画面(/bans)。手動更新。行ごとに BAN 解除(確認ダイアログを通す)。docs/ARCHITECTURE.md 9 章。
// 理由・実行者は RCON の生データ、名前は監査ログからの補完(翻訳しない)。Steam ID は全桁表示(確定 U-3)。
import { useState } from 'react';
import { STEAM_ID_PATTERN } from '../types/api';
import type { BansResponse } from '../types/api';
import { useCapabilities, useI18n, useResource } from './lib/hooks';
import type { I18nProps } from './lib/hooks';
import { gateFor } from './lib/gate';
import ConfirmDialog from './ConfirmDialog';
import type { ActionRequestSpec } from './ConfirmDialog';
import ErrorView from './ErrorView';
import GateNotes from './GateNotes';

interface Props extends I18nProps {
  writesEnabled: boolean;
}

const ACTIONS = ['unban'] as const;

export default function BansTable({ language, timeZone, writesEnabled }: Props) {
  const i18n = useI18n({ language, timeZone });
  const { t, time, dateTime, num } = i18n;
  const bans = useResource<BansResponse>('/api/bans', null);
  const caps = useCapabilities();
  const [request, setRequest] = useState<ActionRequestSpec | null>(null);
  const unbanGate = gateFor('unban', caps, writesEnabled);
  const list = bans.data?.bans ?? [];

  return (
    <section aria-labelledby="bans-title">
      <div className="toolbar">
        <h1 id="bans-title">{t('bans.title')}</h1>
        {bans.data && <span className="badge">{t('bans.count', { count: num(bans.data.count) })}</span>}
        <span className="spacer" />
        <button type="button" className="button-small" onClick={bans.refresh} disabled={bans.loading}>
          {bans.loading ? t('common.loading') : t('common.refresh')}
        </button>
      </div>
      <p className="muted">
        {bans.updatedAt !== null && <>{t('common.lastUpdated', { time: time(bans.updatedAt) })} </>}
        {t('common.manualRefresh')}
      </p>
      <GateNotes actions={ACTIONS} caps={caps} writesEnabled={writesEnabled} t={t} />
      {bans.error && (
        <>
          <ErrorView error={bans.error} t={t} />
          {bans.data && <p className="muted">{t('common.staleData')}</p>}
        </>
      )}
      {!bans.data && !bans.error && <p aria-live="polite">{t('common.loading')}</p>}
      {bans.data && list.length === 0 && <p className="card">{t('bans.empty')}</p>}
      {list.length > 0 && (
        <div className="table-wrap">
          <table className="table-cards">
            <thead>
              <tr>
                <th scope="col">{t('bans.col.steamId')}</th>
                <th scope="col">{t('bans.col.knownName')}</th>
                <th scope="col">{t('bans.col.bannedAt')}</th>
                <th scope="col">{t('bans.col.reason')}</th>
                <th scope="col">{t('bans.col.bannedBy')}</th>
                <th scope="col">{t('bans.col.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {list.map((b) => (
                <tr key={b.steamId}>
                  <td data-label={t('bans.col.steamId')}>
                    <span className="steam-id">{b.steamId}</span>
                  </td>
                  <td data-label={t('bans.col.knownName')}>{b.knownName ?? t('common.none')}</td>
                  <td data-label={t('bans.col.bannedAt')}>{b.bannedAt === null ? t('common.unknown') : dateTime(b.bannedAt)}</td>
                  <td data-label={t('bans.col.reason')}>{b.reason ?? t('common.none')}</td>
                  <td data-label={t('bans.col.bannedBy')}>{b.bannedBy ?? t('common.none')}</td>
                  <td className="actions">
                    {STEAM_ID_PATTERN.test(b.steamId) ? (
                      <button
                        type="button"
                        className="button-small"
                        disabled={unbanGate.disabled}
                        onClick={() => setRequest({ action: 'unban', params: { steamId: b.steamId } })}
                      >
                        {t('bans.unban')}
                      </button>
                    ) : (
                      <span className="muted">{t('players.invalidSteamId')}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <ConfirmDialog i18n={i18n} request={request} onClose={() => setRequest(null)} onDone={() => bans.refresh()} />
    </section>
  );
}
