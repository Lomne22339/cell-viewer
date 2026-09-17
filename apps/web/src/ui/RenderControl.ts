export interface RenderControlHandle {
  setBlend: (on: boolean) => void;
}

/**
 * Exposes the one rendering trade-off worth giving the user.
 *
 * Translucent points show density where cells pile up, but blending is by far
 * the most expensive thing the renderer does — about four times the frame cost
 * at a million points on a tile-based GPU — so it ships off.
 */
export function createRenderControl(
  root: HTMLElement,
  initial: boolean,
  onChange: (blend: boolean) => void
): RenderControlHandle {
  const box = document.createElement('div');
  box.className = 'render-control';
  box.innerHTML = `
    <label><input type="checkbox" data-blend> Translucent points</label>
    <div class="muted">Shows density in crowded regions. Costs roughly 4&times;
      the frame time at a million points.</div>`;
  root.appendChild(box);

  const input = box.querySelector<HTMLInputElement>('[data-blend]')!;
  input.checked = initial;
  input.addEventListener('change', () => onChange(input.checked));
  return {
    setBlend: (on: boolean) => {
      input.checked = on;
    }
  };
}
