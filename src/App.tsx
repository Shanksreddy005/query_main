import { generateEvidenceBasedSummary } from './services/summaryEngine';
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import { Dataset, QueryResult, ApiKeyConfig, HistoryItem, ReasoningStep, OutOfScopeData } from './types';
import { PREBUILT_DATASETS } from './services/sampleData';
import { registerDatasetInSql, executeValidatedSql, cancelCurrentQuery } from './services/sqlEngine';
import { processNaturalLanguageQuery, generateDatasetSuggestions, cancelActiveQueryProcessing } from './services/aiService';
import { CANCELLED_RUN_NOTICE, isUserCancellation } from './services/queryLifecycle';
import { DEFAULT_PROVIDER, DEFAULT_MODELS } from './services/modelRegistry';
import { loadStoredApiKeyConfig, saveApiKeyConfig } from './services/keyStorage';
import { useTheme } from './hooks/useTheme';
import { Header } from './components/Header';
import { Sidebar } from './components/Sidebar';
import { QueryInputArea } from './components/QueryInputArea';
import { ResultsView, type SqlExecutionOutcome } from './components/ResultsView';
import { CsvUploader } from './components/CsvUploader';
import { ApiKeyModal } from './components/ApiKeyModal';
import { OnboardingModal } from './components/OnboardingModal';
import { OutOfScopeModal } from './components/OutOfScopeModal';
import { TelemetryAuditorModal } from './components/TelemetryAuditorModal';
import { ShieldCheck, Upload, Database, AlertCircle, AlertTriangle, Info, FileSpreadsheet, X } from 'lucide-react';

