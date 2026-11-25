import React from 'react';
import { ArrowRight, Monitor, Moon, Sun } from 'lucide-react';
import { QueryMindLogo } from '../QueryMindLogo';
import { NEXT_THEME_PREFERENCE, type ThemePreference } from '../../services/theme';
import type { PublicRoute } from '../../services/publicRoutes';

const THEME_PREFERENCE_TEXT: Record<ThemePreference, string> = {
  light: 'Light',
  dark: 'Dark',
  system: 'System default',
};

interface PublicNavProps {
  route: PublicRoute;
  isDarkMode: boolean;
  themePreference: ThemePreference;
  onCycleThemePreference: () => void;
}

const sectionLink =
  'rounded-lg px-2.5 py-1.5 text-xs font-medium text-text-secondary transition-colors duration-fast hover:bg-surface-secondary hover:text-text-primary focus-ring';
const mobileSectionLink =
  'inline-flex min-h-6 items-center rounded text-xs font-medium text-text-secondary transition-colors duration-fast hover:text-text-primary focus-ring';

export const PublicNav: React.FC<PublicNavProps> = ({
  route,
  isDarkMode,
  themePreference,
  onCycleThemePreference,
}) => {
  const themeLabel = `Theme: ${THEME_PREFERENCE_TEXT[themePreference]} (showing ${
    isDarkMode ? 'dark' : 'light'
  }). Activate to switch to ${THEME_PREFERENCE_TEXT[NEXT_THEME_PREFERENCE[themePreference]]}.`;
  const onLanding = route === 'landing';
  const sectionHref = (id: string) => (onLanding ? `#${id}` : `/#${id}`);

  return (
    <header className="border-b border-border-subtle bg-background">
      <div className="mx-auto w-full max-w-6xl px-4 sm:px-6">
        <div className="flex h-14 items-center justify-between gap-3">
          <a
            href="/"
            aria-label="QueryMind home"
            className="focus-ring flex min-w-0 items-center gap-2 rounded-lg py-1"
          >
            <QueryMindLogo
              size={26}
              isDarkMode={isDarkMode}
              variant="horizontal"
              wordmarkClassName="hidden sm:inline-block"
            />
          </a>

          <nav aria-label="Primary" className="hidden items-center gap-1 md:flex">
            <a href={sectionHref('product')} className={sectionLink}>
              Product
            </a>
            <a href={sectionHref('how-it-works')} className={sectionLink}>
              How it works
            </a>
            <a
              href="/privacy"
              className={sectionLink}
              aria-current={route === 'privacy' ? 'page' : undefined}
            >
              Privacy
            </a>
            <a
              href="/contact"
              className={sectionLink}
              aria-current={route === 'contact' ? 'page' : undefined}
            >
              Contact
            </a>
          </nav>

          <div className="flex flex-shrink-0 items-center gap-1.5 sm:gap-2">
            <button
              type="button"
              onClick={onCycleThemePreference}
              className="btn-interactive rounded-lg border border-border-subtle p-1.5 text-text-muted transition-colors duration-fast hover:text-text-primary focus-ring"
              aria-label={themeLabel}
              title={themeLabel}
            >
              {themePreference === 'system' ? (
                <Monitor className="h-4 w-4" />
              ) : isDarkMode ? (
                <Sun className="h-4 w-4 text-warning" />
              ) : (
                <Moon className="h-4 w-4" />
              )}
            </button>
            <span role="status" className="sr-only">
              {`Theme ${THEME_PREFERENCE_TEXT[themePreference]}, showing ${isDarkMode ? 'dark' : 'light'}.`}
            </span>

            <a
              href="/app"
              className="btn-accent-gradient focus-ring inline-flex items-center gap-1.5 px-3 py-1.5 text-xs"
            >
              Open workspace
              <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
            </a>
          </div>
        </div>

        <nav aria-label="Primary (compact)" className="flex flex-wrap gap-x-4 gap-y-1 pb-2.5 md:hidden">
          <a href={sectionHref('product')} className={mobileSectionLink}>
            Product
          </a>
          <a href={sectionHref('how-it-works')} className={mobileSectionLink}>
            How it works
          </a>
          <a
            href="/privacy"
            className={mobileSectionLink}
            aria-current={route === 'privacy' ? 'page' : undefined}
          >
            Privacy
          </a>
          <a
            href="/contact"
            className={mobileSectionLink}
            aria-current={route === 'contact' ? 'page' : undefined}
          >
            Contact
          </a>
        </nav>
      </div>
    </header>
  );
};
