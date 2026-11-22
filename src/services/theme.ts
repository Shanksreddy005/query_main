export type ThemePreference = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

// index.html has to decide the theme before the first paint, so it carries a small synchronous copy
// of this key and of the resolution rule below. tests/theme_behavior.test.ts fails if the two drift.
export const THEME_STORAGE_KEY = 'query_mind_theme_preference';
export const DARK_CLASS = 'dark';
const DARK_MEDIA_QUERY = '(prefers-color-scheme: dark)';

// A first visit follows the operating system rather than a hard-coded theme.
const DEFAULT_PREFERENCE: ThemePreference = 'system';

const PREFERENCES: ThemePreference[] = ['light', 'dark', 'system'];

export const NEXT_THEME_PREFERENCE: Record<ThemePreference, ThemePreference> = {
  light: 'dark',
  dark: 'system',
  system: 'light',
};

export function normalizeThemePreference(value: unknown): ThemePreference | null {
  return PREFERENCES.indexOf(value as ThemePreference) !== -1 ? (value as ThemePreference) : null;
}

export function resolveTheme(preference: ThemePreference, systemPrefersDark: boolean): ResolvedTheme {
  if (preference === 'system') return systemPrefersDark ? 'dark' : 'light';
  return preference;
}

function getStorage(): Storage | null {
  if (typeof window !== 'undefined' && window.localStorage) {
    return window.localStorage;
  }
  if (typeof localStorage !== 'undefined') {
    return localStorage;
  }
  if (typeof globalThis !== 'undefined' && (globalThis as any).localStorage) {
    return (globalThis as any).localStorage;
  }
  return null;
}

export function readStoredThemePreference(): ThemePreference | null {
  try {
    const storage = getStorage();
    return storage ? normalizeThemePreference(storage.getItem(THEME_STORAGE_KEY)) : null;
  } catch {
    return null;
  }
}

/** A refused write is not a failure the user can act on, so the caller only reports it to tests. */
export function writeStoredThemePreference(preference: ThemePreference): boolean {
  try {
    const storage = getStorage();
    if (!storage) return false;
    storage.setItem(THEME_STORAGE_KEY, preference);
    return true;
  } catch {
    return false;
  }
}

function getDarkMediaQuery(): MediaQueryList | null {
  try {
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      return window.matchMedia(DARK_MEDIA_QUERY);
    }
  } catch {
    return null;
  }
  return null;
}

export function systemPrefersDark(): boolean {
  const media = getDarkMediaQuery();
  return media ? media.matches : false;
}

/**
 * The preference and the theme it resolves to, from the same inputs the pre-paint initializer in
 * index.html reads — so React's first render never has to correct the theme after mounting.
 */
export function readInitialState(): { preference: ThemePreference; resolved: ResolvedTheme } {
  const preference = readStoredThemePreference() ?? DEFAULT_PREFERENCE;
  return { preference, resolved: resolveTheme(preference, systemPrefersDark()) };
}

interface ClassToggleTarget {
  classList: { toggle: (className: string, force: boolean) => unknown };
}

export function applyThemeClass(resolved: ResolvedTheme, target?: ClassToggleTarget): void {
  const root = target ?? (typeof document !== 'undefined' ? document.documentElement : null);
  if (!root) return;
  root.classList.toggle(DARK_CLASS, resolved === 'dark');
}

export function subscribeToSystemPreference(
  listener: (prefersDark: boolean) => void,
  source?: MediaQueryList | null
): () => void {
  const media = source !== undefined ? source : getDarkMediaQuery();
  if (!media) return () => {};
  const onChange = (event: MediaQueryListEvent) => listener(event.matches);
  media.addEventListener('change', onChange);
  return () => media.removeEventListener('change', onChange);
}
