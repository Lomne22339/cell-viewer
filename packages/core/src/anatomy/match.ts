import type { OrganModel } from './types';

/**
 * Canonical form of a region label, so that `Left_Ventricle`, `left-ventricle`
 * and `left ventricle` all compare equal. Accents are folded because atlas
 * annotations mix English and Latin spellings.
 */
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

/** A naive singular, `lungs` → `lung`, or null if the form does not look plural. */
function singular(c: string): string | null {
  return c.length > 3 && c.endsWith('s') && !c.endsWith('ss') ? c.slice(0, -1) : null;
}

/** The model's organ names, normalised, or null for a model of no single organ. */
function organNames(model: OrganModel): Set<string> | null {
  const names = (model.organAliases ?? []).map(normalizeLabel).filter(Boolean);
  return names.length ? new Set(names) : null;
}

/** Whether `text` normalises (allowing a plural) to one of the organ's names. */
function namesOrgan(text: string, organ: Set<string>): boolean {
  const c = normalizeLabel(text);
  const s = singular(c);
  return organ.has(c) || (s !== null && organ.has(s));
}

/**
 * The part immediately qualifying the last one: `liver` in `liver: left lobe`
 * and in `human: liver: left lobe`. Null for an unqualified label.
 */
function qualifierOf(parts: string[]): string | null {
  return parts.length > 1 ? parts[parts.length - 2] : null;
}

/**
 * Forms of a dataset label worth looking up, most specific first.
 *
 * Real annotations are often qualified — `heart: left ventricle`,
 * `Brain | Cerebellum` — or pluralised — `lungs`, `kidneys`. The last
 * qualified part and a naive singular are tried after the label itself.
 *
 * The last part alone is only trusted when the qualifier names this model's
 * organ (or the model names none). Region names repeat across organs — a
 * lung has a left lobe and so does the liver, a kidney has a medulla and so
 * does the brainstem — so `lung: left lobe` must not shade the liver.
 */
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

/** Normalised alias (and id and label) to segment index. */
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
  /** How many levels found a segment. */
  matchedLevels: number;
  /** How many distinct segments at least one level reached. */
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
  /** The categorical field saying which cells belong to the organ. */
  field: string;
  /** Per level code of `field`: 1 if that level is this organ. */
  levels: Uint8Array;
}

/**
 * The field that says which cells come from this model's organ at all.
 *
 * An atlas covering several organs usually has a `tissue` field next to its
 * region field, and generic region labels (`medulla`, `cortex`, `left lobe`)
 * appear under more than one organ. Restricting the counts to this field's
 * organ levels keeps renal medulla out of the brainstem.
 *
 * A level belongs to the organ when its label names the organ (`Brain`,
 * `CNS`, `brains`) or when it is qualified by it (`brain: cortex`). As in
 * region matching, a label qualified by some other organ never counts:
 * `liver: brain` is not the brain. The region field itself is passed as
 * `exclude`. The field with the most organ levels wins and ties keep the
 * earlier field, so the choice is stable. Null when the model names no organ
 * or no field mentions it.
 */
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

/**
 * The categorical field that best describes a model's regions.
 *
 * Coverage of distinct segments wins over the raw number of matched levels:
 * a `tissue` field naming six organs describes the body better than a region
 * field that happens to repeat "heart" under three spellings. The model's own
 * field hints break ties, so the choice is stable rather than alphabetical.
 */
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
