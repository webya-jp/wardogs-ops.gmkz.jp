// BAN 画面(/bans)。手動更新。行ごとに BAN 解除(確認ダイアログを通す)。docs/ARCHITECTURE.md 9 章。
// 一覧の上に解除の説明(action.help.unban)。理由・実行者は RCON の生データ、名前は監査ログからの補完(翻訳しない)。Steam ID は全桁表示(確定 U-3)。
import { useState } from 'react';
import { STEAM_ID_PATTERN } from '../types/api';
import type { BansResponse } from '../types/api';
import { useCapabilities, useI18n, useResource } from './lib/hooks';
import type { I18nProps } from './lib/hooks';
import { gateFor } from './lib/gate';
import { withServer } from './lib/api';
import ConfirmDialog from './ConfirmDialog';
import type { ActionRequestSpec, TargetServer } from './ConfirmDialog';
import ErrorView from './ErrorView';
import GateNotes from './GateNotes';
import ActionHelp, { actionHelpId } from './ActionHelp';
import { refreshSharedStatus } from './lib/status-store';

interface Props extends I18nProps {
  writesEnabled: boolean;
  /** 選択中のサーバー。すべての API 呼び出しに明示して送る(docs/ARCHITECTURE.md 15.5) */
  server: TargetServer;
}

const ACTIONS = ['unban'] as const;

export default function BansTable({ language, timeZone, writesEnabled, server }: Props) {
  const i18n = useI18n({ language, timeZone });
  const { t, time, dateTime, num } = i18n;
  const bans = useResource<BansResponse>(withServer('/api/bans', server.id), null);
  const caps = useCapabilities(server.id);
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
      <ActionHelp actions={ACTIONS} t={t} />
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
                        aria-describedby={actionHelpId('unban')}
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
      <ConfirmDialog i18n={i18n} server={server} request={request} onClose={() => setRequest(null)} onDone={() => {
          bans.refresh();
          refreshSharedStatus(server.id);
        }}
      />
    </section>
  );
}
