import type { OrganModel } from '@core/anatomy/types';
import { esc } from '../ui/escape';

const SVG_NS = 'http://www.w3.org/2000/svg';
let uid = 0;

export interface FigureEvents {
  onHover?: (segment: number | null, ev: PointerEvent | FocusEvent) => void;
  onClick?: (segment: number, ev: MouseEvent | KeyboardEvent) => void;
  onDoubleClick?: (segment: number, ev: MouseEvent) => void;
}

export interface FigureHandle {
  readonly el: SVGSVGElement;
  setFills: (fill: (segment: number) => string | null) => void;
  setSelected: (segments: ReadonlySet<number>) => void;
  destroy: () => void;
}

/** Draws an organ as interactive SVG: surface, then decor, then dashed deep structures on top. */
export function renderOrgan(model: OrganModel, events: FigureEvents = {}): FigureHandle {
  const id = `organ-${model.id}-${++uid}`;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', model.viewBox.join(' '));
  svg.setAttribute('class', 'organ');
  svg.setAttribute('role', 'group');
  svg.setAttribute('aria-label', `${model.label} (${model.view})`);
  svg.innerHTML =
    `<defs><pattern id="${id}-hatch" width="6" height="6" patternUnits="userSpaceOnUse" ` +
    `patternTransform="rotate(45)"><rect width="6" height="6" class="organ-nodata-bg"/>` +
    `<line x1="0" y1="0" x2="0" y2="6" class="organ-nodata-line"/></pattern></defs>` +
    `<g class="organ-surface"></g><g class="organ-decor"></g><g class="organ-deep"></g>`;

  const surface = svg.querySelector('.organ-surface')!;
  const decor = svg.querySelector('.organ-decor')!;
  const deep = svg.querySelector('.organ-deep')!;

  for (const d of model.decor ?? []) {
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', d.path);
    p.setAttribute('class', `organ-decor-${d.kind}`);
    decor.appendChild(p);
  }

  const paths: SVGPathElement[] = model.segments.map((seg, s) => {
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', seg.path);
    p.setAttribute('class', seg.deep ? 'seg seg-deep' : 'seg');
    p.setAttribute('fill-rule', 'evenodd');
    p.setAttribute('tabindex', '0');
    p.setAttribute('role', 'button');
    p.dataset.seg = seg.id;
    p.dataset.index = String(s);
    const title = document.createElementNS(SVG_NS, 'title');
    title.innerHTML = esc(seg.label);
    p.appendChild(title);
    (seg.deep ? deep : surface).appendChild(p);
    return p;
  });

  const segOf = (target: EventTarget | null): number | null => {
    const el = (target as Element | null)?.closest?.('.seg') as SVGPathElement | null;
    return el ? Number(el.dataset.index) : null;
  };
  const onOver = (ev: PointerEvent): void => events.onHover?.(segOf(ev.target), ev);
  const onLeave = (ev: PointerEvent): void => events.onHover?.(null, ev);
  const onFocus = (ev: FocusEvent): void => events.onHover?.(segOf(ev.target), ev);
  const onBlur = (ev: FocusEvent): void => {
    if (!svg.contains(ev.relatedTarget as Node | null)) events.onHover?.(null, ev);
  };
  const onClick = (ev: MouseEvent): void => {
    const s = segOf(ev.target);
    if (s !== null) events.onClick?.(s, ev);
  };
  const onDbl = (ev: MouseEvent): void => {
    const s = segOf(ev.target);
    if (s !== null) events.onDoubleClick?.(s, ev);
  };
  const onKey = (ev: KeyboardEvent): void => {
    if (ev.key !== 'Enter' && ev.key !== ' ') return;
    const s = segOf(ev.target);
    if (s === null) return;
    ev.preventDefault();
    events.onClick?.(s, ev);
  };
  svg.addEventListener('pointerover', onOver);
  svg.addEventListener('pointerleave', onLeave);
  svg.addEventListener('focusin', onFocus);
  svg.addEventListener('focusout', onBlur);
  svg.addEventListener('click', onClick);
  svg.addEventListener('dblclick', onDbl);
  svg.addEventListener('keydown', onKey);

  return {
    el: svg,
    setFills(fill) {
      paths.forEach((p, s) => {
        const f = fill(s);
        p.style.fill = f ?? `url(#${id}-hatch)`;
        p.classList.toggle('seg-nodata', f === null);
      });
    },
    setSelected(selected) {
      paths.forEach((p, s) => {
        const on = selected.has(s);
        p.classList.toggle('seg-selected', on);
        p.setAttribute('aria-pressed', String(on));
      });
    },
    destroy() {
      svg.remove();
    }
  };
}
