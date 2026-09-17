import type { Mode } from '../interact/lasso';

export interface ToolbarHandle {
  setMode: (m: Mode) => void;
  setSelectionActive: (on: boolean) => void;
}

export function createToolbar(
  root: HTMLElement,
  handlers: {
    onMode: (m: Mode) => void;
    onZoomToSelection: () => void;
    onClear: () => void;
    onResetView: () => void;
  }
): ToolbarHandle {
  const bar = document.createElement('div');
  bar.className = 'toolbar';
  bar.innerHTML = `
    <div class="group" role="group" aria-label="Selection mode">
      <button data-mode="pan" class="active" title="Pan and zoom">Pan</button>
      <button data-mode="box" title="Rectangular selection">Box</button>
      <button data-mode="lasso" title="Freehand selection">Lasso</button>
    </div>
    <button data-act="zoom" disabled title="Zoom to the selected region">Zoom to selection</button>
    <button data-act="clear" disabled>Clear</button>
    <button data-act="reset">Reset view</button>`;
  root.appendChild(bar);

  const modeButtons = [...bar.querySelectorAll<HTMLButtonElement>('button[data-mode]')];
  const setMode = (m: Mode): void => {
    modeButtons.forEach(b => b.classList.toggle('active', b.dataset.mode === m));
    handlers.onMode(m);
  };
  modeButtons.forEach(b => b.addEventListener('click', () => setMode(b.dataset.mode as Mode)));

  const zoomBtn = bar.querySelector<HTMLButtonElement>('[data-act="zoom"]')!;
  const clearBtn = bar.querySelector<HTMLButtonElement>('[data-act="clear"]')!;
  zoomBtn.addEventListener('click', handlers.onZoomToSelection);
  clearBtn.addEventListener('click', handlers.onClear);
  bar
    .querySelector<HTMLButtonElement>('[data-act="reset"]')!
    .addEventListener('click', handlers.onResetView);

  return {
    setMode,
    setSelectionActive: (on: boolean) => {
      zoomBtn.disabled = !on;
      clearBtn.disabled = !on;
    }
  };
}
