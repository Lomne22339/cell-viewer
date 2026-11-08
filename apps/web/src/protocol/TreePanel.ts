import { layoutTree } from '@core/protocol/layout';
import type { ProtocolSnapshot, ProtocolState } from '@core/protocol/state';
import { branchesAlong } from '@core/protocol/trace';
import type { Milestone, ProtocolTree } from '@core/protocol/types';
import { esc } from '../ui/escape';

export interface TreePanelHandle {
  update: (snap: ProtocolSnapshot) => void;
  destroy: () => void;
}

const W = 1000;
const PAD_L = 44;
const PAD_R = 100;
const PAD_T = 40;
const PAD_B = 50;
// Rows are packed tighter than the label size would need on its own: the
// drawing is scaled down to its panel, so larger type is what keeps it legible.
const ROW = 34;
const RADIUS = { stem: 11, progenitor: 9, intermediate: 7, terminal: 8 } as const;

/** "Synthetic fate F3" becomes "F3"; a real label is kept, shortened if long. */
function shortLabel(label: string): string {
  const m = /^Synthetic .* ([A-Z]\d+)$/.exec(label);
  if (m) return m[1];
  if (label === 'Synthetic stem cell') return 'Stem';
  return label.length > 16 ? `${label.slice(0, 15)}…` : label;
}

/**
 * The differentiation pathway graph: the curated tree drawn left to right with
 * time across, and, under it, the path from the stem cell to the chosen
 * milestone as an ordered list with the forks it passes.
 *
 * The SVG is built once and only its classes change afterwards. Its colours
 * are CSS custom properties, so the four themes restyle it with no code here.
 * Clicking a milestone, or pressing Enter on it, goes to the shared state like
 * a click on the map does.
 */
