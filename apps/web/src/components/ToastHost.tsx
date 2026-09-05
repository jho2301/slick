import { useAtomValue } from 'jotai';

import { toastsAtom } from '../atoms.ts';

export function ToastHost() {
  const toasts = useAtomValue(toastsAtom);
  return (
    <div className="toasts" id="toasts">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`toast${t.kind ? ` is-${t.kind}` : ''}`}
          style={t.fading ? { transition: 'opacity .25s', opacity: 0 } : undefined}
        >
          {t.text}
        </div>
      ))}
    </div>
  );
}
