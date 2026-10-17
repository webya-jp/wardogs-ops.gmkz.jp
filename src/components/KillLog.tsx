// キルログ(docs/ARCHITECTURE.md 17.10.7 の 9)。
// - フィルタのボタン 8 個(aria-pressed、横に折り返す)、検索欄(type="search"、200 ms で反映)、「JSON で書き出す」、件数
// - 新しい順に KILLFEED_LOG_PAGE 行ずつ(「さらに表示」)。データは全件をブラウザが持つ
// - 1 行: 受信時刻(秒まで)とゲーム内時刻 / キラー(陣営の印 + 名前)/ 武器・原因と印 / 被害者 / 距離 / 詳細
//   768px 以上は列を揃えた行、未満はカード(ops.css の .kill-entry。横スクロールを出さない。長い名前は折り返す)
// - 「詳細」はその場に開く(Steam ID の全桁、陣営と出所、武器・乗り物の内部 ID、イベントの時刻、番号)
// プレイヤー名・陣営名・武器名は生データ。React の文字列の子要素として描画する(HTML として解釈しない)。
import { useEffect, useMemo, useState } from 'react';
import { KILL_FILTERS, KILL_FLAGS, KILLFEED_LOG_PAGE, KILLFEED_POLL_SEC, KILLFEED_SEARCH_MAX_LENGTH } from '../types/api';
import type { KillEvent, KillFilter, KillParty } from '../types/api';
import type { I18n } from './lib/hooks';
import { meters, partyName, weaponLabel } from './lib/killfmt';
import { filterKills, formatGameTime } from './lib/killstats';
import type { TimeRange } from './lib/killstats';
import FactionBadge from './FactionBadge';

interface Props {
  i18n: I18n;
  /** 絞り込み前の全件(古い順) */
  kills: readonly KillEvent[];
  factions: readonly string[];
  /** 時間帯の棒の選択(KillTimelineChart) */
  bucket: TimeRange | null;
  /** 差分を自動で取っている(記録中・記録外) */
  live: boolean;
  /** 上限で打ち切った(全件の取得) */
  truncated: boolean;
  /** JSON で書き出す。失敗したら false */
  onExport: () => boolean;
}

const SEARCH_DEBOUNCE_MS = 200;

export default function KillLog({ i18n, kills, factions, bucket, live, truncated, onExport }: Props) {
  const { t, num } = i18n;
  const [filter, setFilter] = useState<KillFilter>('all');
  const [input, setInput] = useState('');
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(KILLFEED_LOG_PAGE);
  const [exportFailed, setExportFailed] = useState(false);

  useEffect(() => {
    const id = setTimeout(() => setQuery(input), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [input]);

  // 絞り込みが変わったら先頭のページに戻す
  useEffect(() => {
    setLimit(KILLFEED_LOG_PAGE);
  }, [filter, query, bucket]);

  const filtered = useMemo(() => filterKills(kills, filter, query, bucket).reverse(), [kills, filter, query, bucket]);
  const shown = filtered.slice(0, limit);

  return (
    <section className="card" aria-labelledby="kill-log-title">
      <div className="toolbar">
        <h2 id="kill-log-title">{t('killfeed.log.title')}</h2>
        <span className="spacer" />
        <button
          type="button"
          className="button-small"
          onClick={() => setExportFailed(!onExport())}
          disabled={kills.length === 0}
          aria-describedby="kill-export-help"
        >
          {t('killfeed.export.button')}
        </button>
      </div>
      <p id="kill-export-help" className="muted">
        {t('killfeed.export.help')}
      </p>
      {exportFailed && (
        <p className="alert alert-error" role="alert">
          {t('killfeed.export.failed')}
        </p>
      )}
      {live && <p className="muted">{t('killfeed.log.live', { seconds: num(KILLFEED_POLL_SEC) })}</p>}
      {truncated && <p className="alert alert-warn">{t('killfeed.log.truncated', { count: num(kills.length) })}</p>}

      <div className="kill-filters" role="group" aria-label={t('killfeed.log.filterLabel')}>
        {KILL_FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            className={f === filter ? 'button-small is-active' : 'button-small'}
            aria-pressed={f === filter}
            onClick={() => setFilter(f)}
          >
            {t(`killfeed.filter.${f}`)}
          </button>
        ))}
      </div>
      <div className="field kill-search">
        <label htmlFor="kill-search">{t('killfeed.log.searchLabel')}</label>
        <input
          id="kill-search"
          type="search"
          autoComplete="off"
          spellCheck={false}
          maxLength={KILLFEED_SEARCH_MAX_LENGTH}
          placeholder={t('killfeed.log.searchPlaceholder')}
          value={input}
          onChange={(e) => setInput(e.target.value)}
        />
      </div>
      <p className="muted" aria-live="polite">
        {t('killfeed.log.count', { shown: num(filtered.length), total: num(kills.length) })}
      </p>

      {kills.length === 0 ? (
        <p className="muted">{t('killfeed.log.noKills')}</p>
      ) : filtered.length === 0 ? (
        <p className="muted">{t('killfeed.log.empty')}</p>
      ) : (
        <ol className="kill-list">
          {shown.map((k) => (
            <KillEntry key={k.id} i18n={i18n} kill={k} factions={factions} />
          ))}
        </ol>
      )}

      {filtered.length > shown.length && (
        <div className="button-row tight">
          <button type="button" onClick={() => setLimit((n) => n + KILLFEED_LOG_PAGE)}>
            {t('killfeed.log.more')}
          </button>
        </div>
      )}
    </section>
  );
}

