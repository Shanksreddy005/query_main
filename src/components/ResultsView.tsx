import React, { useState, useRef, useEffect } from 'react';
import { QueryResult } from '../types';
import { DataChart } from './DataChart';
import { ExecutiveBriefing, resolveBriefingSummary } from './ExecutiveBriefing';

import {
  Sparkles,
  CheckCircle2,
  AlertCircle,
  Copy,
  Check,
  Edit3,
  Play,
  Download,
  Search,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  Cpu,
  TrendingUp,
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  ShieldCheck,
  Bookmark,
  BookmarkCheck,
  FileJson,
  BarChart3,
  Presentation,
  Rows,
  SlidersHorizontal,
  X,
} from 'lucide-react';
import { LocalQueryStorage } from '../services/localQueryStorage';
import { formatSanitizedCsv } from '../services/csvExportSanitizer';
import { Dataset } from '../types';
import { profileDatasetSchema } from '../services/schemaProfiler';
import { selectDeterministicVisualization } from '../services/visualizationSelector';

// Which action bar a feedback line belongs to.
type ActionSurface = 'answer' | 'table' | 'sql';

// 'blocked' means the edit never reached the validator because a run was already in flight;
// 'rejected' means it reached the analytical contract and was refused.
export type SqlExecutionOutcome = 'executed' | 'rejected' | 'blocked';

interface ResultsViewProps {
  result: QueryResult;
  isDarkMode: boolean;
  onUpdateSql: (newSql: string) => Promise<SqlExecutionOutcome>;
  onOpenAuditor?: () => void;
  dataset?: Dataset | null;
  isPresentationMode?: boolean;
  onTogglePresentationMode?: () => void;
}

const COLUMN_LABEL_MAP: Record<string, string> = {
  company_name: 'Company',
  support_tickets: 'Support Tickets',
  active_users: 'Active Users',
  mrr: 'MRR',
  lost_or_at_risk_mrr: 'Lost / At-Risk MRR',
  nps_score: 'NPS Score',
  churn_status: 'Churn Status',
  plan_tier: 'Plan Tier',
  customer_id: 'Customer ID',
  customer_name: 'Customer Name',
  order_id: 'Order ID',
  order_date: 'Order Date',
  discount_pct: 'Discount',
  signup_date: 'Signup Date',
  total_mrr: 'Total MRR',
  avg_mrr: 'Avg MRR',
  customer_count: 'Customer Count',
  total_active_users: 'Total Users',
  total_sales: 'Total Sales',
  total_profit: 'Total Profit',
  profit_margin: 'Profit Margin',
  industry: 'Industry',
  region: 'Region',
  category: 'Category',
  product: 'Product',
  quantity: 'Quantity',
  sales: 'Sales',
  profit: 'Profit',
};

function prettifyColumnHeader(col: string): string {
  const lower = col.toLowerCase().trim();
  if (COLUMN_LABEL_MAP[lower]) {
    return COLUMN_LABEL_MAP[lower];
  }
  return col
    .split('_')
    .map((word) => {
      const wLower = word.toLowerCase();
      if (['id', 'mrr', 'nps', 'arr', 'usd', 'ai', 'sql', 'avg'].includes(wLower)) {
        return wLower.toUpperCase();
      }
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(' ');
}

function isNumericValue(val: any): boolean {
  if (val === null || val === undefined || val === '') return false;
  if (typeof val === 'number') return !isNaN(val);
  if (typeof val === 'bigint') return true;
  if (typeof val === 'string' && /^-?\d+(\.\d+)?$/.test(val.trim())) return true;
  return false;
}

function checkColumnIsNumeric(rows: Record<string, any>[], col: string): boolean {
  if (!rows || rows.length === 0) return false;
  const nonNull = rows.map((r) => r[col]).filter((v) => v !== null && v !== undefined && v !== '');
  if (nonNull.length === 0) return false;
  return nonNull.every(isNumericValue);
}

function formatCellValue(val: any, col: string): React.ReactNode {
  if (val === null || val === undefined) {
    return <span className="text-text-muted italic">null</span>;
  }
  if (typeof val === 'boolean') {
    return val ? 'true' : 'false';
  }

  if (isNumericValue(val)) {
    const num = Number(val);
    const colLower = col.toLowerCase();

    // A ratio is never a currency, even when its label mentions one.
    const isPercentage = /(pct|percent|margin|ratio|share|rate)/i.test(colLower);
    if (isPercentage) {
      const pctValue = Math.abs(num) <= 1 ? num * 100 : num;
      return `${Number(pctValue.toFixed(2))}%`;
    }

    // Currency columns: MRR, Sales, Profit, Revenue, etc.
    const isCurrency = /(mrr|sales|profit|revenue|price|amount|cost|spend)/i.test(colLower);
    if (isCurrency) {
      return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        maximumFractionDigits: num % 1 === 0 ? 0 : 2,
      }).format(num);
    }

    // General numbers (thousands separator, max 2 decimals)
    return new Intl.NumberFormat('en-US', {
      maximumFractionDigits: 2,
    }).format(num);
  }

  return String(val);
}