export default function App() {
  const queryRequestIdRef = useRef<number>(0);
  const { preference: themePreference, resolved: themeResolved, cyclePreference } = useTheme();
  const isDarkMode = themeResolved === 'dark';

  // Dataset state (default to preloaded SaaS dataset for instant playground)
  const [activeDataset, setActiveDataset] = useState<Dataset | null>(PREBUILT_DATASETS.saas.dataset);
  const [isUploaderOpen, setIsUploaderOpen] = useState<boolean>(false);

  // BYOK Configuration state (transient in-memory by default; loads from persistent storage only if user explicitly opted in)
  const [apiKeyConfig, setApiKeyConfig] = useState<ApiKeyConfig>(() => {
    const stored = loadStoredApiKeyConfig();
    if (stored) return stored;
    return {
      provider: DEFAULT_PROVIDER,
      key: '',
      model: DEFAULT_MODELS[DEFAULT_PROVIDER],
      rememberKey: false,
    };
  });
  const [isKeyModalOpen, setIsKeyModalOpen] = useState<boolean>(false);
  const [isOnboardingOpen, setIsOnboardingOpen] = useState<boolean>(() => !loadStoredApiKeyConfig()?.key);
  const [isAuditorOpen, setIsAuditorOpen] = useState<boolean>(false);

  // Query & Execution state
  const [query, setQuery] = useState<string>('');
  const [isRunning, setIsRunning] = useState<boolean>(false);
  const [currentStep, setCurrentStep] = useState<ReasoningStep | null>(null);
  const [currentResult, setCurrentResult] = useState<QueryResult | null>(null);
  const [executionError, setExecutionError] = useState<string | null>(null);
  const [datasetNotice, setDatasetNotice] = useState<string | null>(null);
  // A cancelled or abandoned run leaves the workspace unchanged, so nothing on screen says the
  // click had any effect. This carries the one fact the user needs: the run stopped.
  const [runNotice, setRunNotice] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);

  // Out of scope modal state
  const [isOutOfScopeModalOpen, setIsOutOfScopeModalOpen] = useState<boolean>(false);
  const [outOfScopeData, setOutOfScopeData] = useState<OutOfScopeData | null>(null);

  // Mobile sidebar state
  const [isOpenMobileSidebar, setIsOpenMobileSidebar] = useState<boolean>(false);

  // Executive presentation view mode
  const [isPresentationMode, setIsPresentationMode] = useState<boolean>(false);

  // Register initial dataset into SQL engine on mount
  useEffect(() => {
    if (activeDataset) {
      registerDatasetInSql(activeDataset).catch((err) => {
        console.error('[QueryMind] Dataset pre-registration failed:', err);
      });
    }
  }, [activeDataset]);

  // Handle switching datasets
  const handleSelectDataset = (dataset: Dataset, notice?: string) => {
    setActiveDataset(dataset);
    registerDatasetInSql(dataset).catch((err) => {
      setExecutionError(err?.message || 'Failed to load the dataset into the local SQL engine.');
    });
    setQuery('');
    setCurrentResult(null);
    setExecutionError(null);
    setRunNotice(null);
    setDatasetNotice(notice || null);
    setIsUploaderOpen(false);
    setIsOpenMobileSidebar(false);
  };

  // Run natural language query
  const handleRunQuery = async (queryText?: string) => {
    const q = (queryText !== undefined ? queryText : query).trim();
    if (!q || !activeDataset || isRunning) return;

    const currentRequestId = ++queryRequestIdRef.current;
    setIsRunning(true);
    setExecutionError(null);
    setRunNotice(null);
    setCurrentStep({ title: 'Semantic Grounding', detail: 'Analyzing question and schema...', status: 'running' });

    try {
      // Step 1: Process NL Query through AI / smart engine
      const aiResponse = await processNaturalLanguageQuery(
        q,
        activeDataset,
        apiKeyConfig,
        (step) => {
          if (currentRequestId === queryRequestIdRef.current) setCurrentStep(step);
        }
      );
      if (currentRequestId !== queryRequestIdRef.current) return;

      // Check if out-of-scope question was detected
      if (aiResponse.isOutOfScope) {
        setOutOfScopeData({
          question: q,
          reason:
            aiResponse.outOfScopeReason ||
            `This question asks for information outside the scope of dataset "${activeDataset.name}".`,
          suggestedQuestions:
            aiResponse.suggestedQuestions && aiResponse.suggestedQuestions.length > 0
              ? aiResponse.suggestedQuestions
              : generateDatasetSuggestions(activeDataset),
        });
        setIsOutOfScopeModalOpen(true);
        // Exclusively do NOT show reasoning trace, generated SQL, chart, or results table!
        return;
      }

      // Check if query needs clarification (e.g. undefined metrics like lost MRR)
      if (aiResponse.status === 'needs_clarification') {
        const newResult: QueryResult = {
          id: `query_${Date.now()}`,
          question: q,
          sql: '',
          columns: [],
          rows: [],
          rowCount: 0,
          executionTimeMs: 0,
          reasoningSteps: aiResponse.reasoningSteps,
          status: 'needs_clarification',
          clarificationMessage: aiResponse.clarificationMessage,
          insight: aiResponse.insight,
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        };
        setCurrentResult(newResult);
        return;
      }

      const execResult = aiResponse.execution;
      if (aiResponse.status !== 'verified' || !execResult?.success || execResult.truncated) {
        throw new Error('The analysis did not produce a complete verified result.');
      }

      if (currentRequestId !== queryRequestIdRef.current) return;

      const newResult: QueryResult = {
        id: `query_${Date.now()}`,
        question: q,
        sql: execResult.sanitizedSql,
        columns: execResult.columns,
        rows: execResult.rows,
        rowCount: execResult.rowCount,
        executionTimeMs: execResult.executionTimeMs,
        reasoningSteps: aiResponse.reasoningSteps,
        status: aiResponse.status,
        passedChecks: aiResponse.passedChecks,
        queryPlan: aiResponse.queryPlan,
        insight: aiResponse.insight,
        chartSuggestion: aiResponse.chartSuggestion,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      };

      setCurrentResult(newResult);

      // Add to query history
      setHistory((prev) => [
        {
          id: newResult.id,
          question: q,
          sql: newResult.sql,
          datasetName: activeDataset.name,
          rowCount: newResult.rowCount,
          timestamp: newResult.timestamp,
        },
        ...prev.slice(0, 19),
      ]);
    } catch (err: any) {
      if (currentRequestId !== queryRequestIdRef.current) return;
      const message = err?.message || 'An unexpected error occurred while executing the query.';
      // A request the user stopped is not a failure, and a red alert about it teaches the wrong
      // lesson. The previous verified result stays on screen because it still answers its own
      // question, which the results header repeats.
      if (isUserCancellation(message)) {
        setRunNotice(CANCELLED_RUN_NOTICE);
      } else {
        console.error('Query execution error:', err);
        setExecutionError(message);
      }
    } finally {
      if (currentRequestId === queryRequestIdRef.current) {
        setIsRunning(false);
        setCurrentStep(null);
      }
    }
  };

  // Cancel the in-flight query: stop further LLM rounds, terminate the local
  // DuckDB worker, and invalidate any pending result for this request.
  const handleCancelQuery = () => {
    queryRequestIdRef.current += 1;
    cancelActiveQueryProcessing();
    cancelCurrentQuery().catch(() => {});
    setIsRunning(false);
    setCurrentStep(null);
    setRunNotice(CANCELLED_RUN_NOTICE);
  };

  // Re-run modified SQL. The caller needs the outcome, because a resolved promise is not evidence
  // that a new result exists.
  const handleUpdateSql = async (newSql: string): Promise<SqlExecutionOutcome> => {
    if (isRunning) {
      setRunNotice('A query is still running. Stop it before re-executing edited SQL.');
      return 'blocked';
    }
    if (!activeDataset || !currentResult?.queryPlan) {
      setExecutionError(
        'This result carries no verified query plan, so edited SQL cannot be validated against it. Re-run the question instead.'
      );
      return 'rejected';
    }
    setExecutionError(null);
    try {
      const execResult = await executeValidatedSql(newSql, activeDataset, currentResult.queryPlan, currentResult.question);
      if (!execResult.success) {
        setExecutionError(execResult.error || 'The edited SQL could not be verified.');
        return 'rejected';
      }
      if (currentResult) {
        const updatedInsight = generateEvidenceBasedSummary({
          question: currentResult.question,
          sql: execResult.sanitizedSql,
          status: 'verified',
          rows: execResult.rows,
          columns: execResult.columns,
          rowCount: execResult.rowCount,
          datasetName: activeDataset.name,
          tableName: activeDataset.tableName,
          queryPlan: currentResult.queryPlan,
          passedChecks: execResult.passedChecks,
          executionTimeMs: execResult.executionTimeMs,
        });

        setCurrentResult({
          ...currentResult,
          sql: execResult.sanitizedSql,
          columns: execResult.columns,
          rows: execResult.rows,
          rowCount: execResult.rowCount,
          executionTimeMs: execResult.executionTimeMs,
          passedChecks: execResult.passedChecks,
          status: 'verified',
          chartSuggestion: undefined,
          insight: updatedInsight,
        });
      }
      return 'executed';
    } catch (err: any) {
      setExecutionError(err?.message || 'The edited SQL could not be verified.');
      return 'rejected';
    }
  };

  // Insert column name into textarea
  const handleInsertColumn = (colName: string) => {
    setQuery((prev) => (prev ? `${prev} ${colName}` : colName));
  };

  // Run suggested in-scope question from modal
  const handleSelectOutOfScopeSuggestion = (sug: string) => {
    setQuery(sug);
    setIsOutOfScopeModalOpen(false);
    handleRunQuery(sug);
  };

  // Handle completion from 2-step onboarding wizard (Key & Model -> Dataset)
  const handleCompleteOnboarding = (
    config: ApiKeyConfig,
    dataset?: Dataset,
    notice?: string
  ) => {
    setApiKeyConfig(config);
    saveApiKeyConfig(config);
    if (dataset) {
      handleSelectDataset(dataset, notice);
    }
  };

  const mainBg = 'bg-background text-text-primary';

  return (
    <div className={`min-h-screen flex flex-col ${mainBg} transition-colors`}>
      {/* Top Navigation Bar */}
      <Header
        activeDataset={activeDataset}
        onOpenKeyModal={() => setIsKeyModalOpen(true)}
        onOpenUploader={() => setIsUploaderOpen(true)}
        onOpenAuditor={() => setIsAuditorOpen(true)}
        onToggleMobileSidebar={() => setIsOpenMobileSidebar(!isOpenMobileSidebar)}
        isMobileSidebarOpen={isOpenMobileSidebar}
        apiKeyConfig={apiKeyConfig}
        isDarkMode={isDarkMode}
        themePreference={themePreference}
        onCycleThemePreference={cyclePreference}
        isPresentationMode={isPresentationMode}
        onTogglePresentationMode={() => setIsPresentationMode(!isPresentationMode)}
      />

      {/* Main Layout Area */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left Sidebar: Schema Explorer & History */}
        <Sidebar
          dataset={activeDataset}
          onSelectDataset={handleSelectDataset}
          onSelectHistoryQuery={(historyQuery) => {
            setQuery(historyQuery);
            handleRunQuery(historyQuery);
            setIsOpenMobileSidebar(false);
          }}
          history={history}
          onClearHistory={() => setHistory([])}
          isDarkMode={isDarkMode}
          isOpenMobile={isOpenMobileSidebar}
          onCloseMobile={() => setIsOpenMobileSidebar(false)}
          onInsertColumn={handleInsertColumn}
        />

        {/* Content Workspace */}
        <main
          className="flex-1 overflow-y-auto px-4 sm:px-8 py-6 max-w-5xl xl:max-w-6xl mx-auto w-full space-y-6"
          aria-busy={isRunning}
        >
          {/* Uploader Dropdown Modal / View if triggered */}
          {isUploaderOpen && (
            <div className="p-6 rounded-2xl border mb-6 relative animate-in fade-in bg-surface border-border-subtle shadow-md">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <FileSpreadsheet className="w-5 h-5 text-accent" />
                  <h3 className="text-sm font-semibold">Upload Dataset</h3>
                </div>
                <button
                  type="button"
                  onClick={() => setIsUploaderOpen(false)}
                  className="btn-interactive p-1.5 rounded-lg text-text-muted hover:text-text-primary hover:bg-surface-secondary transition-colors duration-fast"
                  aria-label="Close Uploader"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
              <CsvUploader onDatasetLoaded={handleSelectDataset} isDarkMode={isDarkMode} />
            </div>
          )}

          {/* Natural Language Query Area */}
          <QueryInputArea
            query={query}
            onChangeQuery={setQuery}
            onRunQuery={handleRunQuery}
            onCancelQuery={handleCancelQuery}
            isRunning={isRunning}
            activeStep={currentStep}
            dataset={activeDataset}
            hasRunAnyQuery={currentResult !== null}
            isDarkMode={isDarkMode}
          />

          {/* Dataset Import Notice — partial success must not look like a clean load */}
          {datasetNotice && (
            <div role="status" className="p-4 rounded-xl border border-badge-warning-border bg-badge-warning-bg text-badge-warning-fg text-prose flex items-start justify-between gap-3 animate-in fade-in shadow-2xs">
              <div className="flex items-start gap-3">
                <AlertCircle className="w-5 h-5 flex-shrink-0 mt-0.5 text-warning" />
                <div>
                  <span className="font-semibold block text-text-primary">Dataset Import Notice</span>
                  <p className="mt-0.5 text-text-secondary">{datasetNotice}</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setDatasetNotice(null)}
                aria-label="Dismiss dataset notice"
                className="text-text-muted hover:text-text-primary flex-shrink-0"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          )}

          {/* Cancelled or superseded runs change nothing on screen, so the run has to say that
              out loud rather than leave the click looking like it did nothing. */}
          {runNotice && (
            <div role="status" className="p-3.5 rounded-xl border border-badge-info-border bg-badge-info-bg text-badge-info-fg text-prose flex items-start justify-between gap-3 animate-in fade-in shadow-2xs">
              <div className="flex items-start gap-3">
                <Info className="w-4 h-4 flex-shrink-0 mt-0.5 text-info" />
                <span className="text-text-secondary">{runNotice}</span>
              </div>
              <button
                type="button"
                onClick={() => setRunNotice(null)}
                aria-label="Dismiss notice"
                className="text-text-muted hover:text-text-primary flex-shrink-0 rounded focus-ring"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          )}

          {/* Execution Error Banner */}
          {executionError && (
            <div role="alert" className="p-4 rounded-xl border border-badge-error-border bg-badge-error-bg text-badge-error-fg text-prose flex items-start justify-between gap-3 animate-in fade-in shadow-2xs">
              <div className="flex items-start gap-3 text-text-primary">
                <AlertCircle className="w-5 h-5 flex-shrink-0 mt-0.5 text-error" />
                <div>
                  <span className="font-semibold block text-text-primary">Query Notice</span>
                  <p className="mt-0.5 text-text-secondary">{executionError}</p>
                </div>
              </div>
              {(executionError.includes('API Key') || executionError.includes('Settings') || executionError.includes('model') || executionError.includes('HTTP')) && (
                <button
                  type="button"
                  onClick={() => setIsKeyModalOpen(true)}
                  className="btn-interactive px-3 py-1.5 rounded-lg bg-accent hover:bg-accent-hover text-accent-ink font-medium text-xs flex-shrink-0 shadow-xs whitespace-nowrap focus-ring"
                >
                  Open Settings
                </button>
              )}
            </div>
          )}

          {/* Results View: Reasoning Trace, AI Insights, Charts, SQL & Table */}
          {currentResult && (
            <ResultsView
              result={currentResult}
              isDarkMode={isDarkMode}
              onUpdateSql={handleUpdateSql}
              onOpenAuditor={() => setIsAuditorOpen(true)}
              dataset={activeDataset}
              isPresentationMode={isPresentationMode}
              onTogglePresentationMode={() => setIsPresentationMode(!isPresentationMode)}
            />
          )}
        </main>
      </div>

      {/* BYOK Modal */}
      <ApiKeyModal
        isOpen={isKeyModalOpen}
        onClose={() => setIsKeyModalOpen(false)}
        config={apiKeyConfig}
        onSave={(newConfig) => {
          setApiKeyConfig(newConfig);
          saveApiKeyConfig(newConfig);
        }}
        isDarkMode={isDarkMode}
      />

      {/* Out of Scope Error Popup Modal */}
      <OutOfScopeModal
        isOpen={isOutOfScopeModalOpen}
        onClose={() => setIsOutOfScopeModalOpen(false)}
        data={outOfScopeData}
        dataset={activeDataset}
        onSelectSuggestion={handleSelectOutOfScopeSuggestion}
        isDarkMode={isDarkMode}
      />

      {/* 2-Step Client-Side Onboarding Wizard (Key & Model Selection -> Dataset) */}
      <OnboardingModal
        isOpen={isOnboardingOpen}
        onClose={() => setIsOnboardingOpen(false)}
        onComplete={handleCompleteOnboarding}
        activeDataset={activeDataset}
        currentConfig={apiKeyConfig}
        isDarkMode={isDarkMode}
      />

      {/* Telemetry & Privacy Auditor Modal */}
      <TelemetryAuditorModal
        isOpen={isAuditorOpen}
        onClose={() => setIsAuditorOpen(false)}
        isDarkMode={isDarkMode}
        datasetName={activeDataset?.name}
        datasetRowCount={activeDataset?.rowCount}
      />
    </div>
  );
}

