import { useCallback, useEffect, useRef, useState } from 'react';
import {
  NEXT_THEME_PREFERENCE,
  applyThemeClass,
  readInitialState,
  resolveTheme,
  subscribeToSystemPreference,
  systemPrefersDark,
  writeStoredThemePreference,
} from '../services/theme';
import type { ResolvedTheme, ThemePreference } from '../services/theme';

export interface ThemeController {
  /** What the user asked for. Kept separate from `resolved` so 'system' stays visible in the UI. */
  preference: ThemePreference;
  /** Which of the two palettes `preference` currently produces. */
  resolved: ResolvedTheme;
  setPreference: (preference: ThemePreference) => void;
  cyclePreference: () => void;
}

export function useTheme(): ThemeController {
  const [preference, setPreferenceState] = useState<ThemePreference>(() => readInitialState().preference);
  const [prefersDark, setPrefersDark] = useState<boolean>(systemPrefersDark);
  const resolved = resolveTheme(preference, prefersDark);

  useEffect(() => {
    if (preference !== 'system') return;
    return subscribeToSystemPreference(setPrefersDark);
  }, [preference]);

  useEffect(() => {
    applyThemeClass(resolved);
  }, [resolved]);

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next);
    writeStoredThemePreference(next);
  }, []);

  const preferenceRef = useRef(preference);
  preferenceRef.current = preference;
  const cyclePreference = useCallback(
    () => setPreference(NEXT_THEME_PREFERENCE[preferenceRef.current]),
    [setPreference]
  );

  return { preference, resolved, setPreference, cyclePreference };
}
