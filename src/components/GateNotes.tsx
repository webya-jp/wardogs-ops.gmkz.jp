// 操作ボタンの可否の注記を一覧の上にまとめて出す(missing は無効化の理由、unknown は「未確認」)。
import type { CapabilitiesResponse, WriteAction } from '../types/api';
import type { Translator } from '../i18n';
import { gateNotes } from './lib/gate';

interface Props {
  actions: readonly WriteAction[];
  caps: CapabilitiesResponse | null;
  writesEnabled: boolean;
  t: Translator;
}

export default function GateNotes({ actions, caps, writesEnabled, t }: Props) {
  if (!writesEnabled) {
    return (
      <ul className="notes">
        <li>{t('gate.writesDisabled')}</li>
      </ul>
    );
  }
  const notes = gateNotes(actions, caps, writesEnabled);
  if (notes.length === 0) return null;
  return (
    <ul className="notes">
      {notes.map(({ action, note }) => (
        <li key={action}>
          <span className={note === 'gate.missing' ? 'badge badge-error' : 'badge badge-warn'}>{t(`action.${action}`)}</span>{' '}
          {t(note)}
        </li>
      ))}
    </ul>
  );
}
