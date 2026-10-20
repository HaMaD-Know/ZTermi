import type { ConfirmRequest } from '../terminal/types';
import { h } from './dom';
import { icon } from './icons';

/**
 * Dialogs, sheets and toasts. WKWebView's native alert/prompt are avoided so
 * every dialog matches the app, traps focus and closes with Escape.
 */

let layer: HTMLElement | null = null;
function overlayLayer(): HTMLElement {
  if (!layer) {
    layer = h('div', { class: 'overlay-layer' });
    document.body.appendChild(layer);
  }
  return layer;
}

interface DialogOptions<T> {
  title: string;
  message?: string | Node;
  details?: string[];
  buttons: { label: string; value: T; kind?: 'primary' | 'danger' | 'plain' }[];
  cancelValue: T;
  input?: { value?: string; placeholder?: string; type?: 'text' | 'password'; label?: string; validate?: (v: string) => string | null };
  body?: Node;
  /** Builds extra content that can close the dialog itself (e.g. a list of choices). */
  mount?: (close: (value: T) => void) => Node;
}

export function dialog<T>(options: DialogOptions<T>): Promise<{ value: T; text: string }> {
  return new Promise((resolve) => {
    const previousFocus = document.activeElement as HTMLElement | null;
    const error = h('p', { class: 'dialog-error', attrs: { role: 'alert' } });
    const input = options.input
      ? h('input', {
          class: 'text-input',
          type: options.input.type ?? 'text',
          value: options.input.value ?? '',
          placeholder: options.input.placeholder ?? '',
          attrs: { autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', autocomplete: options.input.type === 'password' ? 'off' : undefined, 'aria-label': options.input.label ?? options.title },
        })
      : null;
    const close = (value: T) => {
      if (input && value !== options.cancelValue && options.input?.validate) {
        const problem = options.input.validate(input.value);
        if (problem) {
          error.textContent = problem;
          input.focus();
          return;
        }
      }
      const text = input?.value ?? '';
      if (input) input.value = '';
      backdrop.remove();
      document.removeEventListener('keydown', onKey, true);
      previousFocus?.focus?.();
      resolve({ value, text });
    };
    const focusables = () => [...dialogEl.querySelectorAll<HTMLElement>('button, input, select, textarea, [tabindex="0"]')].filter((e) => !e.hasAttribute('disabled'));
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close(options.cancelValue);
      } else if (e.key === 'Enter' && input && document.activeElement === input) {
        e.preventDefault();
        const primary = options.buttons.find((b) => b.kind === 'primary' || b.kind === 'danger');
        if (primary) close(primary.value);
      } else if (e.key === 'Tab') {
        const items = focusables();
        if (!items.length) return;
        const index = items.indexOf(document.activeElement as HTMLElement);
        const next = e.shiftKey ? (index <= 0 ? items.length - 1 : index - 1) : index === items.length - 1 ? 0 : index + 1;
        e.preventDefault();
        items[next]!.focus();
      }
    };
    const titleId = `dlg-${Math.random().toString(36).slice(2)}`;
    const dialogEl = h(
      'div',
      { class: 'dialog', attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId } },
      h('h2', { id: titleId, class: 'dialog-title' }, options.title),
      options.message ? h('div', { class: 'dialog-message' }, options.message) : null,
      options.details?.length ? h('pre', { class: 'dialog-details' }, options.details.join('\n')) : null,
      options.body ?? null,
      options.mount ? options.mount((value) => close(value)) : null,
      input,
      error,
      h(
        'div',
        { class: 'dialog-buttons' },
        options.buttons.map((b) => h('button', { type: 'button', class: `btn btn-${b.kind ?? 'plain'}`, onClick: () => close(b.value) }, b.label)),
      ),
    );
    const backdrop = h('div', { class: 'backdrop', onClick: (e: Event) => e.target === backdrop && close(options.cancelValue) }, dialogEl);
    overlayLayer().appendChild(backdrop);
    document.addEventListener('keydown', onKey, true);
    requestAnimationFrame(() => (input ?? dialogEl.querySelector<HTMLElement>('.btn-primary, .btn-danger, .btn'))?.focus());
  });
}

