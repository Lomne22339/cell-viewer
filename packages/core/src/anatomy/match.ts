import type { OrganModel } from './types';

export function normalizeLabel(label: string): string {
  return label
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[_\-./,;:()[\]'’"|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** `x: y`, `x | y`, `x - y` and `x / y` all read as "y, within x". */
const QUALIFIER = /:|\||\s-\s|\//;

function singular(c: string): string | null {
  return c.length > 3 && c.endsWith('s') && !c.endsWith('ss') ? c.slice(0, -1) : null;
}

function organNames(model: OrganModel): Set<string> | null {
  const names = (model.organAliases ?? []).map(normalizeLabel).filter(Boolean);
  return names.length ? new Set(names) : null;
}

function namesOrgan(text: string, organ: Set<string>): boolean {
  const c = normalizeLabel(text);
  const s = singular(c);
  return organ.has(c) || (s !== null && organ.has(s));
}

function qualifierOf(parts: string[]): string | null {
  return parts.length > 1 ? parts[parts.length - 2] : null;
}

/** Lookup forms, most specific first; `lung: left lobe` must not shade the liver (qualifier check). */
function candidates(label: string, organ: Set<string> | null): string[] {
  const out = [normalizeLabel(label)];
  const parts = label.split(QUALIFIER);
  const qualifier = qualifierOf(parts);
  if (qualifier !== null && (organ === null || namesOrgan(qualifier, organ))) {
    out.push(normalizeLabel(parts[parts.length - 1]));
  }
  for (const c of [...out]) {
    const s = singular(c);
    if (s !== null) out.push(s);
  }
  return out.filter((c, i) => c && out.indexOf(c) === i);
}

export function aliasIndex(model: OrganModel): Map<string, number> {
  const index = new Map<string, number>();
  model.segments.forEach((seg, s) => {
    for (const alias of [seg.id, seg.label, ...seg.aliases]) {
      const key = normalizeLabel(alias);
      if (key && !index.has(key)) index.set(key, s);
    }
  });
  return index;
}

export interface LevelMatch {
  /** For each level code, the segment it belongs to, or -1. */
  levelToSegment: Int32Array;
  matchedLevels: number;
  matchedSegments: number;
}

export function matchLevels(model: OrganModel, levels: string[]): LevelMatch {
  const index = aliasIndex(model);
  const organ = organNames(model);
  const levelToSegment = new Int32Array(levels.length).fill(-1);
  const reached = new Uint8Array(model.segments.length);
  let matchedLevels = 0;
  levels.forEach((label, code) => {
    for (const key of candidates(label, organ)) {
      const s = index.get(key);
      if (s !== undefined) {
        levelToSegment[code] = s;
        reached[s] = 1;
        matchedLevels++;
        return;
      }
    }
  });
  let matchedSegments = 0;
  for (let s = 0; s < reached.length; s++) matchedSegments += reached[s];
  return { levelToSegment, matchedLevels, matchedSegments };
}

export interface FieldChoice {
  field: string;
  match: LevelMatch;
}

export interface OrganScope {
  field: string;
  levels: Uint8Array;
}

/** The field marking this organ's cells (e.g. `tissue`), so another organ's `medulla` is skipped. */
export function organScope(
  model: OrganModel,
  fields: { name: string; levels: string[] }[],
  exclude?: string
): OrganScope | null {
  const organ = organNames(model);
  if (!organ) return null;
  let best: OrganScope | null = null;
  let bestCount = 0;
  for (const { name, levels } of fields) {
    if (name === exclude) continue;
    const mask = new Uint8Array(levels.length);
    let count = 0;
    levels.forEach((label, code) => {
      const qualifier = qualifierOf(label.split(QUALIFIER));
      if (namesOrgan(label, organ) || (qualifier !== null && namesOrgan(qualifier, organ))) {
        mask[code] = 1;
        count++;
      }
    });
    if (count > bestCount) {
      best = { field: name, levels: mask };
      bestCount = count;
    }
  }
  return best;
}

export function chooseField(
  model: OrganModel,
  fields: { name: string; levels: string[] }[]
): FieldChoice | null {
  const hints = (model.fieldHints ?? []).map(normalizeLabel);
  const hintRank = (name: string): number => {
    const i = hints.indexOf(normalizeLabel(name));
    return i < 0 ? hints.length : i;
  };
  let best: FieldChoice | null = null;
  for (const { name, levels } of fields) {
    const match = matchLevels(model, levels);
    if (match.matchedSegments === 0) continue;
    if (
      !best ||
      match.matchedSegments > best.match.matchedSegments ||
      (match.matchedSegments === best.match.matchedSegments &&
        (match.matchedLevels > best.match.matchedLevels ||
          (match.matchedLevels === best.match.matchedLevels &&
            hintRank(name) < hintRank(best.field))))
    ) {
      best = { field: name, match };
    }
  }
  return best;
}
