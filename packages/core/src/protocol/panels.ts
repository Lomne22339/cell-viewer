/**
 * Which grid cell each panel occupies.
 *
 * With nothing expanded every panel keeps its own cell. Expanding one gives it
 * the `main` cell and moves the rest, in their usual order, onto the rail as
 * thumbnails (`rail1`, `rail2`, ...). The panels themselves are never moved in
 * the DOM, only re-assigned a cell, so a canvas or a conversation keeps its
 * state through an expand and a collapse.
 */
export function assignSlots(order: string[], expanded: string | null): Record<string, string> {
  if (new Set(order).size !== order.length) throw new Error('duplicate panel id');
  const slots: Record<string, string> = {};
  if (expanded === null || !order.includes(expanded)) {
    for (const id of order) slots[id] = id;
    return slots;
  }
  slots[expanded] = 'main';
  let rail = 1;
  for (const id of order) if (id !== expanded) slots[id] = `rail${rail++}`;
  return slots;
}