export async function confirmDialog(request: ConfirmRequest): Promise<boolean> {
  const result = await dialog({
    title: request.title,
    message: request.message,
    details: request.details,
    buttons: [
      { label: 'Cancel', value: false },
      { label: request.confirmLabel ?? 'Continue', value: true, kind: request.danger ? 'danger' : 'primary' },
    ],
    cancelValue: false,
  });
  return result.value;
}

export async function promptText(title: string, options: { message?: string; value?: string; placeholder?: string; confirmLabel?: string; validate?: (v: string) => string | null; password?: boolean } = {}): Promise<string | null> {
  const result = await dialog({
    title,
    message: options.message,
    input: { value: options.value, placeholder: options.placeholder, validate: options.validate, type: options.password ? 'password' : 'text' },
    buttons: [
      { label: 'Cancel', value: false },
      { label: options.confirmLabel ?? 'OK', value: true, kind: 'primary' },
    ],
    cancelValue: false,
  });
  return result.value ? result.text : null;
}

export async function choose<T extends string>(title: string, choices: { value: T; label: string; description?: string }[], message?: string): Promise<T | null> {
  const result = await dialog<T | null>({
    title,
    message,
    mount: (close) =>
      h(
        'div',
        { class: 'choice-list', attrs: { role: 'listbox' } },
        choices.map((c) =>
          h(
            'button',
            { type: 'button', class: 'choice', attrs: { role: 'option' }, onClick: () => close(c.value) },
            h('span', { class: 'choice-label' }, c.label),
            c.description ? h('span', { class: 'choice-description' }, c.description) : null,
          ),
        ),
      ),
    buttons: [{ label: 'Cancel', value: null }],
    cancelValue: null,
  });
  return result.value;
}

export function toast(message: string, kind: 'info' | 'success' | 'error' = 'info'): void {
  const el = h('div', { class: `toast toast-${kind}`, attrs: { role: kind === 'error' ? 'alert' : 'status' } }, icon(kind === 'error' ? 'error' : kind === 'success' ? 'ok' : 'info', 16), h('span', null, message));
  let host = document.querySelector('.toast-host');
  if (!host) {
    host = h('div', { class: 'toast-host' });
    document.body.appendChild(host);
  }
  host.appendChild(el);
  setTimeout(() => {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 250);
  }, kind === 'error' ? 6500 : 3500);
}

/** Shows the GitHub device code while sign-in is pending on github.com. */
export function deviceCodeSheet(info: { userCode: string; verificationUri: string; expiresIn: number }, openUrl: (url: string) => void, copy: (text: string) => Promise<void>): { close(): void } {
  const code = h('div', { class: 'device-code', attrs: { 'aria-label': `Code ${info.userCode.split('').join(' ')}` } }, info.userCode);
  const sheet = h(
    'div',
    { class: 'dialog', attrs: { role: 'dialog', 'aria-modal': 'true' } },
    h('h2', { class: 'dialog-title' }, 'Sign in to GitHub'),
    h('p', { class: 'dialog-message' }, 'Open github.com/login/device, sign in, and enter this code. Terminia waits here and stores the token in the Keychain when you approve.'),
    code,
    h(
      'div',
      { class: 'dialog-buttons' },
      h('button', { type: 'button', class: 'btn btn-plain', onClick: () => void copy(info.userCode) }, icon('copy', 16), 'Copy code'),
      h('button', { type: 'button', class: 'btn btn-primary', onClick: () => openUrl(info.verificationUri) }, icon('external', 16), 'Open github.com'),
    ),
    h('p', { class: 'muted small' }, `The code expires in ${Math.round(info.expiresIn / 60)} minutes.`),
  );
  const backdrop = h('div', { class: 'backdrop' }, sheet);
  overlayLayer().appendChild(backdrop);
  return { close: () => backdrop.remove() };
}
