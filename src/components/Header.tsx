import React from 'react';
import { QueryMindLogo } from './QueryMindLogo';
import { Dataset, ApiKeyConfig } from '../types';
import { Key, Sun, Moon, Monitor, Menu, Upload, ShieldCheck, Presentation } from 'lucide-react';
import { NEXT_THEME_PREFERENCE, type ThemePreference } from '../services/theme';

const THEME_PREFERENCE_TEXT: Record<ThemePreference, string> = {
  light: 'Light',
  dark: 'Dark',
  system: 'System default',
};

interface HeaderProps {
  activeDataset: Dataset | null;
  onOpenKeyModal: () => void;
  onOpenUploader: () => void;
  onOpenAuditor?: () => void;
  onToggleMobileSidebar: () => void;
  isMobileSidebarOpen?: boolean;
  apiKeyConfig: ApiKeyConfig;
  isDarkMode: boolean;
  themePreference: ThemePreference;
  onCycleThemePreference: () => void;
  isPresentationMode?: boolean;
  onTogglePresentationMode?: () => void;
}

export const Header: React.FC<HeaderProps> = ({
  activeDataset,
  onOpenKeyModal,
  onOpenUploader,
  onOpenAuditor,
  onToggleMobileSidebar,
  isMobileSidebarOpen = false,
  apiKeyConfig,
  isDarkMode,
  themePreference,
  onCycleThemePreference,
  isPresentationMode = false,
  onTogglePresentationMode,
}) => {
  const hasKey = Boolean(apiKeyConfig.key && apiKeyConfig.key.trim().length > 0);
  const themeLabel = `Theme: ${THEME_PREFERENCE_TEXT[themePreference]} (showing ${
    isDarkMode ? 'dark' : 'light'
  }). Activate to switch to ${THEME_PREFERENCE_TEXT[NEXT_THEME_PREFERENCE[themePreference]]}.`;

  return (
    <header
      className="h-14 px-4 sm:px-6 flex items-center justify-between flex-shrink-0 select-none transition-colors"
      style={{
        borderBottom: '1px solid var(--border)',
        background: isDarkMode
          ? 'linear-gradient(to right, rgba(22,20,18,0.98), rgba(30,27,24,0.95))'
          : 'linear-gradient(to right, rgba(253,252,251,0.98), rgba(245,243,239,0.95))',
        backdropFilter: 'blur(8px)',
        WebkitBackdropFilter: 'blur(8px)',
      }}
    >
      {/* Left: Mobile hamburger + Brand Logo + Active Dataset Status */}
      <div className="flex items-center gap-3 sm:gap-4 min-w-0">
        <button
          type="button"
          onClick={onToggleMobileSidebar}
          className="lg:hidden p-2 rounded-lg text-text-muted hover:text-text-primary hover:bg-surface-secondary transition-colors duration-fast focus-ring flex-shrink-0"
          aria-label="Navigation drawer"
          aria-expanded={isMobileSidebarOpen}
          aria-controls="mobile-navigation-drawer"
        >
          <Menu className="w-4 h-4" />
        </button>

        <a href="/" aria-label="QueryMind home" title="QueryMind landing page" className="flex items-center gap-2 group focus-ring rounded-lg py-1 px-1.5 -ml-1.5 transition-colors duration-fast min-w-0">
          <QueryMindLogo
            size={26}
            isDarkMode={isDarkMode}
            variant="horizontal"
            wordmarkClassName="hidden sm:inline-block"
          />
        </a>

        {activeDataset && (
          <>
            <span className="hidden sm:inline-block w-px h-4 bg-border-strong opacity-60 flex-shrink-0" />
            <div
              className="hidden sm:flex items-center gap-2 px-2.5 py-1 rounded-full text-xs font-medium min-w-0"
              style={{
                background: 'var(--badge-success-bg)',
                border: '1px solid var(--badge-success-border)',
                color: 'var(--badge-success-fg)',
              }}
            >
              <span className="w-1.5 h-1.5 rounded-full bg-success animate-pulse flex-shrink-0" />
              <span className="font-mono text-meta truncate max-w-[110px] lg:max-w-[160px]">{activeDataset.name}</span>
              <span className="hidden lg:inline text-meta tabular-nums opacity-80">({activeDataset.rowCount.toLocaleString()} rows)</span>
            </div>
          </>
        )}
      </div>

      {/* Right: Controls */}
      <div className="flex items-center gap-1.5 sm:gap-2 min-w-0 flex-shrink-0">
        {/* Privacy Badge */}
        <button
          type="button"
          onClick={onOpenAuditor}
          title="Rows stay in this browser · no app telemetry. Click to inspect outbound network requests."
          aria-label="Telemetry auditor: inspect the outbound network requests this session made"
          className="hidden md:flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-meta font-semibold cursor-pointer transition-all duration-fast focus-ring"
          style={{
            background: 'var(--badge-success-bg)',
            border: '1px solid var(--badge-success-border)',
            color: 'var(--badge-success-fg)',
          }}
        >
          <ShieldCheck className="w-3.5 h-3.5" />
          <span className="hidden lg:inline">DATA LOCAL</span>
        </button>

        {/* Upload Button */}
        <button
          type="button"
          onClick={onOpenUploader}
          className="btn-interactive flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium text-text-secondary hover:text-text-primary transition-colors duration-fast focus-ring"
          aria-label="Upload dataset"
          style={{ border: '1px solid var(--border-strong)', background: 'var(--surface-secondary)' }}
        >
          <Upload className="w-3.5 h-3.5" />
          <span className="hidden sm:inline">Upload</span>
        </button>

        {/* Presentation View Toggle */}
        {onTogglePresentationMode && (
          <button
            type="button"
            onClick={onTogglePresentationMode}
            className={`btn-interactive flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-all duration-fast focus-ring cursor-pointer ${
              isPresentationMode
                ? 'bg-accent/15 border border-accent/40 text-accent font-semibold shadow-2xs'
                : 'border border-border-strong bg-surface-secondary text-text-secondary hover:text-text-primary hover:border-accent'
            }`}
            aria-label={isPresentationMode ? 'Exit Executive View' : 'Presentation view'}
            aria-pressed={isPresentationMode}
            title={
              isPresentationMode
                ? 'Exit Presentation Mode (Show SQL code & traces)'
                : 'Enable Presentation Mode (Hide SQL & technical traces for executive review)'
            }
          >
            <Presentation className="w-3.5 h-3.5 text-accent" />
            <span className="hidden sm:inline">
              {isPresentationMode ? 'Executive View' : 'Present'}
            </span>
          </button>
        )}

        {/* BYOK Key */}
        <button
          type="button"
          onClick={onOpenKeyModal}
          title="Direct client-side AI provider connection."
          aria-label={
            hasKey
              ? `AI provider connection: ${apiKeyConfig.provider}. Click to manage the API key.`
              : 'No AI provider API key configured. Click to configure it.'
          }
          className="btn-interactive flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors duration-fast focus-ring"
          style={
            hasKey
              ? {
                  background: 'var(--badge-accent-bg)',
                  border: '1px solid var(--badge-accent-border)',
                  color: 'var(--badge-accent-fg)',
                }
              : {
                  border: '1px solid var(--border-strong)',
                  background: 'var(--surface-secondary)',
                  color: 'var(--text-secondary)',
                }
          }
        >
          <Key className={`w-3.5 h-3.5 ${hasKey ? 'text-warning' : 'text-text-muted'}`} />
          <span className="font-mono text-meta hidden sm:inline">
            {hasKey ? `${apiKeyConfig.provider.toUpperCase()}` : 'BYOK'}
          </span>
        </button>

        {/* Theme Preference */}
        <button
          type="button"
          onClick={onCycleThemePreference}
          className="btn-interactive p-1.5 rounded-lg text-text-muted hover:text-text-primary transition-colors duration-fast focus-ring"
          style={{ border: '1px solid var(--border)' }}
          aria-label={themeLabel}
          title={themeLabel}
        >
          {themePreference === 'system' ? (
            <Monitor className="w-4 h-4" />
          ) : isDarkMode ? (
            <Sun className="w-4 h-4 text-warning" />
          ) : (
            <Moon className="w-4 h-4" />
          )}
        </button>
        <span role="status" className="sr-only">
          {`Theme ${THEME_PREFERENCE_TEXT[themePreference]}, showing ${isDarkMode ? 'dark' : 'light'}.`}
        </span>
      </div>
    </header>
  );
};
