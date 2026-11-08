import { describe, expect, it } from 'vitest';
import { parsePath, pathBounds } from '@core/anatomy/path';
import { chooseField, matchLevels, normalizeLabel, organScope } from '@core/anatomy/match';
import { OrganRegistry, validateModel } from '@core/anatomy/registry';
import { cellsInSegments, segmentCounts } from '@core/anatomy/stats';
import { BUILTIN_MODELS, createDefaultRegistry } from '@core/anatomy/models';
import type { OrganModel } from '@core/anatomy/types';

const toy: OrganModel = {
  id: 'toy',
  label: 'Toy organ',
  view: 'anterior',
  viewBox: [0, 0, 100, 100],
  fieldHints: ['region'],
  segments: [
    { id: 'upper', label: 'Upper part', aliases: ['upper', 'superior part'], path: 'M10 10H90V45H10Z' },
    { id: 'lower', label: 'Lower part', aliases: ['lower', 'inferior part'], path: 'M10 55H90V90H10Z' }
  ]
};

describe('path data', () => {
  it('parses absolute and relative commands with implicit repeats', () => {
    const cmds = parsePath('M10 10 L20 20 30 30 c1,2 3,4 5,6 Z');
    expect(cmds.map(c => c.op)).toEqual(['M', 'L', 'c', 'Z']);
    expect(cmds[1].args).toEqual([20, 20, 30, 30]);
  });

  it('reads compact numbers such as 1.5.5 and 10-5', () => {
    expect(parsePath('M1.5.5L10-5').map(c => c.args)).toEqual([[1.5, 0.5], [10, -5]]);
  });

  it('rejects malformed path data', () => {
    expect(() => parsePath('L10 10')).toThrow(/start with M/);
    expect(() => parsePath('M10 10 C1 2 3')).toThrow(/multiple of 6/);
    expect(() => parsePath('M10 10 X5')).toThrow(/invalid path data/);
    expect(() => parsePath('')).toThrow(/empty/);
  });

  it('reads arc flags packed without separators, as optimisers write them', () => {
    expect(parsePath('M0 0a5 5 0 015 5').map(c => c.args)).toEqual([[0, 0], [5, 5, 0, 0, 1, 5, 5]]);
    expect(parsePath('M0 0A5,5,0,1,0,10,0').map(c => c.args)).toEqual([[0, 0], [5, 5, 0, 1, 0, 10, 0]]);
    expect(() => parsePath('M0 0a5 5 0 2 1 5 5')).toThrow(/arc flag/);
  });

  it('bounds an arc by its curve, not just its endpoints', () => {
    // A half circle of radius 5 from (0,0) to (10,0), bulging to y = -5 (sweep 1) .
    const [x0, y0, x1, y1] = pathBounds('M0 0 A5 5 0 0 1 10 0');
    expect(x0).toBeCloseTo(0);
    expect(x1).toBeCloseTo(10);
    expect(Math.min(y0, y1)).toBeLessThan(-4.9);
    expect(Math.max(Math.abs(y0), Math.abs(y1))).toBeLessThan(5.01);
  });

  it('bounds relative paths, arcs and closepath correctly', () => {
    expect(pathBounds('M10 10h20v30h-20z')).toEqual([10, 10, 30, 40]);
    // After z the pen returns to the subpath start (10,10), so the relative move
    // lands at (15,15), not (20,15), and the final line ends at (16,16).
    expect(pathBounds('M10 10l5 0z m5 5 l1 1')).toEqual([10, 10, 16, 16]);
  });

  it('includes the reflected control point of a smooth quadratic (T)', () => {
    // Q's control (50,100) reflected about its end (100,0) gives T's control
    // (150,-100). The curve itself dips to y = -50; the conservative box
    // includes the control point, as it does for every other curve.
    expect(pathBounds('M0 0Q50 100 100 0T200 0')).toEqual([0, -100, 200, 100]);
    // Relative form, and a chained T reflecting the previous T's control.
    expect(pathBounds('M0 0q50 100 100 0t100 0t100 0')).toEqual([0, -100, 300, 100]);
    // Implicit repeats chain the same way as explicit commands.
    expect(pathBounds('M0 0Q50 100 100 0T200 0 300 0')).toEqual([0, -100, 300, 100]);
  });

  it('includes the reflected control point of a smooth cubic (S)', () => {
    // C's second control (80,-100) reflected about (100,0) is (120,100).
    expect(pathBounds('M0 0C20 0 80 -100 100 0S180 0 200 0')).toEqual([0, -100, 200, 100]);
    expect(pathBounds('M0 0c20 0 80 -100 100 0s80 0 100 0')).toEqual([0, -100, 200, 100]);
  });

  it('uses the current point as the control when S or T follow another command', () => {
    expect(pathBounds('M0 0L10 0T20 0')).toEqual([0, 0, 20, 0]);
    expect(pathBounds('M0 0L10 0S15 5 20 0')).toEqual([0, 0, 20, 5]);
    // A cubic's control is not a quadratic's: T after C reflects nothing.
    expect(pathBounds('M0 0C0 50 10 50 10 0T20 0')).toEqual([0, 0, 20, 50]);
    // Nor does a new subpath inherit the previous one's control.
    expect(pathBounds('M0 0Q5 50 10 0M30 0T40 0')).toEqual([0, 0, 40, 50]);
  });
});