export const ResultsView: React.FC<ResultsViewProps> = ({
  result,
  isDarkMode,
  onUpdateSql,
  onOpenAuditor,
  dataset,
  isPresentationMode = false,
  onTogglePresentationMode,
}) => {
  const [copiedSql, setCopiedSql] = useState<boolean>(false);
  const [isEditingSql, setIsEditingSql] = useState<boolean>(false);
  const [editedSql, setEditedSql] = useState<string>(result.sql);
  const [searchTerm, setSearchTerm] = useState<string>('');
  const [sortCol, setSortCol] = useState<string | null>(null);
  const [sortAsc, setSortAsc] = useState<boolean>(true);
  const [page, setPage] = useState<number>(1);
  const [isTraceExpanded, setIsTraceExpanded] = useState<boolean>(false);
  const [isSaved, setIsSaved] = useState<boolean>(false);
  const [actionFeedback, setActionFeedback] = useState<{
    text: string;
    tone: 'ok' | 'error';
    at: ActionSurface;
  } | null>(null);
  const [isExecutingSql, setIsExecutingSql] = useState<boolean>(false);
  const [isChartOpen, setIsChartOpen] = useState<boolean>(() => Boolean(result.chartSuggestion) && (result.rows?.length ?? 0) > 1);
  const [isSqlExpanded, setIsSqlExpanded] = useState<boolean>(false);
  const [tableDensity, setTableDensity] = useState<'comfortable' | 'compact'>('comfortable');
  const pageSize = 10;

  // Copy and save can each be clicked again before their previous message has finished, and two
  // unshared timeouts meant an older timer could wipe a newer message out of the announcer. Each
  // surface owns one ref, and the ref is replaced rather than allowed to overlap.
  const feedbackTimerRef = useRef<number | null>(null);
  const copiedTimerRef = useRef<number | null>(null);

  // One transient line, placed beside the control that produced it: a confirmation pinned to the
  // answer band is off-screen for a reader working in the SQL panel at the bottom of the page.
  const announceAction = (text: string, at: ActionSurface, tone: 'ok' | 'error' = 'ok') => {
    if (feedbackTimerRef.current !== null) window.clearTimeout(feedbackTimerRef.current);
    setActionFeedback({ text, tone, at });
    feedbackTimerRef.current = window.setTimeout(() => {
      feedbackTimerRef.current = null;
      setActionFeedback(null);
    }, 3200);
  };

  useEffect(
    () => () => {
      if (feedbackTimerRef.current !== null) window.clearTimeout(feedbackTimerRef.current);
      if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current);
    },
    []
  );

  const renderFeedback = (surface: ActionSurface, className: string) => {
    if (actionFeedback?.at !== surface) return null;
    const isError = actionFeedback.tone === 'error';
    return (
      <div
        className={`${className} text-xs font-medium flex items-center gap-1.5 animate-in fade-in ${
          isError ? 'text-error' : 'text-accent'
        }`}
      >
        {isError ? (
          <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" aria-hidden="true" />
        ) : (
          <CheckCircle2 className="w-3.5 h-3.5 flex-shrink-0" aria-hidden="true" />
        )}
        <span>{actionFeedback.text}</span>
      </div>
    );
  };

  // The deterministic blueprint can answer after every provider round failed validation. The
  // numbers are verified, but the reader has to be able to see that they did not come from
  // the model's SQL.
  const usedBlueprintFallback = (result.reasoningSteps || []).some((s) => s.title === 'Autonomous Blueprint Fallback');

  // Identify numeric columns in current result
  const numericCols = React.useMemo(() => {
    return result.columns.filter((c) => checkColumnIsNumeric(result.rows, c));
  }, [result.columns, result.rows]);

  const activeChartSuggestion = React.useMemo(() => {
    if (!dataset || !result.queryPlan) return undefined;
    return selectDeterministicVisualization(
      result.question, result.queryPlan, result.rows, result.columns,
      profileDatasetSchema(dataset), result.chartSuggestion
    );
  }, [dataset, result.question, result.queryPlan, result.chartSuggestion, result.columns, result.rows]);

  const hasRows = (result.rows?.length ?? 0) > 0;
  // A single aggregate row is a metric set, not a grid to scan: those values belong in the answer band.
  const singleMetricRow = React.useMemo(() => {
    if ((result.rows?.length ?? 0) !== 1) return null;
    if (result.status === 'needs_clarification' || result.status === 'failed') return null;
    const cols = result.columns || [];
    if (cols.length === 0 || cols.length > 4) return null;
    const row = result.rows[0];
    const metrics = cols.map((col) => ({
      col,
      label: prettifyColumnHeader(col),
      value: formatCellValue(row[col], col),
      isNumeric: checkColumnIsNumeric([row], col),
    }));
    const primary = metrics.find((m) => m.isNumeric) ?? metrics[0];
    return { primary, supporting: metrics.filter((m) => m !== primary) };
  }, [result.rows, result.columns, result.status]);

  // One owner for the sentence the reader sees first; the briefing suppresses the same text.
  const answerSummary = React.useMemo(() => {
    if (result.status === 'needs_clarification') return result.clarificationMessage || '';
    if (result.status === 'failed') return result.error || 'The query did not complete validation.';
    if (result.insight) return resolveBriefingSummary(result.insight);
    return '';
  }, [result.status, result.clarificationMessage, result.error, result.insight]);

  // One data point is not a series: the value itself is already the visualisation.
  const chartableRows = hasRows && (result.rows?.length ?? 0) > 1;
  const isDiagnosticStatus = result.status === 'needs_clarification' || result.status === 'failed';

  // A new result is a different question, so nothing from the previous one may carry over —
  // including a sort column that no longer exists, which used to order rows while every header
  // still reported aria-sort="none".
  React.useEffect(() => {
    setSearchTerm('');
    setPage(1);
    setSortCol(null);
    setSortAsc(true);
    setIsSqlExpanded(false);
    setIsChartOpen(Boolean(result.chartSuggestion) && (result.rows?.length ?? 0) > 1);
  }, [result.id]);

  // Re-executed SQL is the same question, so the panel stays as the reader left it: collapsing the
  // disclosure they are working in immediately after they press Execute hid the statement they had
  // just asked to run.
  React.useEffect(() => {
    setEditedSql(result.sql);
    setIsEditingSql(false);
    setSearchTerm('');
    setPage(1);
  }, [result.sql]);

  // Sync saved state with LocalQueryStorage
  React.useEffect(() => {
    const storage = new LocalQueryStorage();
    const cols = dataset?.columns.map((c) => c.name) || result.columns || [];
    setIsSaved(storage.isQuerySaved(result.question, cols));

    const handleUpdate = () => {
      const s = new LocalQueryStorage();
      setIsSaved(s.isQuerySaved(result.question, cols));
    };
    window.addEventListener('querymind_library_updated', handleUpdate);
    return () => window.removeEventListener('querymind_library_updated', handleUpdate);
  }, [result.question, result.columns, dataset]);

  const handleToggleSave = () => {
    const storage = new LocalQueryStorage();
    const cols = dataset?.columns.map((c) => c.name) || result.columns || [];
    if (isSaved) {
      storage.deleteSavedQuery(result.question, storage.getFingerprint(cols));
      setIsSaved(false);
      announceAction('Removed from Sandboxed Memory', 'answer');
    } else {
      const saved = storage.saveSuccessfulQuery(
        result.question,
        cols,
        result.sql,
        {
          datasetName: dataset?.name || 'Custom Dataset',
          rowCount: result.rowCount,
          tableName: dataset?.tableName || 'dataset',
          insightSummary: result.insight?.summary || result.insight?.executive_summary,
        }
      );
      // A rejected write used to leave the button exactly as it was with nothing said, which reads
      // as a dead control. The failure has its own message now.
      setIsSaved(saved);
      announceAction(
        saved
          ? 'Saved to Sandboxed Memory'
          : 'Could not save — the browser refused the storage write.',
        'answer',
        saved ? 'ok' : 'error'
      );
    }
  };

  const handleCopySql = async () => {
    try {
      await navigator.clipboard.writeText(result.sql);
      if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current);
      setCopiedSql(true);
      copiedTimerRef.current = window.setTimeout(() => {
        copiedTimerRef.current = null;
        setCopiedSql(false);
      }, 2000);
      announceAction('Generated SQL copied to clipboard', 'sql');
    } catch {
      // writeText rejects when the document is not focused or the permission is denied. Claiming
      // "Copied" in that case is a false confirmation about the user's own clipboard.
      announceAction('Clipboard blocked by the browser — select the SQL and copy it manually.', 'sql', 'error');
    }
  };

  const handleExecuteEditedSql = async () => {
    if (isExecutingSql) return;
    setIsExecutingSql(true);
    let outcome: SqlExecutionOutcome = 'rejected';
    try {
      outcome = await onUpdateSql(editedSql);
    } finally {
      setIsExecutingSql(false);
    }
    // A blocked run already has its own status line in the workspace, so repeating it here would be
    // two messages for one click. The rejected line points at the persistent validation error above
    // rather than restating a competing version of the same failure.
    if (outcome === 'blocked') return;
    announceAction(
      outcome === 'executed'
        ? 'Edited SQL passed validation and re-executed locally.'
        : 'Edited SQL was not executed. The error shown above explains why.',
      'sql',
      outcome === 'executed' ? 'ok' : 'error'
    );
  };

  const handleExportCsv = () => {
    if (!result.rows || result.rows.length === 0) return;
    const csvContent = formatSanitizedCsv(result.columns, result.rows);
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', `querymind_results_${Date.now()}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    announceAction('CSV download started', 'table');
  };

  const handleExportJson = () => {
    if (!result.rows || result.rows.length === 0) return;
    const payload = {
      question: result.question,
      sql: result.sql,
      executedAt: new Date().toISOString(),
      rowCount: result.rowCount,
      columns: result.columns,
      rows: result.rows,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', `querymind_results_${Date.now()}.json`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    announceAction('JSON download started', 'table');
  };

  // Filter & Sort table data
  const filteredRows = (result.rows || []).filter((r) => {
    if (!searchTerm) return true;
    const term = searchTerm.toLowerCase();
    return Object.values(r).some((v) => String(v).toLowerCase().includes(term));
  });

  const sortedRows = [...filteredRows].sort((a, b) => {
    if (!sortCol) return 0;
    const valA = a[sortCol];
    const valB = b[sortCol];
    if (valA === valB) return 0;
    if (valA === undefined || valA === null) return 1;
    if (valB === undefined || valB === null) return -1;
    if (isNumericValue(valA) && isNumericValue(valB)) {
      return sortAsc ? Number(valA) - Number(valB) : Number(valB) - Number(valA);
    }
    return sortAsc
      ? String(valA).localeCompare(String(valB))
      : String(valB).localeCompare(String(valA));
  });

  const totalPages = Math.ceil(sortedRows.length / pageSize) || 1;
  const paginatedRows = sortedRows.slice((page - 1) * pageSize, page * pageSize);

  const handleSort = (colName: string) => {
    if (sortCol === colName) {
      setSortAsc(!sortAsc);
    } else {
      setSortCol(colName);
      setSortAsc(true);
    }
  };

  const cardStyle: React.CSSProperties = {
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    borderRadius: '12px',
    overflow: 'hidden',
  };
  const headerStyle: React.CSSProperties = {
    background: isDarkMode ? 'rgba(30,27,24,0.6)' : 'rgba(237,233,226,0.5)',
    borderBottom: '1px solid var(--border)',
    padding: '10px 16px',
  };
  const cardBg = 'bg-surface border-border-subtle'; // kept for backward compat
  const headerBg = 'bg-surface-secondary/70 border-border-subtle'; // kept for backward compat

  // Status Badge Rendering — the check count itself lives in the facts row, not in the label.
  const renderStatusBadge = () => {
    if (result.status === 'needs_clarification') {
      return (
        <span className="text-meta font-semibold uppercase px-2.5 py-1 rounded-md bg-badge-warning-bg text-badge-warning-fg border border-badge-warning-border flex items-center gap-1.5 shadow-2xs">
          <AlertCircle className="w-3.5 h-3.5" />
          Needs Clarification
        </span>
      );
    }
    if (result.status === 'failed') {
      return (
        <span className="text-meta font-semibold uppercase px-2.5 py-1 rounded-md bg-badge-error-bg text-badge-error-fg border border-badge-error-border flex items-center gap-1.5 shadow-2xs">
          <AlertTriangle className="w-3.5 h-3.5" />
          Validation Failed
        </span>
      );
    }
    const passCount = result.passedChecks?.length || 0;
    return (
      <span
        title={passCount > 0 ? `Executed SQL answers this request · ${passCount} integrity checks passed` : 'Executed SQL answers this request'}
        className="text-meta font-semibold uppercase px-2.5 py-1 rounded-md bg-badge-success-bg text-badge-success-fg border border-badge-success-border flex items-center gap-1.5 shadow-2xs"
      >
        <CheckCircle2 className="w-3.5 h-3.5" />
        Verified
      </span>
    );
  };

  return (
    <div className="space-y-3 animate-result-enter">
      {/* Presentation Mode Status Bar */}
      {isPresentationMode && (
        <div className="p-3.5 rounded-xl bg-accent/10 border border-accent/30 flex items-center justify-between text-xs animate-in fade-in">
          <div className="flex items-center gap-2.5">
            <Presentation className="w-4 h-4 text-accent flex-shrink-0" />
            <div>
              <span className="font-semibold text-accent">Executive Presentation View Active</span>
              <p className="text-meta text-text-muted mt-0.5">
                Answer, visualisation, data table and stakeholder briefing remain visible; SQL source and execution traces are suppressed.
              </p>
            </div>
          </div>
          {onTogglePresentationMode && (
            <button
              type="button"
              onClick={onTogglePresentationMode}
              className="btn-interactive px-2.5 py-1 rounded-lg border border-accent/40 bg-surface text-accent hover:bg-accent/15 font-semibold text-xs transition-colors cursor-pointer flex-shrink-0 ml-3 focus-ring"
            >
              Exit View
            </button>
          )}
        </div>
      )}

      {/* 1. Answer Band: finding first, request as context, verified execution facts last */}
      <div style={cardStyle} className="px-4 py-3.5 sm:px-5 sm:py-4">
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <p className="text-prose font-medium text-text-secondary min-w-0 flex-1 leading-snug">
            &ldquo;{result.question}&rdquo;
          </p>
          <div className="flex items-center gap-2 flex-shrink-0">
            {renderStatusBadge()}
            {result.sql && (
              <button
                type="button"
                onClick={handleToggleSave}
                aria-pressed={isSaved}
                className={`btn-interactive flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg border transition-all duration-fast shadow-2xs cursor-pointer focus-ring ${
                  isSaved
                    ? 'border-accent/40 bg-accent/15 text-accent hover:bg-accent/25'
                    : 'border-border-strong bg-surface hover:bg-surface-elevated text-text-primary hover:border-accent hover:text-accent'
                }`}
                title={
                  isSaved
                    ? 'Stored in sandboxed memory (Click to remove)'
                    : 'Save this query to sandboxed memory for offline access and export'
                }
              >
                {isSaved ? (
                  <>
                    <BookmarkCheck className="w-3.5 h-3.5 fill-current" />
                    <span>In Memory</span>
                  </>
                ) : (
                  <>
                    <Bookmark className="w-3.5 h-3.5" />
                    <span>Save to Memory</span>
                  </>
                )}
              </button>
            )}
          </div>
        </div>

        {isDiagnosticStatus ? (
          <div
            className={`mt-3 border-l-2 pl-3 ${
              result.status === 'failed' ? 'border-badge-error-border' : 'border-badge-warning-border'
            }`}
          >
            <p className="text-prose font-semibold text-text-primary">
              {result.status === 'failed' ? 'Query did not pass validation' : 'Metric clarification required'}
            </p>
            {answerSummary && <p className="text-prose text-text-secondary mt-0.5">{answerSummary}</p>}
          </div>
        ) : singleMetricRow ? (
          <dl className="mt-3 flex flex-wrap items-end gap-x-6 gap-y-3">
            <div className="min-w-0">
              <dt className="text-meta font-semibold uppercase text-text-secondary">{singleMetricRow.primary.label}</dt>
              <dd className="text-heading font-semibold tabular-nums text-text-primary leading-tight mt-0.5">
                {singleMetricRow.primary.value}
              </dd>
            </div>
            {singleMetricRow.supporting.map((metric) => (
              <div key={metric.col} className="min-w-0">
                <dt className="text-meta uppercase text-text-muted">{metric.label}</dt>
                <dd className="text-prose font-medium tabular-nums text-text-primary">{metric.value}</dd>
              </div>
            ))}
          </dl>
        ) : (
          answerSummary && (
            <p className="mt-3 text-heading font-semibold leading-snug text-text-primary max-w-prose">{answerSummary}</p>
          )
        )}

        {usedBlueprintFallback && (
          <p className="mt-2.5 text-meta font-mono inline-block px-2 py-0.5 rounded-md bg-badge-warning-bg text-badge-warning-fg border border-badge-warning-border">
            Blueprint SQL · no provider reply passed validation
          </p>
        )}

        {!isDiagnosticStatus && result.sql && (
          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-meta font-mono tabular-nums text-text-muted">
            {result.columns.length > 0 && (
              <span>
                {result.columns.length} column{result.columns.length === 1 ? '' : 's'}
              </span>
            )}
            <span>{result.executionTimeMs}ms</span>
            <span>In-Memory DuckDB</span>
            {result.passedChecks && result.passedChecks.length > 0 && (
              <span>{result.passedChecks.length} integrity checks</span>
            )}
          </div>
        )}

        {renderFeedback('answer', 'mt-3')}
      </div>

      {/* 2. Interactive Data Visualization / Chart Studio */}
      {isChartOpen && activeChartSuggestion && chartableRows && (
        <DataChart
          key={`chart-${result.id}`}
          data={result.rows}
          suggestion={activeChartSuggestion}
          isDarkMode={isDarkMode}
          availableColumns={result.columns}
          numericColumns={numericCols}
          onClose={() => setIsChartOpen(false)}
          allowCustomize={true}
        />
      )}

      {/* 3. Query Results Data Table (L4 evidence — the full rows behind the answer) */}
      {result.rows && result.rows.length > 0 && (
        <div style={cardStyle}>
          <div style={headerStyle} className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                Data table
              </span>
              <span className="text-xs font-medium tabular-nums text-text-secondary">
                Showing {paginatedRows.length} of {result.rowCount.toLocaleString()} row{result.rowCount === 1 ? '' : 's'}
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-2 min-w-0 xl:justify-end">
              {/* Table Search — no rows to filter means no search field */}
              {result.rows.length > 1 && (
                <div className="relative min-w-0 w-full sm:w-48">
                  <Search className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none" />
                  <input
                    type="text"
                    aria-label="Search result rows"
                    placeholder="Search rows..."
                    value={searchTerm}
                    onChange={(e) => {
                      setSearchTerm(e.target.value);
                      setPage(1);
                    }}
                    className="w-full text-xs sm:text-sm pl-8 pr-9 py-1.5 rounded-lg border border-field-border bg-surface text-text-primary placeholder:text-text-muted focus:border-accent focus-ring transition-all duration-fast shadow-2xs"
                  />
                  {searchTerm && (
                    <button
                      type="button"
                      onClick={() => {
                        setSearchTerm('');
                        setPage(1);
                      }}
                      aria-label="Clear row search"
                      className="btn-interactive absolute right-1.5 top-1/2 -translate-y-1/2 p-1 rounded text-text-muted hover:text-text-primary focus-ring"
                      title="Clear the row filter and show every row"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              )}

              {/* Export Data (CSV and JSON) */}
              <div className="flex flex-wrap items-center gap-1.5 min-w-0">
                <button
                  type="button"
                  onClick={handleExportCsv}
                  disabled={result.rows.length === 0}
                  aria-label="Download results as CSV"
                  className="btn-interactive text-xs sm:text-sm px-2.5 py-1.5 rounded-lg border border-border-strong bg-surface text-text-secondary hover:text-text-primary hover:border-border-strong hover:bg-surface-elevated flex items-center gap-1.5 font-medium shadow-2xs focus-ring cursor-pointer disabled:bg-surface-secondary disabled:text-text-muted disabled:border-border-subtle"
                  title="Download results table as CSV"
                >
                  <Download className="w-3.5 h-3.5 text-accent" />
                  <span>CSV</span>
                </button>
                <button
                  type="button"
                  onClick={handleExportJson}
                  disabled={result.rows.length === 0}
                  aria-label="Download results and metadata as JSON"
                  className="btn-interactive text-xs sm:text-sm px-2.5 py-1.5 rounded-lg border border-border-strong bg-surface text-text-secondary hover:text-text-primary hover:border-border-strong hover:bg-surface-elevated flex items-center gap-1.5 font-medium shadow-2xs focus-ring cursor-pointer disabled:bg-surface-secondary disabled:text-text-muted disabled:border-border-subtle"
                  title="Download results and metadata as JSON"
                >
                  <FileJson className="w-3.5 h-3.5 text-accent" />
                  <span>JSON</span>
                </button>

                {/* Density Switcher (Comfortable vs Compact) — meaningless for a single row */}
                {result.rows.length > 1 && (
                  <button
                    type="button"
                    onClick={() => setTableDensity(tableDensity === 'comfortable' ? 'compact' : 'comfortable')}
                    aria-label={`Toggle row density, currently ${tableDensity}`}
                    className="btn-interactive text-xs sm:text-sm px-2.5 py-1.5 rounded-lg border border-border-strong bg-surface text-text-secondary hover:text-text-primary hover:border-accent flex items-center gap-1.5 font-medium shadow-2xs focus-ring cursor-pointer"
                    title={`Toggle row density (current: ${tableDensity})`}
                  >
                    <Rows className="w-3.5 h-3.5 text-accent" />
                    <span className="hidden sm:inline capitalize">{tableDensity}</span>
                  </button>
                )}

                {/* Generate / Toggle Chart Button */}
                {activeChartSuggestion && chartableRows && (
                  <button
                    type="button"
                    onClick={() => setIsChartOpen(!isChartOpen)}
                    aria-expanded={isChartOpen}
                    className={`btn-interactive text-xs sm:text-sm px-2.5 py-1.5 rounded-lg border flex items-center gap-1.5 font-medium shadow-2xs focus-ring cursor-pointer transition-colors ${
                      isChartOpen
                        ? 'bg-accent/15 border-accent/40 text-accent font-semibold'
                        : 'border-border-strong bg-surface text-text-secondary hover:text-text-primary hover:border-accent'
                    }`}
                    title={isChartOpen ? 'Hide the chart visualization' : 'Generate an interactive chart from these results'}
                  >
                    <BarChart3 className="w-3.5 h-3.5 text-accent" />
                    <span>{isChartOpen ? 'Hide Chart' : 'Generate Chart'}</span>
                  </button>
                )}
              </div>
            </div>
          </div>

          {renderFeedback('table', 'px-4 pt-3')}

          {searchTerm && (
            <div role="status" className="px-4 pt-3 text-xs tabular-nums text-text-muted">
              {sortedRows.length === 0
                ? `No rows match “${searchTerm}”.`
                : `${sortedRows.length} of ${result.rows.length.toLocaleString()} rows match “${searchTerm}”.`}
            </div>
          )}

          {/* Table Content with Zebra Striping and Clean Spacing */}
          <div className="overflow-x-auto max-w-full pb-1">
            {result.rows.length === 0 ? (
              <div role="status" className="p-8 text-center text-sm text-text-muted italic">
                Query completed with 0 rows returned.
              </div>
            ) : (
              <table className="w-full text-left text-sm border-collapse whitespace-nowrap">
                <caption className="sr-only text-left">
                  Results for “{result.question}” — {result.rowCount.toLocaleString()} row{result.rowCount === 1 ? '' : 's'}, {result.columns.length} column{result.columns.length === 1 ? '' : 's'}
                </caption>
                <thead>
                  <tr className="bg-surface-secondary/90 text-text-secondary border-b border-border-subtle select-none">
                    {result.columns.map((col) => {
                      const isNum = checkColumnIsNumeric(result.rows, col);
                      const isSorted = sortCol === col;
                      // A static up/down glyph made a descending column look identical to an unsorted one.
                      const sortHint = isSorted
                        ? sortAsc
                          ? `Sorted ascending. Sort by ${prettifyColumnHeader(col)} descending`
                          : `Sorted descending. Sort by ${prettifyColumnHeader(col)} ascending`
                        : `Sort by ${prettifyColumnHeader(col)}`;
                      return (
                        <th
                          key={col}
                          scope="col"
                          aria-sort={sortCol === col ? (sortAsc ? 'ascending' : 'descending') : 'none'}
                          className={`${
                            tableDensity === 'compact' ? 'px-3 py-2 text-xs' : 'px-4 py-3 text-xs'
                          } font-semibold min-w-[120px] max-w-[320px] ${
                            isNum ? 'text-right' : 'text-left'
                          }`}
                        >
                          <button
                            type="button"
                            onClick={() => handleSort(col)}
                            aria-label={sortHint}
                            title={sortHint}
                            className={`btn-interactive inline-flex w-full items-center gap-1.5 cursor-pointer hover:text-text-primary transition-colors duration-fast rounded focus-ring min-h-[24px] ${
                              isNum ? 'justify-end' : 'justify-start'
                            }`}
                          >
                            <span className="truncate">{prettifyColumnHeader(col)}</span>
                            {isSorted ? (
                              sortAsc ? (
                                <ArrowUp className="w-3 h-3 text-accent flex-shrink-0" aria-hidden="true" />
                              ) : (
                                <ArrowDown className="w-3 h-3 text-accent flex-shrink-0" aria-hidden="true" />
                              )
                            ) : (
                              <ArrowUpDown className="w-3 h-3 opacity-50 flex-shrink-0" aria-hidden="true" />
                            )}
                          </button>
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-subtle">
                  {paginatedRows.map((row, rIdx) => (
                    <tr
                      key={rIdx}
                      className="odd:bg-surface even:bg-surface-secondary/35 hover:bg-accent/8 transition-colors duration-fast group"
                    >
                      {result.columns.map((col) => {
                        const val = row[col];
                        const isNum = checkColumnIsNumeric(result.rows, col);
                        return (
                          <td
                            key={col}
                            className={`${
                              tableDensity === 'compact' ? 'px-3 py-1.5 text-xs' : 'px-4 py-3 text-sm'
                            } text-text-primary border-r border-border-subtle/30 last:border-0 max-w-[340px] truncate ${
                              isNum ? 'font-mono tabular-nums text-right font-medium' : 'font-sans text-left'
                            }`}
                          >
                            {formatCellValue(val, col)}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* Pagination Footer */}
          {totalPages > 1 && (
            <div className="px-4 py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-sm text-text-secondary" style={{ borderTop: '1px solid var(--border)', background: 'var(--surface-secondary)' }}>
              <span role="status" className="text-xs tabular-nums">
                Page {page} of {totalPages} ({sortedRows.length.toLocaleString()} filtered rows)
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page <= 1}
                  className="btn-interactive px-3 py-1.5 rounded-lg border border-border-strong bg-surface font-medium disabled:bg-surface-secondary disabled:text-text-muted disabled:border-border-subtle hover:text-text-primary hover:border-border-strong transition-colors duration-fast shadow-2xs focus-ring"
                >
                  Previous
                </button>
                <button
                  type="button"
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={page >= totalPages}
                  className="btn-interactive px-3 py-1.5 rounded-lg border border-border-strong bg-surface font-medium disabled:bg-surface-secondary disabled:text-text-muted disabled:border-border-subtle hover:text-text-primary hover:border-border-strong transition-colors duration-fast shadow-2xs focus-ring"
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* 4. Executive Analytical Briefing (L5 interpretation; the briefing only repeats the summary line the band did not show) */}
      {result.insight && (
        <ExecutiveBriefing
          insightsPayload={result.insight}
          isDarkMode={isDarkMode}
          hideSummary={Boolean(answerSummary) && !singleMetricRow}
        />
      )}

      {/* 5. Generated SQL Panel (L6: available on demand, collapsed so it cannot compete with the answer) */}
      {!isPresentationMode && result.sql && (
        <div style={cardStyle}>
          <div style={headerStyle} className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-meta font-mono uppercase px-1.5 py-0.5 rounded border border-border-strong text-text-secondary">
                SQL
              </span>
              <span className="text-sm font-semibold text-text-muted">Generated query</span>
            </div>

            <button
              type="button"
              onClick={() => {
                setIsSqlExpanded(!isSqlExpanded);
                if (isSqlExpanded) setIsEditingSql(false);
              }}
              aria-expanded={isSqlExpanded}
              className="btn-interactive flex items-center gap-1.5 text-xs px-2.5 py-1.5 rounded-lg border border-border-strong bg-surface text-text-secondary hover:text-text-primary hover:border-accent font-medium shadow-2xs focus-ring cursor-pointer"
              title={isSqlExpanded ? 'Collapse the executed SQL statement' : 'Show the executed SQL statement'}
            >
              <span>{isSqlExpanded ? 'Hide SQL' : 'Show SQL'}</span>
              {isSqlExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            </button>
          </div>

          {isSqlExpanded && (
            <div className="border-t border-border-subtle">
              {/* High-Contrast Code Surface */}
              <div className="bg-code-bg p-4 transition-colors duration-fast">
                {isEditingSql ? (
                  <div className="space-y-3">
                    <textarea
                      rows={5}
                      aria-label="Editable SQL statement"
                      value={editedSql}
                      onChange={(e) => setEditedSql(e.target.value)}
                      className="w-full font-mono text-sm bg-code-bg text-code-fg p-3 rounded-lg border border-field-border focus:border-accent resize-y focus-ring"
                    />
                    <div className="flex justify-end">
                      <button
                        type="button"
                        onClick={handleExecuteEditedSql}
                        disabled={isExecutingSql}
                        aria-busy={isExecutingSql}
                        className="btn-interactive px-4 py-2 rounded-lg bg-accent hover:bg-accent-hover text-accent-ink text-sm font-semibold flex items-center gap-2 shadow-sm focus-ring"
                      >
                        <Play className="w-3.5 h-3.5 fill-current" />
                        <span>{isExecutingSql ? 'Executing…' : 'Re-execute SQL'}</span>
                      </button>
                    </div>
                  </div>
                ) : (
                  <pre className="font-mono text-sm text-code-fg overflow-x-auto leading-relaxed whitespace-pre-wrap selection:bg-accent/30">
                    <code>{result.sql}</code>
                  </pre>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-2 px-4 py-2.5 bg-surface-secondary/40">
                <button
                  type="button"
                  onClick={() => setIsEditingSql(!isEditingSql)}
                  aria-expanded={isEditingSql}
                  className={`btn-interactive text-xs px-2.5 py-1.5 rounded-lg border flex items-center gap-1.5 font-medium shadow-2xs focus-ring cursor-pointer ${
                    isEditingSql
                      ? 'border-badge-accent-border bg-badge-accent-bg text-badge-accent-fg'
                      : 'border-border-strong bg-surface text-text-secondary hover:text-text-primary hover:border-border-strong hover:bg-surface-elevated'
                  }`}
                >
                  <Edit3 className="w-3.5 h-3.5" />
                  <span>{isEditingSql ? 'Close Editor' : 'Edit SQL'}</span>
                </button>

                <button
                  type="button"
                  onClick={handleCopySql}
                  aria-label={copiedSql ? 'Generated SQL copied to clipboard' : 'Copy generated SQL'}
                  className="btn-interactive text-xs px-2.5 py-1.5 rounded-lg border border-border-strong bg-surface text-text-secondary hover:text-text-primary hover:border-border-strong hover:bg-surface-elevated flex items-center gap-1.5 font-medium shadow-2xs focus-ring"
                >
                  {copiedSql ? (
                    <>
                      <Check className="w-3.5 h-3.5 text-success" />
                      <span className="text-success font-semibold">Copied</span>
                    </>
                  ) : (
                    <>
                      <Copy className="w-3.5 h-3.5" />
                      <span>Copy</span>
                    </>
                  )}
                </button>
              </div>

              {renderFeedback('sql', 'px-4 pb-2.5')}
            </div>
          )}
        </div>
      )}

      {/* 6. Execution & Validation Details (Hidden in Executive Presentation Mode) */}
      {!isPresentationMode && result.reasoningSteps && result.reasoningSteps.length > 0 && (
        <div style={cardStyle}>
          <button
            type="button"
            onClick={() => setIsTraceExpanded(!isTraceExpanded)}
            aria-expanded={isTraceExpanded}
            className="w-full flex items-center justify-between text-left transition-colors duration-fast hover:bg-surface-secondary/50 focus-ring"
            style={headerStyle}
          >
            <div className="flex items-center gap-2 min-w-0">
              <Cpu className="w-4 h-4 text-accent flex-shrink-0" />
              <span className="text-sm font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
                Execution & Validation Trace
              </span>
            </div>

            <div className="flex items-center gap-2 text-text-secondary text-xs flex-shrink-0">
              <span>{isTraceExpanded ? 'Hide Trace' : 'Inspect Trace'}</span>
              {isTraceExpanded ? (
                <ChevronUp className="w-4 h-4" />
              ) : (
                <ChevronDown className="w-4 h-4" />
              )}
            </div>
          </button>

          {isTraceExpanded && (
            <div className="px-4 py-3.5 space-y-3 border-t border-border-subtle bg-surface/50">
              {/* Passed Contract Checks */}
              {result.passedChecks && result.passedChecks.length > 0 && (
                <div className="p-3 rounded-lg bg-badge-success-bg/30 border border-badge-success-border/50 mb-3">
                  <div className="flex items-center justify-between text-xs font-semibold text-text-primary mb-2">
                    <div className="flex items-center gap-1.5">
                      <ShieldCheck className="w-4 h-4 text-badge-success-fg" />
                      <span>Request & Integrity Checks:</span>
                    </div>
                    {onOpenAuditor && (
                      <button
                        type="button"
                        onClick={onOpenAuditor}
                        className="text-xs font-medium text-accent hover:underline cursor-pointer flex items-center gap-1 rounded focus-ring"
                      >
                        <span>Inspect Outbound Packet</span>
                      </button>
                    )}
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 text-xs text-text-secondary">
                    {result.passedChecks.map((chk, i) => (
                      <div key={i} className="flex items-center gap-1.5">
                        <Check className="w-3 h-3 text-badge-success-fg flex-shrink-0" />
                        <span className="truncate">{chk}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Step By Step Operational Stages */}
              <div className="space-y-2">
                {result.reasoningSteps.map((step, idx) => (
                  <div key={idx} className="flex items-start gap-2.5 text-xs sm:text-sm">
                    <div className="w-4 h-4 rounded-full bg-badge-success-bg text-badge-success-fg border border-badge-success-border flex items-center justify-center flex-shrink-0 mt-0.5">
                      <Check className="w-2.5 h-2.5 stroke-[3]" />
                    </div>
                    <div className="leading-snug">
                      <span className="font-semibold text-text-primary mr-1.5">{step.title}:</span>
                      <span className="text-text-secondary">{step.detail}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* The visible confirmations sit beside their controls, which means a reader using a screen
          reader may never be looking at that spot. One persistent polite region announces the same
          text without duplicating it visually. */}
      <div className="sr-only" role="status" aria-live="polite">
        {actionFeedback?.text ?? ''}
      </div>
    </div>
  );
};
