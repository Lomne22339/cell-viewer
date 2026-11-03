/** Per-segment cell counts and segment-to-cell selection, as flat passes over the code column. */

export interface WithinField {
  codes: Uint16Array;
  levels: Uint8Array;
}

export interface SegmentScope {
  /** Only `[0, upTo)` is real data. */
  upTo: number;
  indices?: Uint32Array | null;
  visible?: Uint8Array | null;
  within?: WithinField | null;
}

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
