import { toHex } from '@core/theme/themes';
import type { ThemeStore } from '../theme';
import { esc } from './escape';

export function createThemePicker(root: HTMLElement, store: ThemeStore): () => void {
  const box = document.createElement('div');
  box.className = 'theme-picker';
  box.setAttribute('role', 'group');
  box.setAttribute('aria-label', 'Background color');
  box.innerHTML =
    `<span class="label">Background</span>` +
    store
      .all()
      .map(
        t =>
          `<button data-theme-id="${t.id}" title="${esc(t.hint)}" aria-pressed="false">` +
          `<span class="swatch" style="background:${toHex(t.background)}"></span>${esc(t.label)}</button>`
      )
      .join('');
  root.appendChild(box);

  const sync = (): void => {
    box.querySelectorAll<HTMLButtonElement>('button').forEach(b => {
      b.setAttribute('aria-pressed', String(b.dataset.themeId === store.current.id));
    });
  };
  box.addEventListener('click', ev => {
    const btn = (ev.target as HTMLElement).closest<HTMLButtonElement>('button[data-theme-id]');
    if (btn) store.set(btn.dataset.themeId as never);
  });
  sync();
  return store.subscribe(sync);
}