describe('label matching', () => {
  it('normalises case, punctuation, underscores and accents', () => {
    expect(normalizeLabel('Left_Ventricle')).toBe('left ventricle');
    expect(normalizeLabel('  left-ventricle. ')).toBe('left ventricle');
    expect(normalizeLabel('Lóbulo Caudado')).toBe('lobulo caudado');
  });

  it('maps qualified, plural and differently spelled levels to segments', () => {
    const m = matchLevels(toy, ['Upper', 'toy: Lower part', 'uppers', 'nothing', 'SUPERIOR_PART']);
    expect(Array.from(m.levelToSegment)).toEqual([0, 1, 0, -1, 0]);
    expect(m.matchedLevels).toBe(4);
    expect(m.matchedSegments).toBe(2);
  });

  it('chooses the field covering the most segments, then the model hint', () => {
    const fields = [
      { name: 'cell_type', levels: ['T cell', 'B cell'] },
      { name: 'zone', levels: ['upper', 'lower'] },
      { name: 'region', levels: ['upper', 'lower'] },
      { name: 'partial', levels: ['upper', 'upper part', 'superior part'] }
    ];
    const choice = chooseField(toy, fields)!;
    expect(choice.field).toBe('region');
    expect(chooseField(toy, [{ name: 'cell_type', levels: ['T cell'] }])).toBeNull();
  });

  it('matches the synthetic datasets’ tissue field to the body model', () => {
    const body = BUILTIN_MODELS.find(m => m.id === 'body')!;
    const tissues = ['lung', 'liver', 'brain', 'colon', 'kidney', 'blood', 'spleen', 'skin'];
    const m = matchLevels(body, tissues);
    expect(m.matchedLevels).toBe(tissues.length);
  });

  it('matches atlas region labels to the detailed organ models', () => {
    const reg = createDefaultRegistry();
    const expectAll = (id: string, labels: string[]): void => {
      const m = matchLevels(reg.get(id)!, labels);
      expect(m.matchedLevels, `${id}: ${labels.join(', ')}`).toBe(labels.length);
    };
    expectAll('heart', ['right atrium', 'left atrium', 'right ventricle', 'left ventricle', 'interventricular septum', 'apex']);
    expectAll('brain', ['frontal lobe', 'parietal lobe', 'temporal lobe', 'occipital lobe', 'cerebellum', 'brainstem', 'hippocampus', 'thalamus']);
    expectAll('liver', ['liver: right lobe', 'liver: left lobe', 'liver: caudate lobe', 'liver: quadrate lobe']);
    expectAll('pancreas', ['pancreas: head', 'pancreas: neck', 'pancreas: body', 'pancreas: tail']);
  });

  it('names the organ itself on every detailed model, and not on the body', () => {
    const reg = createDefaultRegistry();
    expect(reg.get('heart')!.organAliases).toEqual(['heart', 'cardiac', 'myocardium']);
    expect(reg.get('brain')!.organAliases).toEqual(['brain', 'cerebrum', 'central nervous system', 'cns']);
    expect(reg.get('liver')!.organAliases).toEqual(['liver', 'hepatic']);
    expect(reg.get('pancreas')!.organAliases).toEqual(['pancreas', 'pancreatic']);
    expect(reg.get('body')!.organAliases).toBeUndefined();
  });

  it('never lends one organ’s qualified region to another organ', () => {
    const reg = createDefaultRegistry();
    const liver = reg.get('liver')!;
    const left = liver.segments.findIndex(s => s.id === 'left_lobe');
    const right = liver.segments.findIndex(s => s.id === 'right_lobe');
    const caudate = liver.segments.findIndex(s => s.id === 'caudate_lobe');
    const m = matchLevels(liver, [
      'lung: left lobe',
      'liver: left lobe',
      'Liver | right lobe',
      'hepatic - caudate lobe',
      'left lobe',
      'lungs / right lobe',
      'human: liver: left lobe',
      'livers: right lobe'
    ]);
    expect(Array.from(m.levelToSegment)).toEqual([-1, left, right, caudate, left, -1, left, right]);

    const brain = reg.get('brain')!;
    const stem = brain.segments.findIndex(s => s.id === 'brainstem');
    const b = matchLevels(brain, ['kidney: medulla', 'brain: medulla', 'CNS / medulla', 'medulla']);
    expect(Array.from(b.levelToSegment)).toEqual([-1, stem, stem, stem]);

    const heart = reg.get('heart')!;
    const apex = heart.segments.findIndex(s => s.id === 'apex');
    expect(Array.from(matchLevels(heart, ['lung: apex', 'cardiac: apex']).levelToSegment)).toEqual([-1, apex]);
  });

  it('lets any qualifier through on a model that does not name its organ', () => {
    // The body has no organ of its own, and the toy has no organ aliases.
    expect(Array.from(matchLevels(toy, ['anything: upper']).levelToSegment)).toEqual([0]);
    const body = BUILTIN_MODELS.find(m => m.id === 'body')!;
    expect(matchLevels(body, ['tissue: lung', 'organ | liver']).matchedLevels).toBe(2);
  });
});

