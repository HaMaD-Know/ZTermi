import type { PreflightCheck } from '../../build/plan';
import { STATUS_LABELS, type BuildStatus } from '../../build/types';
import type { ExecutionTarget } from '../../terminal/types';
import { targetLabel } from '../../terminal/types';
import { h, type Child } from '../dom';
import { icon, type IconName } from '../icons';

export function targetChip(target: ExecutionTarget): HTMLElement {
  return h('span', { class: `target ${target.kind}`, title: 'Where this runs' }, targetLabel(target));
}

const STATUS_ICON: Record<BuildStatus, IconName> = {
  ready: 'pending',
  waiting_for_signing: 'key',
  syncing: 'spinner',
  dispatching: 'spinner',
  queued: 'pending',
  running: 'spinner',
  succeeded: 'ok',
  failed: 'error',
  cancelled: 'ban',
};

export function statusChip(status: BuildStatus, detail?: string): HTMLElement {
  const spinning = status === 'running' || status === 'syncing' || status === 'dispatching';
  return h('span', { class: `status ${status}` }, icon(STATUS_ICON[status], 15, spinning ? 'spin' : ''), STATUS_LABELS[status], detail ? h('span', { class: 'muted' }, ` (${detail})`) : null);
}

export function checksList(checks: PreflightCheck[]): HTMLElement {
  const iconFor: Record<string, IconName> = { ok: 'ok', fail: 'error', warn: 'warning', unknown: 'alert' };
  return h(
    'ul',
    { class: 'checks' },
    checks.map((c) =>
      h('li', { class: c.status }, icon(iconFor[c.status]!, 16), h('div', null, h('strong', null, `${c.label}: `), c.detail, c.fix ? h('span', { class: 'fix' }, c.fix) : null)),
    ),
  );
}

export function emptyState(title: string, text: string, action?: HTMLElement): HTMLElement {
  return h('div', { class: 'empty' }, h('strong', null, title), text, action ? h('div', null, action) : null);
}

export function field(label: string, control: HTMLElement, hint?: string): HTMLElement {
  return h('label', { class: 'field' }, h('span', null, label), control, hint ? h('small', { class: 'faint' }, hint) : null);
}

export function select<T extends string>(options: { value: T; label: string }[], value: T, onChange: (value: T) => void, label: string): HTMLSelectElement {
  const el = h(
    'select',
    { class: 'select', attrs: { 'aria-label': label }, onChange: () => onChange(el.value as T) },
    options.map((o) => h('option', { value: o.value, selected: o.value === value }, o.label)),
  );
  return el;
}

export function segmented<T extends string>(options: { value: T; label: string }[], value: T, onChange: (value: T) => void, label: string): HTMLElement {
  const group = h('div', { class: 'segmented', attrs: { role: 'group', 'aria-label': label } });
  const render = (current: T) => {
    group.replaceChildren(
      ...options.map((o) =>
        h(
          'button',
          {
            type: 'button',
            attrs: { 'aria-pressed': String(o.value === current) },
            onClick: () => {
              render(o.value);
              onChange(o.value);
            },
          },
          o.label,
        ),
      ),
    );
  };
  render(value);
  return group;
}

export function page(...children: Child[]): HTMLElement {
  return h('div', { class: 'scroll', style: 'flex:1;min-height:0' }, h('div', { class: 'page' }, ...children));
}
