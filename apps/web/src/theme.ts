import { getTheme, isThemeId, THEMES, type Theme, type ThemeId } from '@core/theme/themes';

const STORAGE_KEY = 'cellviewer.theme';

/**
 * `?theme=` wins (so a link or a screenshot test can pin one), then the last
 * choice this browser made, then the default. Storage can be unavailable — a
 * private window, a sandboxed frame — and that must never stop the page.
 */
export function themeFromLocation(): Theme {
  const fromUrl = new URLSearchParams(location.search).get('theme');
  if (isThemeId(fromUrl)) return getTheme(fromUrl);
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (isThemeId(saved)) return getTheme(saved);
  } catch {
    /* storage blocked: use the default */
  }
  return getTheme(null);
}

/** Switches every CSS custom property at once via the root `data-theme`. */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  root.dataset.theme = theme.id;
  root.style.colorScheme = theme.mode;
}

export type ThemeListener = (theme: Theme) => void;

/**
 * The one place the active theme lives. The canvas, the trajectory overlay,
 * the inset and the anatomy figure subscribe; none of them reads storage or
 * the DOM attribute directly.
 */
export class ThemeStore {
  private listeners = new Set<ThemeListener>();
  current: Theme;

  constructor(initial: Theme = themeFromLocation()) {
    this.current = initial;
    applyTheme(initial);
  }

  set(id: ThemeId): void {
    if (id === this.current.id) return;
    this.current = getTheme(id);
    applyTheme(this.current);
    try {
      localStorage.setItem(STORAGE_KEY, id);
    } catch {
      /* not persisted, still applied */
    }
    // A ?theme= in the address would otherwise override this choice on every
    // reload; keep the URL in step so a copied link shows what the user sees.
    const url = new URL(location.href);
    if (url.searchParams.has('theme')) {
      url.searchParams.set('theme', id);
      history.replaceState(history.state, '', url);
    }
    for (const fn of this.listeners) {
      try {
        fn(this.current);
      } catch (err) {
        console.error('theme listener failed', err);
      }
    }
  }

  subscribe(fn: ThemeListener): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  all(): readonly Theme[] {
    return THEMES;
  }
}
