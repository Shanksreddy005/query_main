import React from 'react';
import { ArrowRight, Moon, Sun } from 'lucide-react';
import { QueryMindLogo } from '../QueryMindLogo';
import type { ResolvedTheme } from '../../services/theme';
import type { PublicRoute } from '../../services/publicRoutes';

interface PublicNavProps {
  route: PublicRoute;
  isDarkMode: boolean;
  onSelectTheme: (theme: ResolvedTheme) => void;
}

const sectionLink =
  'rounded-lg px-2.5 py-1.5 text-xs font-medium text-text-secondary transition-colors duration-fast hover:bg-surface-secondary hover:text-text-primary focus-ring';
const mobileSectionLink =
  'inline-flex min-h-6 items-center rounded text-xs font-medium text-text-secondary transition-colors duration-fast hover:text-text-primary focus-ring';
const themeButton =
  'btn-interactive inline-flex h-7 w-7 items-center justify-center rounded-lg border transition-colors duration-fast focus-ring';
const themeButtonActive = 'border-border-strong bg-surface-secondary text-text-primary';
const themeButtonIdle =
  'border-border-subtle text-text-muted hover:border-border-strong hover:text-text-primary';

export const PublicNav: React.FC<PublicNavProps> = ({ route, isDarkMode, onSelectTheme }) => {
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
            <div role="group" aria-label="Theme" className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => onSelectTheme('light')}
                aria-pressed={!isDarkMode}
                aria-label="Light theme"
                title="Light theme"
                className={`${themeButton} ${isDarkMode ? themeButtonIdle : themeButtonActive}`}
              >
                <Sun className={`h-4 w-4 ${isDarkMode ? '' : 'text-warning'}`} />
              </button>
              <button
                type="button"
                onClick={() => onSelectTheme('dark')}
                aria-pressed={isDarkMode}
                aria-label="Dark theme"
                title="Dark theme"
                className={`${themeButton} ${isDarkMode ? themeButtonActive : themeButtonIdle}`}
              >
                <Moon className={`h-4 w-4 ${isDarkMode ? 'text-accent' : ''}`} />
              </button>
            </div>

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