describe('organ scope', () => {
  const brain = BUILTIN_MODELS.find(m => m.id === 'brain')!;

  it('finds the field naming the organ and flags its levels', () => {
    const fields = [
      { name: 'region', levels: ['frontal lobe', 'medulla', 'cerebellum'] },
      { name: 'cell_type', levels: ['neuron', 'podocyte'] },
      { name: 'tissue', levels: ['Brain', 'kidney', 'CNS', 'brains', 'liver: brain'] }
    ];
    const scope = organScope(brain, fields, 'region')!;
    expect(scope.field).toBe('tissue');
    // `liver: brain` is qualified by another organ, so it does not count.
    expect(Array.from(scope.levels)).toEqual([1, 0, 1, 1, 0]);
  });

  it('accepts a level qualified by the organ, as region matching does', () => {
    const scope = organScope(brain, [
      { name: 'sample', levels: ['brain: cortex', 'kidney: medulla', 'cerebrum | white matter'] }
    ])!;
    expect(scope.field).toBe('sample');
    expect(Array.from(scope.levels)).toEqual([1, 0, 1]);
  });

  it('prefers the field with more organ levels and never picks the excluded one', () => {
    const fields = [
      { name: 'tissue', levels: ['brain', 'kidney'] },
      { name: 'source', levels: ['brain', 'cns', 'kidney'] },
      { name: 'region', levels: ['brain', 'cns', 'cerebrum', 'medulla'] }
    ];
    expect(organScope(brain, fields, 'region')!.field).toBe('source');
    // A tie keeps the first field, so the choice does not flicker.
    expect(organScope(brain, fields.slice(0, 1).concat({ name: 'b', levels: ['cns', 'x'] }))!.field).toBe('tissue');
  });

  it('is null when the model has no organ aliases or nothing names the organ', () => {
    const body = BUILTIN_MODELS.find(m => m.id === 'body')!;
    expect(organScope(body, [{ name: 'tissue', levels: ['brain', 'lung'] }])).toBeNull();
    expect(organScope(brain, [{ name: 'tissue', levels: ['lung', 'kidney'] }])).toBeNull();
    expect(organScope(brain, [{ name: 'tissue', levels: ['brain'] }], 'tissue')).toBeNull();
    expect(organScope(brain, [])).toBeNull();
    expect(organScope(brain, [{ name: 'empty', levels: [] }])).toBeNull();
  });

  it('excludes generic labels from other organs once counts are scoped', () => {
    // A two-organ atlas: brainstem medulla and renal medulla share one label.
    const region = ['frontal lobe', 'medulla'];
    const tissue = ['brain', 'kidney'];
    const regionCodes = Uint16Array.from([0, 1, 1, 1, 1, 0]);
    const tissueCodes = Uint16Array.from([0, 0, 1, 1, 1, 0]);
    const match = matchLevels(brain, region);
    const stem = brain.segments.findIndex(s => s.id === 'brainstem');
    const frontal = brain.segments.findIndex(s => s.id === 'frontal_lobe');
    const scope = organScope(brain, [{ name: 'region', levels: region }, { name: 'tissue', levels: tissue }], 'region')!;
    expect(scope.field).toBe('tissue');
    const within = { codes: tissueCodes, levels: scope.levels };

    const unscoped = segmentCounts(regionCodes, match.levelToSegment, brain.segments.length, { upTo: 6 });
    expect(unscoped[stem]).toBe(4);
    const scoped = segmentCounts(regionCodes, match.levelToSegment, brain.segments.length, { upTo: 6, within });
    expect(scoped[stem]).toBe(1);
    expect(scoped[frontal]).toBe(2);

    expect(Array.from(cellsInSegments(regionCodes, match.levelToSegment, [stem], 6))).toEqual([1, 2, 3, 4]);
    expect(Array.from(cellsInSegments(regionCodes, match.levelToSegment, [stem], 6, null, within))).toEqual([1]);
  });
});

