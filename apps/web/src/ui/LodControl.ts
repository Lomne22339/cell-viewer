export interface LodHandle {
  setDrawn: (drawn: number, total: number) => void;
}

export function createLodControl(
  root: HTMLElement,
  onChange: (fraction: number | null) => void
): LodHandle {
  const box = document.createElement('div');
  box.className = 'lod';
  box.innerHTML = `
    <label><input type="checkbox" data-auto checked> Auto detail</label>
    <input type="range" data-slider min="1" max="100" value="100" disabled
           aria-label="Fraction of points drawn">
    <div class="lod-readout">—</div>`;
  root.appendChild(box);

  const auto = box.querySelector<HTMLInputElement>('[data-auto]')!;
  const slider = box.querySelector<HTMLInputElement>('[data-slider]')!;
  const readout = box.querySelector<HTMLElement>('.lod-readout')!;

  const emit = (): void => {
    slider.disabled = auto.checked;
    onChange(auto.checked ? null : Number(slider.value) / 100);
  };
  auto.addEventListener('change', emit);
  slider.addEventListener('input', emit);

  return {
    setDrawn(drawn, total) {
      const pct = total ? Math.round((drawn / total) * 100) : 0;
      readout.textContent =
        `${drawn.toLocaleString()} / ${total.toLocaleString()} drawn (${pct}%)`;
    }
  };
}
