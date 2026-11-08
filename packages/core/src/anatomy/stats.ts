/**
 * Per-segment cell counts and segment-to-cell selection.
 *
 * Both run over the code column directly, so a whole-body shading at ten
 * million cells is one flat pass with a level lookup per cell. Levels are
 * mapped to segments once, up front; the per-cell loop never touches strings.
 */

/**
 * Cells allowed by a second categorical field, typically the organ scope from
 * `organScope`: a cell counts only if `levels[codes[i]]` is 1. A code outside
 * `levels` counts as not flagged.
 */
export interface WithinField {
  codes: Uint16Array;
  levels: Uint8Array;
}

export interface SegmentScope {
  /** Only `[0, upTo)` is real data. */
  upTo: number;
  /** Restrict to these cells (a selection). Null means every cell. */
  indices?: Uint32Array | null;
  /** Per-cell visibility from the legend filter. Null means all visible. */
  visible?: Uint8Array | null;
  /**
   * Restrict to the cells of one organ, so a region label shared between
   * organs (`medulla`) only counts the cells of the organ on screen.
   * Null means every cell.
   */
  within?: WithinField | null;
}

/** Counts cells per segment within the scope. Unmatched levels are skipped. */
export function segmentCounts(
  codes: Uint16Array,
  levelToSegment: Int32Array,
  segmentCount: number,
  scope: SegmentScope
): Uint32Array {
  const counts = new Uint32Array(segmentCount);
  const levels = levelToSegment.length;
  const { upTo, indices, visible } = scope;
  const wCodes = scope.within ? scope.within.codes : null;
  const wLevels = scope.within ? scope.within.levels : null;
  if (indices) {
    for (let k = 0; k < indices.length; k++) {
      const i = indices[k];
      if (i >= upTo || (visible && !visible[i])) continue;
      if (wCodes !== null && wLevels![wCodes[i]] !== 1) continue;
      const code = codes[i];
      if (code >= levels) continue;
      const s = levelToSegment[code];
      if (s >= 0) counts[s]++;
    }
    return counts;
  }
  for (let i = 0; i < upTo; i++) {
    if (visible && !visible[i]) continue;
    if (wCodes !== null && wLevels![wCodes[i]] !== 1) continue;
    const code = codes[i];
    if (code >= levels) continue;
    const s = levelToSegment[code];
    if (s >= 0) counts[s]++;
  }
  return counts;
}

/**
 * Indices of every visible cell whose level maps to one of `segments`, in
 * ascending order — the same shape a lasso query returns, so the result can go
 * straight into the selection store. `within` restricts to one organ's cells,
 * as in `SegmentScope`.
 */
export function cellsInSegments(
  codes: Uint16Array,
  levelToSegment: Int32Array,
  segments: Iterable<number>,
  upTo: number,
  visible: Uint8Array | null = null,
  within: WithinField | null = null
): Uint32Array {
  const wanted = new Set(segments);
  const levelWanted = new Uint8Array(levelToSegment.length);
  for (let l = 0; l < levelToSegment.length; l++) {
    if (wanted.has(levelToSegment[l])) levelWanted[l] = 1;
  }
  const levels = levelWanted.length;
  const wCodes = within ? within.codes : null;
  const wLevels = within ? within.levels : null;
  let count = 0;
  for (let i = 0; i < upTo; i++) {
    const code = codes[i];
    if (code >= levels || !levelWanted[code] || (visible && !visible[i])) continue;
    if (wCodes !== null && wLevels![wCodes[i]] !== 1) continue;
    count++;
  }
  const out = new Uint32Array(count);
  let k = 0;
  for (let i = 0; i < upTo; i++) {
    const code = codes[i];
    if (code >= levels || !levelWanted[code] || (visible && !visible[i])) continue;
    if (wCodes !== null && wLevels![wCodes[i]] !== 1) continue;
    out[k++] = i;
  }
  return out;
}
