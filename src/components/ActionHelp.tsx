// 一覧の上に 1 回だけ出す操作の説明(「何が起きるか」。docs/ARCHITECTURE.md 9.4)。
// 各行のボタンは aria-describedby={actionHelpId(action)} でこの説明に結び付ける。
import type { WriteAction } from '../types/api';
import type { Translator } from '../i18n';

export function actionHelpId(action: WriteAction): string {
  return `help-${action}`;
}

interface Props {
  actions: readonly WriteAction[];
  t: Translator;
}

export default function ActionHelp({ actions, t }: Props) {
  return (
    <ul className="notes action-help-list">
      {actions.map((a) => (
        <li key={a} id={actionHelpId(a)}>
          {t('action.helpLine', { action: t(`action.${a}`), help: t(`action.help.${a}`) })}
        </li>
      ))}
    </ul>
  );
}
