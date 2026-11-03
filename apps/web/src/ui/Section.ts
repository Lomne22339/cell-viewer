import { esc } from './escape';

const KEY = 'cellviewer.sections';

function readState(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, boolean>;
  } catch {
    return {};
  }
}

export function createSection(root: HTMLElement, id: string, title: string, open = true): HTMLElement {
  const details = document.createElement('details');
  details.className = `section section-${id}`;
  const saved = readState()[id];
  details.open = saved ?? open;
  details.innerHTML = `<summary>${esc(title)}</summary><div class="section-body"></div>`;
  details.addEventListener('toggle', () => {
    try {
      const state = readState();
      state[id] = details.open;
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch {
      /* not persisted */
    }
  });
  root.appendChild(details);
  return details.querySelector<HTMLElement>('.section-body')!;
}
