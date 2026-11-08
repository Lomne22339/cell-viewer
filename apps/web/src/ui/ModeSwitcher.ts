import { esc } from './escape';

export interface ModeChoice<T extends string> {
  id: T;
  label: string;
  title?: string;
}

export interface ModeSwitcherHandle<T extends string> {
  setMode: (id: T) => void;
}

/**
 * The top-level toggle between the viewer's modes (datasets, and the protocol
 * creator). It only reports a choice; the caller decides what to tear down
 * and what to build, which keeps the dataset loader in `main.ts` untouched.
 */
export function createModeSwitcher<T extends string>(
  root: HTMLElement,
  modes: ModeChoice<T>[],
  initial: T,
  onPick: (id: T) => void
): ModeSwitcherHandle<T> {
  const bar = document.createElement('div');
  bar.className = 'mode-switcher';
  bar.setAttribute('role', 'group');
  bar.setAttribute('aria-label', 'View mode');
  bar.innerHTML = modes
    .map(
      m =>
        `<button data-mode="${esc(m.id)}" aria-pressed="false"${m.title ? ` title="${esc(m.title)}"` : ''}>` +
        `${esc(m.label)}</button>`
    )
    .join('');
  root.appendChild(bar);

  const show = (id: T): void => {
    bar.querySelectorAll<HTMLButtonElement>('button').forEach(b => {
      const on = b.dataset.mode === id;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    });
  };
  let current = initial;
  bar.addEventListener('click', ev => {
    const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>('button[data-mode]');
    if (!btn) return;
    const id = btn.dataset.mode as T;
    if (id === current) return;
    current = id;
    show(id);
    onPick(id);
  });
  show(initial);
  return {
    setMode(id) {
      current = id;
      show(id);
    }
  };
}
