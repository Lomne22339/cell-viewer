import type { OrganModel } from './types';
import { normalizeLabel } from './match';
import { pathBounds } from './path';

/**
 * Every problem with a model that would render wrongly or match ambiguously.
 * An empty list means the model is safe to register.
 */
export function validateModel(model: OrganModel): string[] {
  const errors: string[] = [];
  if (!model.id) errors.push('model has no id');
  if (model.segments.length === 0) errors.push(`${model.id}: no segments`);
  const [vx, vy, vw, vh] = model.viewBox;
  // A little slack: a stroke on the outermost edge may legitimately touch it.
  const slack = 0.02 * Math.max(vw, vh);

  const ids = new Set<string>();
  const aliasOwner = new Map<string, string>();
  for (const seg of model.segments) {
    if (ids.has(seg.id)) errors.push(`${model.id}: duplicate segment id "${seg.id}"`);
    ids.add(seg.id);
    for (const alias of [seg.id, seg.label, ...seg.aliases]) {
      const key = normalizeLabel(alias);
      const owner = aliasOwner.get(key);
      if (owner !== undefined && owner !== seg.id) {
        errors.push(`${model.id}: alias "${alias}" belongs to both "${owner}" and "${seg.id}"`);
      } else {
        aliasOwner.set(key, seg.id);
      }
    }
    checkPath(`${model.id}.${seg.id}`, seg.path);
  }
  (model.decor ?? []).forEach((d, i) => checkPath(`${model.id}.decor[${i}]`, d.path));
  return errors;

  function checkPath(where: string, d: string): void {
    try {
      const [x0, y0, x1, y1] = pathBounds(d);
      if (x0 < vx - slack || y0 < vy - slack || x1 > vx + vw + slack || y1 > vy + vh + slack) {
        errors.push(`${where}: path extends outside the viewBox`);
      }
    } catch (err) {
      errors.push(`${where}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/**
 * The set of organ models a viewer offers.
 *
 * Registration validates, so a broken model fails at start-up with a message
 * naming the segment instead of rendering as a hole.
 */
export class OrganRegistry {
  private models = new Map<string, OrganModel>();

  register(model: OrganModel): this {
    if (this.models.has(model.id)) throw new Error(`organ model "${model.id}" already registered`);
    const errors = validateModel(model);
    if (errors.length) throw new Error(`invalid organ model:\n${errors.join('\n')}`);
    this.models.set(model.id, model);
    return this;
  }

  get(id: string): OrganModel | undefined {
    return this.models.get(id);
  }

  has(id: string): boolean {
    return this.models.has(id);
  }

  /** In registration order, which is the order the panel shows them. */
  list(): OrganModel[] {
    return [...this.models.values()];
  }

  /** Drill-down links that point at a model nobody registered. */
  danglingDrillDowns(): string[] {
    const out: string[] = [];
    for (const m of this.models.values()) {
      for (const s of m.segments) {
        if (s.drillDown && !this.models.has(s.drillDown)) out.push(`${m.id}.${s.id} -> ${s.drillDown}`);
      }
    }
    return out;
  }
}