describe('model validation and registry', () => {
  it('accepts every built-in model', () => {
    for (const model of BUILTIN_MODELS) expect(validateModel(model), model.id).toEqual([]);
  });

  it('ships body, heart, brain, liver and pancreas with no dangling drill-downs', () => {
    // The five the client asked for must be there, in order, but a sixth organ
    // appended to BUILTIN_MODELS must not need this test edited (F5).
    const reg = createDefaultRegistry();
    const ids = reg.list().map(m => m.id);
    expect(ids).toEqual(BUILTIN_MODELS.map(m => m.id));
    expect(ids.slice(0, 5)).toEqual(['body', 'heart', 'brain', 'liver', 'pancreas']);
    expect(reg.danglingDrillDowns()).toEqual([]);
    const body = reg.get('body')!;
    const drills = body.segments.filter(s => s.drillDown).map(s => s.drillDown);
    expect(drills).toEqual(expect.arrayContaining(['brain', 'heart', 'liver', 'pancreas']));
  });

  it('names its organ on every single-organ model, so region names never cross organs', () => {
    // Without organAliases a qualified label like `brain: medulla` would shade
    // the medulla of any organ that has one. Only the whole body names none.
    for (const model of BUILTIN_MODELS) {
      if (model.id === 'body') continue;
      expect(model.organAliases?.length ?? 0, model.id).toBeGreaterThan(0);
    }
  });

  it('rejects duplicate ids, colliding aliases and paths outside the viewBox', () => {
    const bad: OrganModel = {
      ...toy,
      segments: [
        { id: 'a', label: 'A', aliases: ['shared'], path: 'M0 0H10V10Z' },
        { id: 'a', label: 'A2', aliases: [], path: 'M0 0H10V10Z' },
        { id: 'b', label: 'B', aliases: ['Shared'], path: 'M0 0H500V10Z' }
      ]
    };
    const errors = validateModel(bad).join('\n');
    expect(errors).toMatch(/duplicate segment id "a"/);
    expect(errors).toMatch(/alias "Shared" belongs to both/);
    expect(errors).toMatch(/outside the viewBox/);
    expect(() => new OrganRegistry().register(bad)).toThrow(/invalid organ model/);
  });

  it('can skip an invalid built-in model instead of failing the whole registry', () => {
    const reported: string[] = [];
    const reg = createDefaultRegistry(m => reported.push(m.id));
    expect(reported).toEqual([]);
    expect(reg.list()).toHaveLength(BUILTIN_MODELS.length);
  });

  it('registers a new organ with no other code changes (modularity)', () => {
    const reg = createDefaultRegistry().register(toy);
    expect(reg.get('toy')).toBe(toy);
    expect(reg.list().at(-1)!.id).toBe('toy');
    expect(() => reg.register(toy)).toThrow(/already registered/);
  });
});

