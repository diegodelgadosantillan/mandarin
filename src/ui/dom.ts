/** Minimal DOM helpers. No framework — the UI is simple enough not to need one. */

type Child = Node | string | number | null | undefined | false;

function appendChildren(node: HTMLElement, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : String(child));
  }
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, unknown> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = String(value);
    else if (key === 'dataset') Object.assign(node.dataset, value as Record<string, string>);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else if (key.includes('-') || key.startsWith('aria') || key === 'role' || key === 'for') {
      node.setAttribute(key === 'for' ? 'for' : key, String(value));
    } else if (key in node) {
      (node as unknown as Record<string, unknown>)[key] = value;
    } else {
      node.setAttribute(key, String(value));
    }
  }
  appendChildren(node, children);
  return node;
}

export function clear(node: HTMLElement): void {
  node.replaceChildren();
}

let toastHost: HTMLElement | null = null;

export function toast(message: string, kind: 'info' | 'error' = 'info'): void {
  if (!toastHost) {
    toastHost = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.append(toastHost);
  }
  const node = h('div', { class: kind === 'error' ? 'toast toast--error' : 'toast' }, message);
  toastHost.append(node);
  setTimeout(() => node.remove(), kind === 'error' ? 6000 : 3800);
}

/** Format an epoch-ms timestamp as a short Spanish date. */
export function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}
