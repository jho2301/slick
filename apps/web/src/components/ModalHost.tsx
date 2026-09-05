/**
 * The one `<dialog>` every create/edit/confirm flow runs through.
 *
 * Fields are uncontrolled and read back through `FormData` on submit, the way
 * a plain form would be: nothing has to be kept in step with typing, and a
 * value set on a node from outside — a test driving the page — is the value
 * that gets read. The one exception is a select whose options depend on
 * another field, which is re-keyed off that field's live value.
 */

import { useAtomValue } from 'jotai';
import { useEffect, useRef, useState } from 'react';
// `useState` is the form's own (`live` values); the host itself keeps none.

import {
  modalAtom,
  type ModalField,
  type ModalOption,
  type ModalRequest,
  type ModalValues,
} from '../atoms.ts';
import { closeModal } from '../modal.ts';

/**
 * Options, bucketed into `<optgroup>`s by their `group` — a list of 70-odd
 * models is a different thing to read with the provider names left in.
 * Consecutive options sharing a group stay together, so the caller decides
 * the order.
 */
function GroupedOptions({ options }: { options: ModalOption[] }) {
  const out: React.ReactNode[] = [];
  let bucket: React.ReactNode[] | null = null;
  let group: string | null | undefined;
  const flush = () => {
    if (bucket && group)
      out.push(
        <optgroup key={`g:${group}:${out.length}`} label={group}>
          {bucket}
        </optgroup>
      );
    bucket = null;
  };
  for (const option of options) {
    const node = (
      <option key={option.value} value={option.value}>
        {option.label}
      </option>
    );
    if (!option.group) {
      flush();
      out.push(node);
      continue;
    }
    if (!bucket || group !== option.group) {
      flush();
      group = option.group;
      bucket = [];
    }
    bucket.push(node);
  }
  flush();
  return <>{out}</>;
}

function initialValues(fields: ModalField[] | undefined): ModalValues {
  const values: ModalValues = {};
  for (const field of fields ?? []) values[field.name] = field.value ?? '';
  return values;
}

function Field({
  field,
  live,
  onLive,
}: {
  field: ModalField;
  live: ModalValues;
  onLive: (patch: ModalValues) => void;
}) {
  const id = `field-${field.name}`;
  const options = typeof field.options === 'function' ? field.options(live) : (field.options ?? []);
  const onChange = (value: string) => {
    if (!field.onChange) return;
    const next = { ...live, [field.name]: value };
    onLive({ [field.name]: value, ...(field.onChange(value, next) ?? {}) });
  };
  let input: React.ReactNode;
  if (field.type === 'select') {
    // Re-keyed when its options change so the browser's own default lands on
    // the new first entry rather than an option that no longer exists.
    const dependent = typeof field.options === 'function';
    input = (
      <select
        key={dependent ? `${id}:${options.map((o) => o.value).join('|')}` : id}
        id={id}
        name={field.name}
        defaultValue={live[field.name] ?? ''}
        onChange={(event) => onChange(event.currentTarget.value)}
      >
        <GroupedOptions options={options} />
      </select>
    );
  } else if (field.type === 'textarea') {
    input = (
      <textarea
        id={id}
        name={field.name}
        rows={field.rows ?? 3}
        placeholder={field.placeholder ?? ''}
        defaultValue={field.value ?? ''}
      />
    );
  } else {
    input = (
      <input
        id={id}
        name={field.name}
        type={field.type ?? 'text'}
        placeholder={field.placeholder ?? ''}
        autoComplete="off"
        defaultValue={field.value ?? ''}
        required={field.required}
      />
    );
  }
  return (
    <div className="field">
      {field.label ? <label htmlFor={id}>{field.label}</label> : null}
      {input}
      {field.help ? <div className="help" dangerouslySetInnerHTML={{ __html: field.help }} /> : null}
    </div>
  );
}

function ModalForm({ request }: { request: ModalRequest }) {
  const { config } = request;
  const form = useRef<HTMLFormElement>(null);
  const [live, setLive] = useState<ModalValues>(() => initialValues(config.fields));

  useEffect(() => {
    const first = form.current?.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
      'input, textarea, select'
    );
    if (first) {
      first.focus();
      if ('select' in first && typeof first.select === 'function') first.select();
    } else {
      form.current?.querySelector<HTMLButtonElement>('#modal-ok')?.focus();
    }
  }, []);

  const values = (): ModalValues => {
    const out: ModalValues = {};
    if (!form.current) return out;
    for (const [key, value] of new FormData(form.current).entries()) out[key] = String(value);
    return out;
  };

  return (
    <form
      method="dialog"
      id="modal-form"
      ref={form}
      onSubmit={(event) => {
        event.preventDefault();
        closeModal(values());
      }}
    >
      <h2 className="modal__title" id="modal-title">
        {config.title}
      </h2>
      <div className="modal__body" id="modal-body">
        {config.body ? <p style={{ margin: 0, color: 'var(--fg-dim)' }}>{config.body}</p> : null}
        {config.note ? <div className="warn-note">{config.note}</div> : null}
        {(config.fields ?? []).map((field) => (
          <Field
            key={field.name}
            field={field}
            live={live}
            onLive={(patch) => setLive((prev) => ({ ...prev, ...patch }))}
          />
        ))}
      </div>
      <footer className="modal__foot">
        {/* Secondary verbs ("Delete this category") that belong to the same
            form but are not the primary action. They resolve with `_action`
            set to their value. */}
        <div className="modal__extra" id="modal-extra" hidden={!config.extra?.length}>
          {(config.extra ?? []).map((action) => (
            <button
              key={action.value}
              type="button"
              className={`btn ${action.danger ? 'btn--danger' : 'btn--ghost'}`}
              onClick={() => closeModal({ ...values(), _action: action.value })}
            >
              {action.label}
            </button>
          ))}
        </div>
        <button type="button" className="btn btn--ghost" id="modal-cancel" onClick={() => closeModal(null)}>
          Cancel
        </button>
        <button
          type="submit"
          className={`btn ${config.danger ? 'btn--danger' : 'btn--primary'}`}
          id="modal-ok"
        >
          {config.okLabel ?? 'Save'}
        </button>
      </footer>
    </form>
  );
}

export function ModalHost() {
  const request = useAtomValue(modalAtom);
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    if (request) {
      if (!node.open) node.showModal();
    } else if (node.open) {
      node.close();
    }
  }, [request]);

  return (
    <dialog
      className="modal"
      id="modal"
      ref={dialog}
      onCancel={(event) => {
        event.preventDefault();
        closeModal(null);
      }}
      onClose={() => closeModal(null)}
    >
      {request ? <ModalForm key={request.id} request={request} /> : <form method="dialog" id="modal-form" />}
    </dialog>
  );
}
