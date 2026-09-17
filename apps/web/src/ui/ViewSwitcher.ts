import { esc } from './escape';

export interface DatasetChoice {
  id: string;
  label: string;
  kind: 'embedding' | 'trajectory';
}

export function createViewSwitcher(
  root: HTMLElement,
  datasets: DatasetChoice[],
  onPick: (id: string, kind: 'embedding' | 'trajectory') => void
): void {
  const bar = document.createElement('div');
  bar.className = 'switcher';
  bar.innerHTML = datasets
    .map(
      (d, i) =>
        `<button data-id="${esc(d.id)}" data-kind="${esc(d.kind)}" class="${i === 0 ? 'active' : ''}">` +
        `${esc(d.label)}</button>`
    )
    .join('');
  root.appendChild(bar);
  bar.addEventListener('click', ev => {
    const btn = (ev.target as HTMLElement).closest('button');
    if (!btn) return;
    [...bar.querySelectorAll('button')].forEach(b => b.classList.toggle('active', b === btn));
    onPick(btn.dataset.id!, btn.dataset.kind as 'embedding' | 'trajectory');
  });
}
