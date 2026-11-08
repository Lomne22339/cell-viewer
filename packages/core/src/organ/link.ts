/**
 * One view's selection, as a link needs to see it: a way to hear of changes
 * (cells by index, or null when cleared) and a way to set one. Selection
 * itself stays in each view's own `SelectionStore`; this only passes it on.
 */
export interface SelectionPort {
  subscribe: (cb: (indices: Uint32Array | null) => void) => () => void;
  apply: (indices: Uint32Array | null) => void;
}

/**
 * Keeps two views' selections the same.
 *
 * The Organ View's UMAP and trajectory hold the same cells in the same order,
 * so a selection is the same index list in both and no translation is needed.
 * Applying a selection makes the receiving view report it as a change, which
 * would bounce straight back; the `applying` flag drops that echo, and is
 * cleared even if applying throws, so one failure does not silence the link.
 * Returns a function that unlinks them.
 */
export function linkSelections(a: SelectionPort, b: SelectionPort): () => void {
  let applying = false;
  const forward = (to: SelectionPort) => (indices: Uint32Array | null): void => {
    if (applying) return;
    applying = true;
    try {
      to.apply(indices);
    } finally {
      applying = false;
    }
  };
  const offA = a.subscribe(forward(b));
  const offB = b.subscribe(forward(a));
  return () => {
    offA();
    offB();
  };
}
