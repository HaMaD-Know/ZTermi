/** Minimal DOM construction helpers; the UI is plain TypeScript, no framework. */

export type Child = Node | string | number | null | undefined | false | Child[];

export interface Props {
  class?: string;
  style?: Partial<CSSStyleDeclaration> | string;
  dataset?: Record<string, string>;
  attrs?: Record<string, string | number | boolean | null | undefined>;
  [key: string]: unknown;
}

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props | null = null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === 'class') el.className = value as string;
      else if (key === 'style') {
        if (typeof value === 'string') el.setAttribute('style', value);
        else Object.assign(el.style, value);
      } else if (key === 'dataset') Object.assign(el.dataset, value);
      else if (key === 'attrs') {
        for (const [name, attr] of Object.entries(value as Record<string, unknown>)) {
          if (attr === false || attr === null || attr === undefined) continue;
          el.setAttribute(name, attr === true ? '' : String(attr));
        }
      } else if (key.startsWith('on') && typeof value === 'function') {
        el.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
      } else {
        (el as unknown as Record<string, unknown>)[key] = value;
      }
    }
  }
  append(el, children);
  return el;
}

export function append(parent: Node, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) append(parent, child);
    else parent.appendChild(typeof child === 'string' || typeof child === 'number' ? document.createTextNode(String(child)) : child);
  }
}

export function clear(el: Element): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export function replaceChildren(el: Element, ...children: Child[]): void {
  clear(el);
  append(el, children);
}

export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number): ((...args: A) => void) & { cancel(): void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const wrapped = (...args: A) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, ms);
  };
  wrapped.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  return wrapped;
}

/** True on touch-first devices (iPad), where the key bar and larger hit areas help. */
export function isTouchDevice(): boolean {
  return typeof window !== 'undefined' && (window.matchMedia?.('(pointer: coarse)').matches ?? false);
}

export function button(label: Child, onClick: (e: MouseEvent) => void, options: { kind?: 'primary' | 'danger' | 'plain' | 'ghost'; title?: string; disabled?: boolean; class?: string; type?: string } = {}): HTMLButtonElement {
  return h(
    'button',
    {
      type: options.type ?? 'button',
      class: `btn btn-${options.kind ?? 'plain'}${options.class ? ` ${options.class}` : ''}`,
      title: options.title,
      disabled: options.disabled,
      attrs: options.title ? { 'aria-label': options.title } : undefined,
      onClick,
    },
    label,
  );
}
