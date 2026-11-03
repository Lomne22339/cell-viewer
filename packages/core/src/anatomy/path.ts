/** Minimal SVG path-data reader, used to validate hand-authored organ paths. */

const ARITY: Record<string, number> = {
  m: 2, l: 2, h: 1, v: 1, c: 6, s: 4, q: 4, t: 2, a: 7, z: 0
};

const NUMBER = /[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/y;

export interface PathCommand {
  op: string;
  args: number[];
}

export function parsePath(d: string): PathCommand[] {
  const out: PathCommand[] = [];
  let current: PathCommand | null = null;
  let i = 0;
  const skipSeparators = (): void => {
    while (i < d.length && /[\s,]/.test(d[i])) i++;
  };
  for (;;) {
    skipSeparators();
    if (i >= d.length) break;
    const ch = d[i];
    if (/[MmLlHhVvCcSsQqTtAaZz]/.test(ch)) {
      current = { op: ch, args: [] };
      out.push(current);
      i++;
      continue;
    }
    if (!current) throw new Error('path data must start with a command');
    // Arc flags (4th and 5th of 7 args) are single digits, possibly packed with no separator.
    const isArc = current.op === 'a' || current.op === 'A';
    const slot = current.args.length % 7;
    if (isArc && (slot === 3 || slot === 4)) {
      if (ch !== '0' && ch !== '1') throw new Error(`invalid arc flag at ${i}: "${d.slice(i, i + 12)}"`);
      current.args.push(ch === '1' ? 1 : 0);
      i++;
      continue;
    }
    NUMBER.lastIndex = i;
    const m = NUMBER.exec(d);
    if (!m) throw new Error(`invalid path data at ${i}: "${d.slice(i, i + 12)}"`);
    current.args.push(Number(m[0]));
    i = NUMBER.lastIndex;
  }
  if (out.length === 0) throw new Error('empty path data');
  if (out[0].op !== 'M' && out[0].op !== 'm') throw new Error('path data must start with M');
  for (const cmd of out) {
    const n = ARITY[cmd.op.toLowerCase()];
    if (n === 0 ? cmd.args.length !== 0 : cmd.args.length === 0 || cmd.args.length % n !== 0) {
      throw new Error(`command ${cmd.op} has ${cmd.args.length} arguments, expected a multiple of ${n}`);
    }
  }
  return out;
}

function arcPoints(
  x1: number, y1: number, rx: number, ry: number, phiDeg: number,
  largeArc: number, sweep: number, x2: number, y2: number
): [number, number][] {
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  if (rx === 0 || ry === 0 || (x1 === x2 && y1 === y2)) return [[x2, y2]];
  const phi = (phiDeg * Math.PI) / 180;
  const cos = Math.cos(phi);
  const sin = Math.sin(phi);
  const dx = (x1 - x2) / 2;
  const dy = (y1 - y2) / 2;
  const x1p = cos * dx + sin * dy;
  const y1p = -sin * dx + cos * dy;
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    rx *= Math.sqrt(lambda);
    ry *= Math.sqrt(lambda);
  }
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  let coef = Math.sqrt(Math.max(0, num / den));
  if (largeArc === sweep) coef = -coef;
  const cxp = (coef * rx * y1p) / ry;
  const cyp = (-coef * ry * x1p) / rx;
  const cx = cos * cxp - sin * cyp + (x1 + x2) / 2;
  const cy = sin * cxp + cos * cyp + (y1 + y2) / 2;
  const angle = (ux: number, uy: number, vx: number, vy: number): number =>
    Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const t1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dt = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && dt > 0) dt -= 2 * Math.PI;
  if (sweep && dt < 0) dt += 2 * Math.PI;
  const pts: [number, number][] = [];
  const steps = 32;
  for (let k = 1; k <= steps; k++) {
    const t = t1 + (dt * k) / steps;
    pts.push([cx + rx * Math.cos(t) * cos - ry * Math.sin(t) * sin, cy + rx * Math.cos(t) * sin + ry * Math.sin(t) * cos]);
  }
  return pts;
}

/** Bounds of every visited point, control points included (S/T also visit their implicit one). */
export function pathBounds(d: string): [number, number, number, number] {
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;
  let ctrlX = 0;
  let ctrlY = 0;
  let ctrlKind: 'cubic' | 'quad' | null = null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const visit = (px: number, py: number): void => {
    if (px < minX) minX = px;
    if (py < minY) minY = py;
    if (px > maxX) maxX = px;
    if (py > maxY) maxY = py;
  };

  for (const { op, args } of parsePath(d)) {
    const rel = op === op.toLowerCase();
    const kind = op.toLowerCase();
    const n = ARITY[kind];
    if (kind === 'z') {
      x = startX;
      y = startY;
      ctrlKind = null;
      continue;
    }
    for (let i = 0; i < args.length; i += n) {
      const a = args.slice(i, i + n);
      const ox = rel ? x : 0;
      const oy = rel ? y : 0;
      if (kind === 's' || kind === 't') {
        const same = ctrlKind === (kind === 's' ? 'cubic' : 'quad');
        const rx = same ? 2 * x - ctrlX : x;
        const ry = same ? 2 * y - ctrlY : y;
        visit(rx, ry);
        if (kind === 's') {
          ctrlX = ox + a[0];
          ctrlY = oy + a[1];
        } else {
          ctrlX = rx;
          ctrlY = ry;
        }
        ctrlKind = kind === 's' ? 'cubic' : 'quad';
      } else if (kind === 'c' || kind === 'q') {
        ctrlX = ox + a[n - 4];
        ctrlY = oy + a[n - 3];
        ctrlKind = kind === 'c' ? 'cubic' : 'quad';
      } else {
        ctrlKind = null;
      }
      if (kind === 'h') {
        x = ox + a[0];
        visit(x, y);
      } else if (kind === 'v') {
        y = oy + a[0];
        visit(x, y);
      } else if (kind === 'a') {
        const ex = ox + a[5];
        const ey = oy + a[6];
        for (const [px, py] of arcPoints(x, y, a[0], a[1], a[2], a[3], a[4], ex, ey)) visit(px, py);
        x = ex;
        y = ey;
      } else {
        for (let k = 0; k < n; k += 2) visit(ox + a[k], oy + a[k + 1]);
        x = ox + a[n - 2];
        y = oy + a[n - 1];
      }
      // A moveto's implicit followers are linetos; only the first pair starts a subpath.
      if (kind === 'm' && i === 0) {
        startX = x;
        startY = y;
      }
    }
  }
  return [minX, minY, maxX, maxY];
}
