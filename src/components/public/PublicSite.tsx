import React from 'react';
import { useTheme } from '../../hooks/useTheme';
import type { PublicRoute } from '../../services/publicRoutes';
import { PublicNav } from './PublicNav';
import { PublicFooter } from './PublicFooter';
import { LandingPage } from '../../pages/LandingPage';
import { PrivacyPage } from '../../pages/PrivacyPage';
import { ContactPage } from '../../pages/ContactPage';
import { NotFoundPage } from '../../pages/NotFoundPage';

/**
 * The public site never mounts the workspace: no onboarding wizard, dataset registration,
 * DuckDB worker or provider request can start from these routes.
 */
export const PublicSite: React.FC<{ route: Exclude<PublicRoute, 'workspace'> }> = ({ route }) => {
  const { preference, resolved, cyclePreference } = useTheme();

  return (
    <div className="flex min-h-screen flex-col bg-background text-text-primary">
      <a
        href="#main-content"
        className="focus-ring sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50 focus:rounded-lg focus:border focus:border-border-strong focus:bg-surface focus:px-3 focus:py-2 focus:text-sm focus:text-text-primary"
      >
        Skip to content
      </a>
      <PublicNav
        route={route}
        isDarkMode={resolved === 'dark'}
        themePreference={preference}
        onCycleThemePreference={cyclePreference}
      />
      <main id="main-content" tabIndex={-1} className="flex-1">
        {route === 'landing' && <LandingPage />}
        {route === 'privacy' && <PrivacyPage />}
        {route === 'contact' && <ContactPage />}
        {route === 'not-found' && <NotFoundPage />}
      </main>
      <PublicFooter />
    </div>
  );
};
