// 画面上部のお知らせ: 書き込みの可否(features。D1 が使えればすべて true)と設定の警告(SetupWarning)。
// ログイン後に出し得る警告は LOGIN_FAILURES_HIGH と SERVER_PASSWORDS_UNREADABLE だけ(docs/API.md 2 章)。
// D1_MISSING / D1_NOT_MIGRATED はログイン前の /setup だけで扱うので、ここでは出さない。
// 初期値はサーバー(Astro)が D1 の状態から渡し、表示後に /api/session を 1 回取り直して最新の warnings に置き換える。
import { useEffect, useState } from 'react';
import type { Features, SessionResponse, SetupWarning } from '../types/api';
import type { Language } from '../i18n';
import { getTranslator } from '../i18n';
import { apiGet } from './lib/api';

/** ログイン後の画面に出す警告(表示順) */
const SESSION_WARNINGS = ['SERVER_PASSWORDS_UNREADABLE', 'LOGIN_FAILURES_HIGH'] as const satisfies readonly SetupWarning[];

interface Props {
  language: Language;
  initialFeatures: Features;
  initialWarnings: SetupWarning[];
}

export default function SessionNotices({ language, initialFeatures, initialWarnings }: Props) {
  const t = getTranslator(language);
  const [features, setFeatures] = useState(initialFeatures);
  const [warnings, setWarnings] = useState(initialWarnings);

  useEffect(() => {
    const ctrl = new AbortController();
    void apiGet<SessionResponse>('/api/session', ctrl.signal).then((r) => {
      if (ctrl.signal.aborted || !r.ok) return;
      setFeatures(r.data.features);
      setWarnings(r.data.warnings);
    });
    return () => ctrl.abort();
  }, []);

  const shown = SESSION_WARNINGS.filter((w) => warnings.includes(w));
  const stage = !features.writes ? 'stage.readOnly' : !features.audit ? 'stage.writesWithoutAudit' : null;
  if (!stage && shown.length === 0) return null;

  return (
    <div className="notices" role="region" aria-label={t('notice.label')}>
      {stage && (
        <p className={stage === 'stage.writesWithoutAudit' ? 'alert alert-error' : 'alert alert-warn'}>
          <strong>{t(stage)}</strong>
        </p>
      )}
      {shown.length > 0 && (
        <div className="alert alert-warn">
          <ul>
            {shown.map((w) => (
              <li key={w}>
                {t(`setup.warning.${w}`)}
                {w === 'SERVER_PASSWORDS_UNREADABLE' && (
                  <>
                    {' '}
                    <a href="/servers">{t('server.toSettings')}</a>
                  </>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
