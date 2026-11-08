/**
 * Escapes a string for interpolation into an HTML template.
 *
 * Field names and level labels come from the dataset, which for a real
 * `.h5ad` is a file the user obtained from somewhere else. A cell type
 * literally named `<img src=x onerror=...>` is unlikely but costs nothing
 * to defend against, and the alternative is trusting every annotation
 * column in every file anyone ever loads.
 */
export function esc(value: unknown): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
