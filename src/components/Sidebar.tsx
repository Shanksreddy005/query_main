import React, { useState, useEffect, useRef } from 'react';
import { Dataset, HistoryItem } from '../types';
import {
  Table,
  Clock,
  ShieldCheck,
  ChevronRight,
  Hash,
  Type,
  Calendar,
  ToggleLeft,
  X,
  Bookmark,
  BookmarkCheck,
  Download,
  Upload,
  Trash2,
  Copy,
  Check,
  AlertCircle,
  Search,
  Sparkles,
  Play,
  RotateCcw,
} from 'lucide-react';
import { PREBUILT_DATASETS } from '../services/sampleData';
import { QueryMindLogo } from './QueryMindLogo';
import { LocalQueryStorage, UserSavedQuery } from '../services/localQueryStorage';
import { LibraryShareEngine } from '../services/libraryShareEngine';
import { useDialogA11y } from '../hooks/useDialogA11y';

interface SidebarProps {
  dataset: Dataset | null;
  onSelectDataset: (dataset: Dataset) => void;
  onSelectHistoryQuery: (query: string) => void;
  history: HistoryItem[];
  onClearHistory: () => void;
  isDarkMode: boolean;
  isOpenMobile: boolean;
  onCloseMobile: () => void;
  onInsertColumn: (colName: string) => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
  dataset,
  onSelectDataset,
  onSelectHistoryQuery,
  history,
  onClearHistory,
  isDarkMode,
  isOpenMobile,
  onCloseMobile,
  onInsertColumn,
}) => {
  const [storage] = useState(() => new LocalQueryStorage());
  const [shareEngine] = useState(() => new LibraryShareEngine());
  const [savedQueries, setSavedQueries] = useState<UserSavedQuery[]>(() => storage.getSavedQueries());
  const [activeTab, setActiveTab] = useState<'saved' | 'history'>('saved');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [filterActiveTableOnly, setFilterActiveTableOnly] = useState<boolean>(false);
  const [copiedQueryId, setCopiedQueryId] = useState<string | null>(null);
  const [toastStatus, setToastStatus] = useState<{ text: string; tone: 'ok' | 'error' } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const drawerRef = useRef<HTMLElement>(null);
  // One owner for the dismissal timer: separate setTimeout calls per action let an older timer wipe
  // a newer message off the screen, and neither was cancelled when the panel unmounted.
  const toastTimerRef = useRef<number | null>(null);
  const copiedTimerRef = useRef<number | null>(null);

  const showToast = (text: string, tone: 'ok' | 'error' = 'ok', visibleMs = 2800) => {
    if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
    setToastStatus({ text, tone });
    toastTimerRef.current = window.setTimeout(() => {
      toastTimerRef.current = null;
      setToastStatus(null);
    }, visibleMs);
  };

  useEffect(
    () => () => {
      if (toastTimerRef.current !== null) window.clearTimeout(toastTimerRef.current);
      if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current);
    },
    []
  );

  useDialogA11y({ isOpen: isOpenMobile, containerRef: drawerRef, onClose: onCloseMobile });

  // Live listener for updates to LocalQueryStorage
  useEffect(() => {
    const handleStorageUpdate = () => {
      setSavedQueries(storage.getSavedQueries());
    };
    handleStorageUpdate();
    window.addEventListener('querymind_library_updated', handleStorageUpdate);
    return () => window.removeEventListener('querymind_library_updated', handleStorageUpdate);
  }, [storage]);

  const currentFingerprint = dataset
    ? storage.getFingerprint(dataset.columns.map((c) => c.name))
    : '';

  const getColIcon = (type: string) => {
    switch (type) {
      case 'number':
        return <Hash className="w-3 h-3 text-info" />;
      case 'date':
        return <Calendar className="w-3 h-3 text-warning" />;
      case 'boolean':
        return <ToggleLeft className="w-3 h-3 text-accent" />;
      default:
        return (
          <Type className="w-3 h-3 text-text-muted group-hover:text-text-primary transition-colors duration-fast" />
        );
    }
  };

  const handleCopySql = async (e: React.MouseEvent, q: UserSavedQuery) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(q.successfulSql);
      if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current);
      setCopiedQueryId(q.userQuery);
      copiedTimerRef.current = window.setTimeout(() => {
        copiedTimerRef.current = null;
        setCopiedQueryId(null);
      }, 2000);
      showToast('SQL copied to clipboard');
    } catch {
      // writeText rejects when the document lost focus or the permission was denied; promising a
      // clipboard the user never received is a false confirmation.
      showToast('Clipboard blocked by the browser — open the blueprint to copy its SQL.', 'error');
    }
  };

  const handleDeleteSavedQuery = (e: React.MouseEvent, q: UserSavedQuery) => {
    e.stopPropagation();
    storage.deleteSavedQuery(q.userQuery, q.schemaContextFingerprint);
    showToast('Removed from memory');
  };

  const handleExportLibrary = (e: React.MouseEvent) => {
    e.stopPropagation();
    const res = shareEngine.exportLocalLibraryToFile();
    showToast(res.message, res.success ? 'ok' : 'error');
  };

  const handleImportClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    fileInputRef.current?.click();
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    shareEngine.importLibraryFromFile(file, (res) => {
      setSavedQueries(storage.getSavedQueries());
      // Import runs asynchronously against the file, so the result arrives after the click; a
      // rejected file has to read differently from one that added blueprints.
      showToast(res.message, res.success ? 'ok' : 'error', 3600);
    });

    e.target.value = '';
  };

  // Filtered queries based on search & active table toggle
  const matchingThisTableCount = savedQueries.filter(
    (item) => currentFingerprint && item.schemaContextFingerprint === currentFingerprint
  ).length;

  const displayedSavedQueries = savedQueries.filter((item) => {
    if (filterActiveTableOnly && currentFingerprint && item.schemaContextFingerprint !== currentFingerprint) {
      return false;
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      const matchQuery = item.userQuery.toLowerCase().includes(q);
      const matchSql = item.successfulSql.toLowerCase().includes(q);
      const matchDs = item.datasetName?.toLowerCase().includes(q);
      return matchQuery || matchSql || matchDs;
    }
    return true;
  });

  const sidebarContent = (
    <div
      className="flex flex-col h-full overflow-hidden select-none"
      style={{ background: 'var(--surface)' }}
    >
      {/* Hidden File Input for JSON Blueprint Import */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".json"
        className="hidden"
        onChange={handleFileInputChange}
      />

      {/* Mobile Close Button Header */}
      <div
        className="lg:hidden flex items-center justify-between p-4 flex-shrink-0"
        style={{ borderBottom: '1px solid var(--border)' }}
      >
        <a href="#" aria-label="QueryMind home" className="flex items-center gap-2 focus-ring">
          <QueryMindLogo size={22} isDarkMode={isDarkMode} variant="horizontal" />
        </a>
        <button
          onClick={onCloseMobile}
          className="p-1.5 rounded-lg text-text-muted hover:text-text-primary hover:bg-surface-secondary transition-colors duration-fast cursor-pointer focus-ring"
          aria-label="Close navigation drawer"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-3.5 py-4 space-y-5">
        {/* Active Dataset Overview */}
        {dataset && (
          <div>
            <div className="section-label mb-2 flex items-center justify-between">
              <span>Active Table</span>
              <span className="text-meta font-medium tabular-nums" style={{ color: 'var(--success)' }}>
                {dataset.rowCount.toLocaleString()} rows
              </span>
            </div>

            <div
              className="p-3 rounded-xl"
              style={{
                background: isDarkMode
                  ? 'linear-gradient(135deg, rgba(245,158,11,0.08) 0%, rgba(30,27,24,0.6) 100%)'
                  : 'linear-gradient(135deg, rgba(245,158,11,0.07) 0%, rgba(245,243,239,0.8) 100%)',
                border: '1px solid rgba(245,158,11,0.2)',
              }}
            >
              <div className="flex items-center gap-2 font-medium text-xs truncate">
                <Table className="w-3.5 h-3.5 text-accent flex-shrink-0" />
                <span className="font-mono text-xs font-semibold text-text-primary">{dataset.tableName}</span>
              </div>
              <p className="text-meta text-text-muted mt-1 truncate">{dataset.name}</p>
            </div>
          </div>
        )}

        {/* Dynamic Schema Explorer */}
        {dataset && dataset.columns.length > 0 && (
          <div>
            <div className="section-label mb-2 flex items-center justify-between">
              <span>Columns ({dataset.columns.length})</span>
              <span className="text-meta text-text-muted font-medium normal-case">Click to insert</span>
            </div>

            <div className="space-y-0.5">
              {dataset.columns.map((col) => (
                <div
                  key={col.name}
                  role="button"
                  onClick={() => onInsertColumn(col.name)}
                  title={`Type: ${col.type}\nSamples: ${col.sampleValues.slice(0, 3).join(', ')}`}
                  className="group flex items-center justify-between px-2.5 py-1.5 rounded-lg text-xs font-mono cursor-pointer transition-colors duration-fast hover:bg-surface-secondary text-text-secondary hover:text-text-primary focus-ring"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onInsertColumn(col.name);
                    }
                  }}
                >
                  <div className="flex items-center gap-2 truncate">
                    {getColIcon(col.type)}
                    <span className="truncate group-hover:text-text-primary transition-colors duration-fast">{col.name}</span>
                  </div>
                  <span
                    className="text-meta font-mono font-semibold uppercase px-1.5 py-0.5 rounded-md flex-shrink-0"
                    style={{
                      background: 'var(--surface-secondary)',
                      border: '1px solid var(--border)',
                      color: 'var(--text-muted)',
                    }}
                  >
                    {col.type.slice(0, 3)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Preloaded Demo Datasets */}
        <div>
          <div className="section-label mb-2">Demo Datasets</div>
          <div className="space-y-1.5">
            {[
              {
                id: 'customers',
                onClick: () => onSelectDataset(PREBUILT_DATASETS.saas.dataset),
                label: 'SaaS Customer MRR',
                sub: '25 rows · Subscriptions & Churn',
                active: dataset?.id === 'customers',
              },
              {
                id: 'orders',
                onClick: () => onSelectDataset(PREBUILT_DATASETS.ecommerce.dataset),
                label: 'E-Commerce Orders',
                sub: '15 rows · Sales & Profitability',
                active: dataset?.id === 'orders',
              },
            ].map((ds) => (
              <button
                key={ds.id}
                type="button"
                onClick={ds.onClick}
                className="btn-interactive w-full text-left px-3 py-2.5 rounded-xl text-xs font-medium flex items-center justify-between transition-all duration-fast focus-ring cursor-pointer"
                aria-current={ds.active ? 'true' : undefined}
                style={
                  ds.active
                    ? {
                        background: 'var(--badge-accent-bg)',
                        border: '1px solid var(--badge-accent-border)',
                        color: 'var(--badge-accent-fg)',
                      }
                    : {
                        background: 'var(--surface-secondary)',
                        border: '1px solid var(--border)',
                        color: 'var(--text-secondary)',
                      }
                }
              >
                <div className="truncate">
                  <span className="block font-semibold">{ds.label}</span>
                  <span className="text-meta font-normal">{ds.sub}</span>
                </div>
                <ChevronRight className="w-3.5 h-3.5 opacity-40 flex-shrink-0" />
              </button>
            ))}
          </div>
        </div>

        {/* Query Memory & History Section */}
        <div>
          {/* Segmented Tab Switcher */}
          <div role="group" aria-label="Query memory view" className="flex items-center gap-1 p-0.5 rounded-lg bg-surface-secondary border border-border-subtle mb-3">
            <button
              type="button"
              onClick={() => setActiveTab('saved')}
              aria-pressed={activeTab === 'saved'}
              className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 px-2 rounded-md text-xs font-medium transition-all duration-fast cursor-pointer focus-ring ${
                activeTab === 'saved'
                  ? 'bg-surface text-accent font-semibold shadow-2xs'
                  : 'text-text-muted hover:text-text-primary'
              }`}
            >
              <Bookmark className="w-3 h-3 text-accent" />
              <span>Saved Memory</span>
              <span className="text-meta font-mono px-1.5 py-0.2 rounded-full bg-accent/15 text-accent">
                {savedQueries.length}
              </span>
            </button>

            <button
              type="button"
              onClick={() => setActiveTab('history')}
              aria-pressed={activeTab === 'history'}
              className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 px-2 rounded-md text-xs font-medium transition-all duration-fast cursor-pointer focus-ring ${
                activeTab === 'history'
                  ? 'bg-surface text-text-primary font-semibold shadow-2xs'
                  : 'text-text-muted hover:text-text-primary'
              }`}
            >
              <Clock className="w-3 h-3" />
              <span>History</span>
              <span className="text-meta font-mono px-1.5 py-0.2 rounded-full bg-surface-secondary text-text-muted">
                {history.length}
              </span>
            </button>
          </div>

          {/* Feedback banner if copying/deleting/exporting */}
          {/* The live region stays mounted so a message that appears is announced; only the box moves. */}
          <div role="status" aria-live="polite">
            {toastStatus && (
              <div
                className={`mb-2.5 px-2.5 py-1.5 rounded-lg text-meta font-medium border flex items-start gap-1.5 animate-in fade-in ${
                  toastStatus.tone === 'error'
                    ? 'bg-badge-error-bg text-badge-error-fg border-badge-error-border'
                    : 'bg-badge-accent-bg text-badge-accent-fg border-badge-accent-border'
                }`}
              >
                {toastStatus.tone === 'error' ? (
                  <AlertCircle className="w-3 h-3 mt-0.5 flex-shrink-0" aria-hidden="true" />
                ) : (
                  <Check className="w-3 h-3 mt-0.5 text-accent flex-shrink-0" aria-hidden="true" />
                )}
                <span>{toastStatus.text}</span>
              </div>
            )}
          </div>

          {/* Tab 1: Sandboxed Memory (Saved Queries) */}
          {activeTab === 'saved' && (
            <div className="space-y-2">
              {/* Toolbar: Search & Export/Import */}
              <div className="flex items-center gap-1.5">
                <div className="relative flex-1">
                  <Search className="w-3 h-3 absolute left-2 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none" />
                  <input
                    type="text"
                    placeholder="Search blueprints..."
                    aria-label="Search saved queries"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="w-full text-xs pl-6 pr-2 py-1 rounded-md border border-field-border bg-surface text-text-primary placeholder:text-text-muted focus:border-accent focus-ring"
                  />
                </div>

                <button
                  type="button"
                  onClick={handleExportLibrary}
                  title="Export saved queries as JSON"
                  aria-label="Export saved queries as JSON"
                  className="btn-interactive p-1.5 rounded-md border border-border-subtle bg-surface hover:bg-surface-elevated text-text-secondary hover:text-accent cursor-pointer transition-colors focus-ring"
                >
                  <Download className="w-3.5 h-3.5" />
                </button>

                <button
                  type="button"
                  onClick={handleImportClick}
                  title="Import queries from JSON"
                  aria-label="Import queries from JSON"
                  className="btn-interactive p-1.5 rounded-md border border-border-subtle bg-surface hover:bg-surface-elevated text-text-secondary hover:text-accent cursor-pointer transition-colors focus-ring"
                >
                  <Upload className="w-3.5 h-3.5" />
                </button>
              </div>

              {/* Table Scope Filter Pill */}
              {currentFingerprint && matchingThisTableCount > 0 && (
                <div className="flex items-center justify-between text-meta px-1 pt-0.5">
                  <span className="text-text-muted">Scope filter:</span>
                  <button
                    type="button"
                    onClick={() => setFilterActiveTableOnly(!filterActiveTableOnly)}
                    aria-pressed={filterActiveTableOnly}
                    className={`px-2 py-0.5 rounded-full border text-meta font-medium transition-colors cursor-pointer focus-ring ${
                      filterActiveTableOnly
                        ? 'bg-badge-success-bg text-badge-success-fg border-badge-success-border font-semibold'
                        : 'bg-surface border-border-subtle text-text-muted hover:text-text-primary'
                    }`}
                  >
                    {filterActiveTableOnly
                      ? `Active Table Only (${matchingThisTableCount})`
                      : `All Tables (${savedQueries.length})`}
                  </button>
                </div>
              )}

              {/* Saved Queries List */}
              {displayedSavedQueries.length === 0 ? (
                <div className="p-4 rounded-xl border border-dashed border-border-subtle text-center text-meta text-text-muted space-y-1.5 my-2">
                  <Bookmark className="w-5 h-5 mx-auto opacity-40 text-accent" />
                  <p className="font-medium text-text-secondary">No saved blueprints found</p>
                  <p className="text-meta text-text-muted leading-relaxed">
                    {searchQuery
                      ? 'No queries match your search query.'
                      : 'Run any query and click "Save to Memory" to bookmark reusable SQL blueprints.'}
                  </p>
                  <button
                    type="button"
                    onClick={handleImportClick}
                    className="inline-flex items-center gap-1 mt-1 text-xs font-semibold text-accent hover:underline cursor-pointer rounded focus-ring"
                  >
                    <Upload className="w-3 h-3" />
                    <span>Import JSON Blueprints</span>
                  </button>
                </div>
              ) : (
                <div className="space-y-1.5 max-h-[340px] overflow-y-auto pr-0.5">
                  {displayedSavedQueries.map((item, idx) => {
                    const isCurrentTable =
                      currentFingerprint && item.schemaContextFingerprint === currentFingerprint;
                    const isCopied = copiedQueryId === item.userQuery;

                    return (
                      <div
                        key={item.id || `${item.userQuery}_${idx}`}
                        onClick={() => onSelectHistoryQuery(item.userQuery)}
                        className="group relative p-2.5 rounded-xl border border-border-subtle bg-surface hover:bg-surface-secondary/70 hover:border-accent/40 transition-all duration-fast cursor-pointer block"
                        title={item.userQuery}
                      >
                        <div className="flex items-start justify-between gap-1.5 mb-1">
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              onSelectHistoryQuery(item.userQuery);
                            }}
                            title={item.userQuery}
                            className="text-left p-0 m-0 bg-transparent border-0 cursor-pointer flex-1 min-w-0 focus-ring"
                          >
                            <span className="text-xs font-semibold text-text-primary group-hover:text-accent transition-colors line-clamp-2 leading-tight">
                              {item.userQuery}
                            </span>
                          </button>
                        </div>

                        {/* Metadata Tags & Row */}
                        <div className="flex items-center gap-1.5 flex-wrap text-meta">
                          {isCurrentTable ? (
                            <span className="px-1.5 py-0.2 rounded-md bg-badge-success-bg text-badge-success-fg border border-badge-success-border font-medium">
                              Active Table
                            </span>
                          ) : (
                            <span className="px-1.5 py-0.2 rounded-md bg-surface-secondary text-text-muted border border-border-subtle">
                              {item.datasetName || 'Other Schema'}
                            </span>
                          )}

                          {item.rowCount !== undefined && (
                            <span className="font-mono text-text-muted">
                              {item.rowCount} rows
                            </span>
                          )}
                        </div>

                        {/* Revealed on hover and on card focus. Not display:none: an
                            unrendered element cannot take focus, so focus-within could never reveal it. */}
                        <div className="absolute right-2 top-2 flex items-center gap-1 bg-surface-elevated/95 p-1 rounded-lg border border-border-strong shadow-xs opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto group-focus-within:opacity-100 group-focus-within:pointer-events-auto pointer-coarse:opacity-100 pointer-coarse:pointer-events-auto">
                          <button
                            type="button"
                            onClick={(e) => handleCopySql(e, item)}
                            className="p-1.5 rounded text-text-muted hover:text-text-primary hover:bg-surface-secondary transition-colors focus-ring"
                            title="Copy SQL"
                            aria-label="Copy SQL"
                          >
                            {isCopied ? <Check className="w-3 h-3 text-success" /> : <Copy className="w-3 h-3" />}
                          </button>
                          <button
                            type="button"
                            onClick={(e) => handleDeleteSavedQuery(e, item)}
                            className="p-1.5 rounded text-text-muted hover:text-error hover:bg-badge-error-bg transition-colors focus-ring"
                            title="Remove from memory"
                            aria-label="Remove from memory"
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* Tab 2: Recent Session History */}
          {activeTab === 'history' && (
            <div>
              <div className="flex items-center justify-between mb-2 px-1">
                <span className="text-meta text-text-muted font-medium">Session History</span>
                {history.length > 0 && (
                  <button
                    type="button"
                    onClick={onClearHistory}
                    className="text-meta text-text-muted hover:text-error transition-colors duration-fast focus-ring cursor-pointer"
                    title="Clear session history"
                  >
                    Clear History
                  </button>
                )}
              </div>

              {history.length === 0 ? (
                <p className="text-meta text-text-muted italic px-1 py-3 text-center">
                  No queries run in this session.
                </p>
              ) : (
                <div className="space-y-1">
                  {history.slice(0, 10).map((item) => (
                    <button
                      key={item.id}
                      onClick={() => onSelectHistoryQuery(item.question)}
                      className="btn-interactive w-full text-left px-2.5 py-1.5 rounded-lg text-xs transition-colors duration-fast truncate block hover:bg-surface-secondary text-text-secondary hover:text-text-primary focus-ring cursor-pointer"
                      title={item.question}
                    >
                      <span className="truncate block font-medium">{item.question}</span>
                      <span className="text-meta text-text-muted font-mono">
                        {item.rowCount} rows · {item.timestamp}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Footer */}
      <div
        className="p-3.5 text-xs flex-shrink-0"
        style={{
          borderTop: '1px solid var(--border)',
          background: isDarkMode ? 'rgba(30,27,24,0.7)' : 'rgba(237,233,226,0.6)',
        }}
      >
        <div className="flex items-center gap-2 font-medium mb-1" style={{ color: 'var(--success)' }}>
          <ShieldCheck className="w-3.5 h-3.5 flex-shrink-0" />
          <span className="font-semibold text-meta">Local Engine Active</span>
        </div>
        <p className="text-meta text-text-muted leading-relaxed">
          No app-operated telemetry · runs in this tab
        </p>
      </div>
    </div>
  );

  return (
    <>
      {/* Desktop Static Sidebar */}
      <aside
        className="hidden lg:flex w-64 flex-col flex-shrink-0 transition-colors duration-fast"
        style={{ borderRight: '1px solid var(--border)', background: 'var(--surface)' }}
      >
        {sidebarContent}
      </aside>

      {/* Mobile Drawer */}
      {isOpenMobile && (
        <div className="lg:hidden fixed inset-0 z-50 flex">
          <div
            className="fixed inset-0 bg-scrim backdrop-blur-sm animate-in fade-in duration-standard"
            aria-hidden="true"
            onClick={onCloseMobile}
          />
          <aside
            ref={drawerRef}
            id="mobile-navigation-drawer"
            role="dialog"
            aria-modal="true"
            aria-label="Datasets, schema and query memory"
            tabIndex={-1}
            className="relative w-80 max-w-[85vw] h-full shadow-2xl flex flex-col z-10 transition-colors duration-fast"
            style={{ background: 'var(--surface)', borderRight: '1px solid var(--border)' }}
          >
            {sidebarContent}
          </aside>
        </div>
      )}
    </>
  );
};