export function createTreePanel(root: HTMLElement, tree: ProtocolTree, state: ProtocolState): TreePanelHandle {
  const ms = tree.milestones;
  const { x, y } = layoutTree(tree);
  const leaves = ms.filter(m => m.kind === 'terminal').length;
  const H = Math.max(200, PAD_T + PAD_B + ROW * Math.max(1, leaves - 1));
  const px = (v: number): number => PAD_L + v * (W - PAD_L - PAD_R);
  const py = (v: number): number => PAD_T + v * (H - PAD_T - PAD_B);
  const stage = (m: Milestone): string => tree.stageLabels[m.stageIndex] ?? '?';
  const name = (id: number): string => esc(ms[id]?.label ?? `#${id}`);

  const edges = ms
    .filter(m => m.parent !== null)
    .map(m => {
      const p = m.parent!;
      const x1 = px(x[p]);
      const x2 = px(x[m.id]);
      const xm = x1 + (x2 - x1) / 2;
      return `<path class="tp-edge" data-edge="${m.id}" d="M${x1} ${py(y[p])} H${xm} V${py(y[m.id])} H${x2}" fill="none"/>`;
    })
    .join('');

  const maxDay = Math.max(1, ...ms.map(m => m.day));
  const ticks: string[] = [];
  for (let d = 0; d <= maxDay; d += 5) {
    const tx = px(d / maxDay);
    ticks.push(
      `<line class="tp-tick" x1="${tx}" x2="${tx}" y1="${H - PAD_B + 6}" y2="${H - PAD_B + 12}"/>` +
        `<text class="tp-axis" x="${tx}" y="${H - PAD_B + 24}" text-anchor="middle">${d}</text>`
    );
  }

  const nodes = ms
    .map(m => {
      const cx = px(x[m.id]);
      const cy = py(y[m.id]);
      const terminal = m.kind === 'terminal';
      const label = terminal
        ? `<text class="tp-label" x="${RADIUS.terminal + 6}" y="4">${esc(shortLabel(m.label))}</text>`
        : `<text class="tp-label" y="${-(RADIUS[m.kind] + 6)}" text-anchor="middle">${esc(shortLabel(m.label))}</text>`;
      const tip =
        `${m.label} — day ${m.day}, stage ${stage(m)}` +
        (m.factors.length ? `; factors: ${m.factors.map(f => `${f.name} (${f.action})`).join(', ')}` : '');
      return (
        `<g class="tp-node kind-${m.kind}" data-ms="${m.id}" transform="translate(${cx} ${cy})" tabindex="0" ` +
        `role="button" aria-label="${esc(tip)}"><title>${esc(tip)}</title>` +
        `<circle class="tp-hit" r="14"/><circle class="tp-body" r="${RADIUS[m.kind]}"/>${label}</g>`
      );
    })
    .join('');

  root.innerHTML =
    // The drawing and its note are one block that is sized to the panel, so the
    // whole tree is in view; the step list follows it and the panel scrolls to it.
    `<div class="tp"><div class="tp-tree">` +
    `<p class="tp-note">Synthetic demo data: every milestone, factor and marker here is invented, not an experimental recommendation.</p>` +
    `<svg class="tp-svg" viewBox="0 0 ${W} ${H}" role="group" aria-label="Differentiation pathway graph" ` +
    `preserveAspectRatio="xMidYMid meet">${edges}${ticks.join('')}` +
    `<text class="tp-axis" x="${(px(0) + px(1)) / 2}" y="${H - 6}" text-anchor="middle">day of culture</text>${nodes}</svg>` +
    `</div><div class="tp-steps" aria-live="polite"></div></div>`;

  const svg = root.querySelector<SVGSVGElement>('.tp-svg')!;
  const steps = root.querySelector<HTMLElement>('.tp-steps')!;
  const nodeEls = new Map<number, SVGGElement>();
  svg.querySelectorAll<SVGGElement>('.tp-node').forEach(g => nodeEls.set(Number(g.dataset.ms), g));
  const edgeEls = new Map<number, SVGPathElement>();
  svg.querySelectorAll<SVGPathElement>('.tp-edge').forEach(p => edgeEls.set(Number(p.dataset.edge), p));
  let last: ProtocolSnapshot = state.snapshot();

  const pick = (g: Element | null): void => {
    const node = g?.closest<SVGGElement>('.tp-node');
    if (node) state.click(Number(node.dataset.ms));
  };
  svg.addEventListener('click', ev => pick(ev.target as Element));
  svg.addEventListener('keydown', ev => {
    if (ev.key !== 'Enter' && ev.key !== ' ') return;
    ev.preventDefault();
    pick(ev.target as Element);
  });
  steps.addEventListener('click', ev => {
    const t = ev.target as HTMLElement;
    const btn = t.closest<HTMLButtonElement>('button[data-step]');
    if (btn) {
      state.step(Number(btn.dataset.step));
      return;
    }
    const li = t.closest<HTMLElement>('li[data-index]');
    if (li && last.focus !== null) state.step(Number(li.dataset.index) - last.focus);
  });

  const renderSteps = (snap: ProtocolSnapshot): void => {
    if (snap.traced.length === 0) {
      steps.innerHTML = `<p class="muted">Click a milestone, or choose a timepoint, to trace its way back to the stem cell.</p>`;
      return;
    }
    const forks = new Map(branchesAlong(tree, snap.traced).map(b => [b.at, b]));
    const items = snap.traced.map((id, i) => {
      const m = ms[id];
      const parts = [`<b>${esc(m.label)}</b> <span class="muted">day ${m.day} · stage ${esc(stage(m))}</span>`];
      if (m.factors.length) {
        parts.push(`<div>Apply: ${m.factors.map(f => `${esc(f.name)} (${f.action})`).join('; ')}</div>`);
      }
      if (m.markers.length) parts.push(`<div class="muted">Check: ${m.markers.map(esc).join(', ')}</div>`);
      const fork = forks.get(id);
      if (fork) {
        parts.push(
          fork.taken === null
            ? `<div class="tp-fork">Forks here. Options ahead: ${fork.alternatives.map(name).join(', ')}.</div>`
            : `<div class="tp-fork">Forks here. This path continues to ${name(fork.taken)} and rules out ` +
              `${fork.excludedFates.map(name).join(', ') || 'nothing further'}.</div>`
        );
      }
      return `<li data-index="${i}"${i === snap.focus ? ' class="focus" aria-current="step"' : ''}>${parts.join('')}</li>`;
    });
    const atStart = snap.focus === 0;
    const atEnd = snap.focus === snap.traced.length - 1;
    steps.innerHTML =
      `<div class="tp-steps-head"><b>Path from the stem cell</b>` +
      `<button class="btn btn-small" data-step="-1"${atStart ? ' disabled' : ''}>◀ Earlier</button>` +
      `<button class="btn btn-small" data-step="1"${atEnd ? ' disabled' : ''}>Later ▶</button></div>` +
      `<ol class="tp-list">${items.join('')}</ol>`;
  };

  const update = (snap: ProtocolSnapshot): void => {
    last = snap;
    const on = new Set(snap.traced);
    const focusId = snap.focus === null ? -1 : snap.traced[snap.focus];
    svg.classList.toggle('has-trace', on.size > 0);
    for (const [id, g] of nodeEls) {
      g.classList.toggle('on', on.has(id));
      g.classList.toggle('focus', id === focusId);
      g.classList.toggle('target', id === snap.target);
      g.setAttribute('aria-pressed', String(on.has(id)));
    }
    for (const [id, p] of edgeEls) p.classList.toggle('on', on.has(id));
    renderSteps(snap);
  };
  update(last);
  return {
    update,
    destroy() {
      root.innerHTML = '';
    }
  };
}