describe('segment statistics', () => {
  // levels: 0 upper, 1 lower, 2 unmatched
  const levelToSegment = Int32Array.from([0, 1, -1]);
  const codes = Uint16Array.from([0, 1, 2, 0, 0, 1, 2, 1, 0, 0]);

  // A second field (say tissue) scoping the counts: level 1 is the organ, and
  // code 5 is outside the dictionary, which must count as "not the organ".
  const within = { codes: Uint16Array.from([1, 1, 0, 1, 5, 1, 1, 0, 1, 1]), levels: Uint8Array.from([0, 1]) };

  function bruteCounts(
    upTo: number,
    indices: number[] | null,
    visible: Uint8Array | null,
    scope: typeof within | null
  ): number[] {
    const out = [0, 0];
    const cells = indices ?? Array.from({ length: upTo }, (_, i) => i);
    for (const i of cells) {
      if (i >= upTo || (visible && !visible[i])) continue;
      if (scope && scope.levels[scope.codes[i]] !== 1) continue;
      const s = levelToSegment[codes[i]];
      if (s >= 0) out[s]++;
    }
    return out;
  }

  function bruteCells(segments: number[], upTo: number, visible: Uint8Array | null, scope: typeof within | null): number[] {
    const out: number[] = [];
    for (let i = 0; i < upTo; i++) {
      if (visible && !visible[i]) continue;
      if (scope && scope.levels[scope.codes[i]] !== 1) continue;
      if (segments.includes(levelToSegment[codes[i]])) out.push(i);
    }
    return out;
  }

  it('counts cells per segment, honouring the loaded prefix, selection, filter and organ scope', () => {
    const visible = Uint8Array.from([1, 1, 1, 0, 1, 1, 1, 1, 0, 1]);
    for (const upTo of [0, 4, 10]) {
      for (const indices of [null, [0, 1, 3, 4, 5, 8, 9]]) {
        for (const vis of [null, visible]) {
          for (const scope of [null, within]) {
            const got = segmentCounts(codes, levelToSegment, 2, {
              upTo,
              indices: indices ? Uint32Array.from(indices) : null,
              visible: vis,
              within: scope
            });
            expect(Array.from(got)).toEqual(bruteCounts(upTo, indices, vis, scope));
          }
        }
      }
    }
  });

  it('selects the same cells as a brute-force scan under every combination of options', () => {
    const visible = Uint8Array.from([1, 1, 1, 0, 1, 1, 1, 1, 0, 1]);
    for (const segments of [[], [0], [1], [0, 1]]) {
      for (const upTo of [0, 4, 10]) {
        for (const vis of [null, visible]) {
          for (const scope of [null, within]) {
            const got = cellsInSegments(codes, levelToSegment, segments, upTo, vis, scope);
            expect(Array.from(got)).toEqual(bruteCells(segments, upTo, vis, scope));
          }
        }
      }
    }
  });

  it('ignores codes beyond the level dictionary instead of reading garbage', () => {
    const counts = segmentCounts(Uint16Array.from([0, 7, 1]), levelToSegment, 2, { upTo: 3 });
    expect(Array.from(counts)).toEqual([1, 1]);
  });

  it('selects exactly the visible cells of the chosen segments, in order', () => {
    expect(Array.from(cellsInSegments(codes, levelToSegment, [0], 10))).toEqual([0, 3, 4, 8, 9]);
    const visible = Uint8Array.from([1, 1, 1, 0, 1, 1, 1, 1, 0, 1]);
    expect(Array.from(cellsInSegments(codes, levelToSegment, [0, 1], 10, visible))).toEqual([0, 1, 4, 5, 7, 9]);
    expect(Array.from(cellsInSegments(codes, levelToSegment, [0], 4))).toEqual([0, 3]);
    expect(cellsInSegments(codes, levelToSegment, [], 10).length).toBe(0);
  });
});