interface EntryProps {
  i18n: I18n;
  kill: KillEvent;
  factions: readonly string[];
}

function KillEntry({ i18n, kill: k, factions }: EntryProps) {
  const { t, time } = i18n;
  const [open, setOpen] = useState(false);
  const detailId = `kill-detail-${k.id}`;
  const flags = KILL_FLAGS.filter((f) => k.flags[f]);

  return (
    <li className="kill-entry">
      <div className="kl-time">
        <span>{t('killfeed.log.received', { time: time(k.receivedAt) })}</span>
        {k.gameTimeSec !== null && <span className="muted">{t('killfeed.log.gameTime', { time: formatGameTime(k.gameTimeSec) })}</span>}
      </div>
      <div className="kl-party kl-killer">
        <span className="visually-hidden">{t('killfeed.log.killer')}</span>
        {k.killer && <FactionBadge i18n={i18n} faction={k.killer.faction} factions={factions} />}
        <span className={k.killer ? 'kl-name' : 'kl-name muted'}>{partyName(i18n, k.killer)}</span>
      </div>
      <span className="kl-arrow" aria-hidden="true">
        {t('killfeed.log.arrow')}
      </span>
      <div className="kl-weapon">
        <span className="visually-hidden">{t('killfeed.log.weapon')}</span>
        <span className="kl-weapon-name">{weaponLabel(i18n, k)}</span>
        {(flags.length > 0 || k.teamkill === true) && (
          <span className="kl-flags">
            <span className="visually-hidden">{t('killfeed.log.flags')}</span>
            {flags.map((f) => (
              <span key={f} className={`kill-flag kill-flag-${f}`}>
                {t(`killfeed.flag.${f}`)}
              </span>
            ))}
            {k.teamkill === true && <span className="kill-flag kill-flag-teamkill">{t('killfeed.flag.teamkill')}</span>}
          </span>
        )}
      </div>
      <div className="kl-party kl-victim">
        <span className="visually-hidden">{t('killfeed.log.victim')}</span>
        {k.victim && <FactionBadge i18n={i18n} faction={k.victim.faction} factions={factions} />}
        <span className="kl-name">{partyName(i18n, k.victim)}</span>
      </div>
      <div className="kl-distance">
        <span className="visually-hidden">{t('killfeed.log.distance')}</span>
        {k.distanceM !== null ? (
          t('killfeed.log.distanceValue', { distance: meters(i18n, k.distanceM) })
        ) : (
          <span className="muted">{t('killfeed.log.distanceUnknown')}</span>
        )}
      </div>
      <div className="kl-more">
        <button type="button" className="button-link" aria-expanded={open} aria-controls={detailId} onClick={() => setOpen((v) => !v)}>
          {t('killfeed.log.details')}
        </button>
      </div>
      {open && (
        <div id={detailId} className="kl-detail" role="region" aria-label={t('killfeed.log.detailsTitle')}>
          <KillDetail i18n={i18n} kill={k} />
        </div>
      )}
    </li>
  );
}

function PartyDetail({ i18n, label, party }: { i18n: I18n; label: string; party: KillParty | null }) {
  const { t } = i18n;
  const faction = (p: KillParty) => {
    if (p.faction === null) return t('killfeed.faction.unknownLabel');
    if (p.factionSource === null) return p.faction;
    return t('killfeed.log.factionWithSource', { faction: p.faction, source: t(`killfeed.factionSource.${p.factionSource}`) });
  };
  return (
    <>
      <dt>{label}</dt>
      <dd>
        {partyName(i18n, party)}
        {party && (
          <dl className="kv kl-sub">
            <dt>{t('killfeed.log.detailSteamId')}</dt>
            <dd className="steam-id">{party.steamId ?? t('common.unknown')}</dd>
            <dt>{t('killfeed.log.detailFaction')}</dt>
            <dd>{faction(party)}</dd>
          </dl>
        )}
      </dd>
    </>
  );
}

function KillDetail({ i18n, kill: k }: { i18n: I18n; kill: KillEvent }) {
  const { t, dateTime } = i18n;
  const sep = t('status.listSeparator');
  const vehicle = k.vehicle ? [k.vehicle.name, k.vehicle.id].filter((v): v is string => v !== null).join(sep) : null;
  return (
    <dl className="kv">
      <PartyDetail i18n={i18n} label={t('killfeed.log.killer')} party={k.killer} />
      <PartyDetail i18n={i18n} label={t('killfeed.log.victim')} party={k.victim} />
      <dt>{t('killfeed.log.detailWeaponId')}</dt>
      <dd className="mono">{k.weapon.id ?? t('common.none')}</dd>
      <dt>{t('killfeed.log.detailVehicle')}</dt>
      <dd className="mono">{vehicle || t('common.none')}</dd>
      <dt>{t('killfeed.log.detailEventAt')}</dt>
      <dd>{k.eventAt !== null ? dateTime(k.eventAt) : t('common.none')}</dd>
      <dt>{t('killfeed.log.detailId')}</dt>
      <dd className="mono">{String(k.id)}</dd>
    </dl>
  );
}
