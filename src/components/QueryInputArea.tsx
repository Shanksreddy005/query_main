import React, { useRef, useEffect } from 'react';
import { QueryMindLogo } from './QueryMindLogo';
import { Play, Sparkles, Loader2, Square, AlertCircle, Circle, Check } from 'lucide-react';
import { Dataset, ReasoningStep } from '../types';
import { PREBUILT_DATASETS } from '../services/sampleData';

interface QueryInputAreaProps {
  query: string;
  onChangeQuery: (newQuery: string) => void;
  onRunQuery: (queryToRun?: string) => void;
  onCancelQuery: () => void;
  isRunning: boolean;
  activeStep?: ReasoningStep | null;
  dataset: Dataset | null;
  hasRunAnyQuery: boolean;
  isDarkMode: boolean;
}

export const QueryInputArea: React.FC<QueryInputAreaProps> = ({
  query,
  onChangeQuery,
  onRunQuery,
  onCancelQuery,
  isRunning,
  activeStep,
  dataset,
  hasRunAnyQuery,
  isDarkMode,
}) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);

  // Auto-resize textarea height
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 140)}px`;
    }
  }, [query]);

  // Global shortcut to focus query textarea (Cmd/Ctrl+K or /)
  useEffect(() => {
    const handleGlobalKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        textareaRef.current?.focus();
        textareaRef.current?.select();
      } else if (
        e.key === '/' &&
        document.activeElement?.tagName !== 'INPUT' &&
        document.activeElement?.tagName !== 'TEXTAREA' &&
        !document.activeElement?.getAttribute('contenteditable')
      ) {
        e.preventDefault();
        textareaRef.current?.focus();
      }
    };
    window.addEventListener('keydown', handleGlobalKey);
    return () => window.removeEventListener('keydown', handleGlobalKey);
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (!isRunning && query.trim() && dataset) {
        onRunQuery();
      }
    }
  };

  // Determine suggestions based on dataset
  let suggestions: string[] = [];
  if (dataset?.id === 'customers') {
    suggestions = PREBUILT_DATASETS.saas.promptSuggestions;
  } else if (dataset?.id === 'orders') {
    suggestions = PREBUILT_DATASETS.ecommerce.promptSuggestions;
  } else if (dataset && dataset.columns.length > 0) {
    const numCol = dataset.columns.find((c) => c.type === 'number')?.name || 'value';
    const catCol = dataset.columns.find((c) => c.type === 'string')?.name || 'category';
    suggestions = [
      `Show top 5 records ordered by ${numCol} descending`,
      `What is the average ${numCol} grouped by ${catCol}?`,
      `Count the total number of records by ${catCol}`,
    ];
  }

  const canRun = !isRunning && Boolean(query.trim()) && Boolean(dataset);

  return (
    <div className="w-full space-y-4">
      {/* Hero Welcome state */}
      {!hasRunAnyQuery && (
        <div className="flex flex-col items-center justify-center py-8 sm:py-10 text-center animate-in fade-in duration-300">
          <QueryMindLogo size={44} variant="stacked" isDarkMode={isDarkMode} />
          <h2 className="text-display font-semibold mt-5 text-text-primary">
            Talk to your data. Get answers.
          </h2>
          <p className="text-prose text-text-muted mt-2 max-w-sm">
            Ask questions in plain English — QueryMind plans, validates, and executes SQL locally in your browser.
          </p>
        </div>
      )}

      {/* Main Query Input Card */}
      <div
        className="rounded-2xl overflow-hidden transition-all duration-fast"
        style={{
          border: '1px solid var(--border)',
          background: 'var(--surface)',
          boxShadow: isDarkMode
            ? '0 1px 2px rgba(0,0,0,0.4), 0 0 0 1px rgba(245,158,11,0)'
            : '0 1px 3px rgba(0,0,0,0.08)',
          outline: 'none',
        }}
        onFocusCapture={(e) => {
          (e.currentTarget as HTMLDivElement).style.borderColor = 'var(--accent)';
          (e.currentTarget as HTMLDivElement).style.boxShadow = isDarkMode
            ? '0 1px 2px rgba(0,0,0,0.4), 0 0 0 3px rgba(245,158,11,0.15)'
            : '0 1px 3px rgba(0,0,0,0.08), 0 0 0 3px rgba(217,119,6,0.12)';
        }}
        onBlurCapture={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) {
            (e.currentTarget as HTMLDivElement).style.borderColor = 'var(--border)';
            (e.currentTarget as HTMLDivElement).style.boxShadow = isDarkMode
              ? '0 1px 2px rgba(0,0,0,0.4)'
              : '0 1px 3px rgba(0,0,0,0.08)';
          }
        }}
      >
        {/* Textarea */}
        <div className="p-3.5 sm:p-4" style={{ background: 'var(--surface)' }}>
          <label htmlFor="query-input" className="sr-only">
            Ask a question about your data
          </label>
          <textarea
            ref={textareaRef}
            id="query-input"
            rows={2}
            value={query}
            onChange={(e) => onChangeQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={`Ask a question about ${dataset?.name || 'your dataset'} in plain English…`}
            disabled={isRunning || !dataset}
            aria-keyshortcuts={isMac ? 'Meta+Enter' : 'Control+Enter'}
            className="w-full bg-transparent focus-ring resize-none text-sm sm:text-base leading-relaxed font-sans text-text-primary placeholder:text-text-muted disabled:cursor-not-allowed"
            style={{ color: 'var(--text-primary)', caretColor: 'var(--accent)' }}
          />
        </div>

        {/* Live Step Progress Display */}
        {isRunning && activeStep && (
          <div
            role="status"
            className="px-4 py-2 flex items-center gap-2 text-xs font-medium"
            style={{
              borderTop: '1px solid var(--border)',
              background: 'var(--badge-accent-bg)',
              color: 'var(--badge-accent-fg)',
            }}
          >
            {activeStep.status === 'running' && (
              <Loader2 className="w-3.5 h-3.5 animate-spin flex-shrink-0" style={{ color: 'var(--accent)' }} />
            )}
            {activeStep.status === 'waiting' && <Circle className="w-3 h-3 flex-shrink-0 opacity-55" />}
            {activeStep.status === 'done' && <Check className="w-3.5 h-3.5 flex-shrink-0" />}
            {activeStep.status === 'error' && <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 text-error" />}
            <span className="font-semibold flex-shrink-0">{activeStep.title}:</span>
            <span className="truncate">{activeStep.detail}</span>
          </div>
        )}

        {/* Card Footer */}
        <div
          className="px-3.5 sm:px-4 py-2.5 flex items-center justify-between gap-3 text-xs"
          style={{
            borderTop: '1px solid var(--border)',
            background: isDarkMode ? 'rgba(30,27,24,0.5)' : 'rgba(237,233,226,0.5)',
          }}
        >
          <div className="flex items-center gap-3 text-text-muted font-medium select-none flex-wrap">
            <div className="flex items-center gap-1.5">
              <span className="hidden sm:inline">Press</span>
              <kbd
                className="px-1.5 py-0.5 rounded text-meta font-mono font-semibold"
                style={{ background: 'var(--surface)', border: '1px solid var(--border-strong)', color: 'var(--text-secondary)' }}
              >
                {isMac ? '⌘ Enter' : 'Ctrl Enter'}
              </kbd>
              <span className="hidden sm:inline text-text-muted">to run</span>
            </div>

            <span className="hidden md:inline text-border-strong opacity-40">|</span>

            <div className="hidden md:flex items-center gap-1 text-meta text-text-muted">
              <span>Focus with</span>
              <kbd
                className="px-1 py-0.5 rounded text-meta font-mono font-semibold"
                style={{ background: 'var(--surface)', border: '1px solid var(--border-strong)', color: 'var(--text-secondary)' }}
              >
                {isMac ? '⌘K' : 'Ctrl K'}
              </kbd>
              <span>or</span>
              <kbd
                className="px-1 py-0.5 rounded text-meta font-mono font-semibold"
                style={{ background: 'var(--surface)', border: '1px solid var(--border-strong)', color: 'var(--text-secondary)' }}
              >
                /
              </kbd>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {query.trim() && (
              <button
                type="button"
                onClick={() => onChangeQuery('')}
                disabled={isRunning}
                className="btn-interactive text-xs text-text-muted hover:text-text-primary px-2 py-1 rounded transition-colors duration-fast focus-ring"
                aria-label="Clear question"
              >
                Clear
              </button>
            )}

            {isRunning ? (
              <button
                type="button"
                onClick={onCancelQuery}
                className="flex items-center gap-2 px-4 py-1.5 text-xs sm:text-sm font-semibold focus-ring rounded-lg transition-colors duration-fast"
                style={{
                  background: 'var(--surface-secondary)',
                  border: '1px solid var(--border-strong)',
                  color: 'var(--text-primary)',
                }}
                aria-label="Stop query"
              >
                <Square className="w-3 h-3 fill-current" />
                <span>Stop</span>
              </button>
            ) : (
              <button
                type="button"
                onClick={() => onRunQuery()}
                disabled={!canRun}
                className={`btn-accent-gradient flex items-center gap-2 px-4 py-1.5 text-xs sm:text-sm font-semibold focus-ring ${
                  !canRun ? 'cursor-not-allowed' : ''
                }`}
                style={
                  !canRun
                    ? {
                        background: 'var(--surface-secondary)',
                        border: '1px solid var(--border)',
                        color: 'var(--text-muted)',
                        boxShadow: 'none',
                        transform: 'none',
                      }
                    : {}
                }
              >
                <Play className="w-3.5 h-3.5 fill-current" />
                <span>Run Query</span>
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Suggested Query Chips */}
      {suggestions.length > 0 && (
        <div role="group" aria-label="Suggested questions" className="flex flex-wrap items-center gap-2 pt-0.5">
          <span className="text-meta font-semibold text-text-muted flex items-center gap-1.5 select-none">
            <Sparkles className="w-3 h-3 text-accent" />
            Try:
          </span>
          {suggestions.map((s, idx) => (
            <button
              key={idx}
              type="button"
              onClick={() => {
                onChangeQuery(s);
                onRunQuery(s);
              }}
              disabled={isRunning}
              className="btn-interactive text-xs px-2.5 py-1.5 rounded-lg text-left font-medium transition-colors duration-fast focus-ring border border-border-subtle bg-surface text-text-secondary hover:border-accent hover:text-accent-text hover:bg-badge-accent-bg disabled:opacity-60 disabled:hover:border-border-subtle disabled:hover:text-text-secondary disabled:hover:bg-surface"
            >
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
