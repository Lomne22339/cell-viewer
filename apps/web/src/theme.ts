import { getTheme, isThemeId, THEMES, type Theme, type ThemeId } from '@core/theme/themes';

const STORAGE_KEY = 'cellviewer.theme';

/** `?theme=` wins, then stored choice, then default; blocked storage must never stop the page. */
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

export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  root.dataset.theme = theme.id;
  root.style.colorScheme = theme.mode;
}

export type ThemeListener = (theme: Theme) => void;

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
    // Keep a ?theme= in the URL in step, or it would override this choice on every reload.
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
