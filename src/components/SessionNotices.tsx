// 画面上部のお知らせ: 段階的有効化の状態(docs/ARCHITECTURE.md 7.4)と設定の警告(SetupWarning)。
// 初期値はサーバー(Astro)が設定と D1 の状態から渡し、表示後に /api/session を 1 回取り直して
// LOGIN_FAILURES_HIGH などを含む最新の warnings に置き換える。
import { useEffect, useState } from 'react';
import type { Features, SessionResponse, SetupWarning } from '../types/api';
import type { Language } from '../i18n';
import { getTranslator } from '../i18n';
import { apiGet } from './lib/api';
import { isMessageKey } from './lib/keys';

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

  const keys = warnings.map((w) => `setup.warning.${w}`).filter(isMessageKey);
  const stage = !features.writes ? 'stage.readOnly' : !features.audit ? 'stage.writesWithoutAudit' : null;
  if (!stage && keys.length === 0) return null;

  return (
    <div className="notices" role="region" aria-label={t('notice.label')}>
      {stage && (
        <p className={stage === 'stage.writesWithoutAudit' ? 'alert alert-error' : 'alert alert-warn'}>
          <strong>{t(stage)}</strong>
        </p>
      )}
      {keys.length > 0 && (
        <div className="alert alert-warn">
          <ul>
            {keys.map((k) => (
              <li key={k}>{t(k)}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
