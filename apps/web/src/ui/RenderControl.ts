export interface RenderControlHandle {
  setBlend: (on: boolean) => void;
}

/** Translucent points show density, but blending is the costliest setting, so it ships off. */
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
