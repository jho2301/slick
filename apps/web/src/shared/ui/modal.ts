/**
 * The one modal, used for every create/edit/confirm flow. An action opens it
 * with a description of the form and gets a promise of what was typed; the
 * `ModalHost` component draws whatever request is current.
 */

import { modalAtom, type ModalConfig, type ModalValues } from '../../app/atoms.ts';
import { store } from '../../app/store.ts';

let nextId = 0;

export function openModal(config: ModalConfig): Promise<ModalValues | null> {
  // One at a time: a dialog opened over another resolves the first as cancelled.
  closeModal(null);
  return new Promise((resolve) => {
    store.set(modalAtom, { id: ++nextId, config, resolve });
  });
}

export function closeModal(values: ModalValues | null): void {
  const request = store.get(modalAtom);
  if (!request) return;
  store.set(modalAtom, null);
  request.resolve(values);
}

export function confirmModal({
  title,
  body,
  okLabel = 'Delete',
  danger = true,
  note,
}: {
  title: string;
  body?: string;
  okLabel?: string;
  danger?: boolean;
  note?: string;
}): Promise<boolean> {
  return openModal({ title, body, note, okLabel, danger }).then(Boolean);
}
