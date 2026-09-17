import { maskFromIndices } from './query';

export interface Selection {
  indices: Uint32Array;
  mask: Uint8Array;
  bbox: [number, number, number, number];
  shape: 'poly' | 'rect';
}

export type SelectionListener = (sel: Selection | null) => void;

/**
 * The single place selection state lives. The canvas, the summary panel and
 * the chat panel all read from here and none of them reach into each other.
 */
export class SelectionStore {
  private listeners = new Set<SelectionListener>();
  current: Selection | null = null;

  constructor(
    private n: number,
    private xy: Float32Array
  ) {}

  subscribe(fn: SelectionListener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  set(indices: Uint32Array, shape: 'poly' | 'rect'): void {
    if (indices.length === 0) {
      this.clear();
      return;
    }
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let k = 0; k < indices.length; k++) {
      const i = indices[k];
      const x = this.xy[i * 2];
      const y = this.xy[i * 2 + 1];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    this.current = {
      indices,
      mask: maskFromIndices(indices, this.n),
      bbox: [minX, minY, maxX, maxY],
      shape
    };
    this.emit();
  }

  clear(): void {
    this.current = null;
    this.emit();
  }

  private emit(): void {
    // A listener that throws must not silence the ones after it; a broken
    // chat panel should not also break the legend.
    for (const fn of this.listeners) {
      try {
        fn(this.current);
      } catch (err) {
        console.error('selection listener failed', err);
      }
    }
  }
}
