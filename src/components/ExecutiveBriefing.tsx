import React from 'react';
import {
  AnalyticalCategory,
  AnomalyObservation,
  BusinessImplication,
  KeyFinding,
  QueryInsight,
  RecommendedAction,
} from '../types';

export interface InsightsPayload extends Partial<QueryInsight> {
  executive_summary?: string;
  critical_anomalies?: string[];
  business_implications?: (BusinessImplication | string)[];
  strategic_experiments?: string[];
  // Backwards compatibility with standard QueryInsight
  summary?: string;
  highlights?: string[];
  caveats?: string[];
  recommendedAction?: string;
  performance_comparison?: string[];
}

export interface BriefingProps {
  insightsPayload: InsightsPayload;
  isDarkMode?: boolean;
  // The results view surfaces this sentence in the answer band; rendering it twice in the same
  // scroll sequence would repeat the finding word for word.
  hideSummary?: boolean;
}

// Banned generic boilerplates that must NEVER be rendered in QueryMind summaries
const BANNED_BOILERPLATES: RegExp[] = [
  /audit downstream data pipelines/i,
  /review commercial thresholds prior to capital deployment/i,
  /review variance thresholds against historical quarterly trends/i,
  /all verified metrics conform to expected baseline constraints/i,
  /data scope is bounded to active table filters/i,
  /prior to capital deployment/i,
  /fiscal reporting cycles/i,
];

function isCleanText(text: string): boolean {
  if (!text || text.trim().length === 0) return false;
  return !BANNED_BOILERPLATES.some((regex) => regex.test(text));
}

// Single owner of the primary finding sentence, so the answer band and the briefing cannot drift.
export function resolveBriefingSummary(payload: InsightsPayload): string {
  const raw = payload.overview || payload.executive_summary || payload.summary || '';
  return isCleanText(raw) ? raw : 'Analytical query execution verified against local dataset.';
}

export function ExecutiveBriefing({ insightsPayload, isDarkMode = true, hideSummary = false }: BriefingProps) {
  // 1. Primary Overview Text
  const summaryText = resolveBriefingSummary(insightsPayload);

  // 2. Key Findings: only ground-truth findings from data
  let rawFindings: string[] = [];
  if (insightsPayload.key_findings && insightsPayload.key_findings.length > 0) {
    rawFindings = insightsPayload.key_findings.map((f) => f.finding);
  } else if (insightsPayload.findings && insightsPayload.findings.length > 0) {
    rawFindings = insightsPayload.findings;
  } else if (insightsPayload.highlights && insightsPayload.highlights.length > 0) {
    rawFindings = insightsPayload.highlights;
  }
  const findings = rawFindings.filter(isCleanText);

  // 3. Performance Comparison: comparative breakdown across categories
  const rawComparisons = insightsPayload.performance_comparison || [];
  const comparisons = rawComparisons.filter(isCleanText);

  // 4. Anomalies: only verified data issues (NEVER default to static boilerplate or highlights)
  let rawAnomalies: string[] = [];
  if (insightsPayload.anomalies && insightsPayload.anomalies.length > 0) {
    rawAnomalies = insightsPayload.anomalies.map((a) => (typeof a === 'string' ? a : a.observation));
  } else if (insightsPayload.critical_anomalies && insightsPayload.critical_anomalies.length > 0) {
    rawAnomalies = insightsPayload.critical_anomalies;
  }
  const anomalies = rawAnomalies.filter(isCleanText);

  // 5. Business Implications: grounded observations only
  let rawImplications: string[] = [];
  if (insightsPayload.business_implications && insightsPayload.business_implications.length > 0) {
    rawImplications = insightsPayload.business_implications.map((i) =>
      typeof i === 'string' ? i : i.implication
    );
  } else if (insightsPayload.caveats && insightsPayload.caveats.length > 0) {
    rawImplications = insightsPayload.caveats;
  } else if (insightsPayload.risks && insightsPayload.risks.length > 0) {
    rawImplications = insightsPayload.risks;
  }
  const implications = rawImplications.filter(isCleanText);

  // 6. Recommended Actions: strictly optional and context-aware
  let rawActions: string[] = [];
  if (insightsPayload.recommended_actions && insightsPayload.recommended_actions.length > 0) {
    rawActions = insightsPayload.recommended_actions.map((a) => a.action);
  } else if (insightsPayload.strategic_experiments && insightsPayload.strategic_experiments.length > 0) {
    rawActions = insightsPayload.strategic_experiments;
  } else if (insightsPayload.recommendedAction) {
    rawActions = [insightsPayload.recommendedAction];
  } else if (insightsPayload.recommended_action) {
    rawActions = [insightsPayload.recommended_action];
  }
  const actions = rawActions.filter(isCleanText);

  // 7. Limitations: analytical boundaries
  const limitations = (insightsPayload.limitations || []).filter(isCleanText);

  const hasFindings = findings.length > 0;
  const hasComparisons = comparisons.length > 0;
  const hasAnomalies = anomalies.length > 0;
  const hasImplications = implications.length > 0;
  const hasActions = actions.length > 0;
  const hasLimitations = limitations.length > 0;

  return (
    <div className="border border-border-subtle bg-surface-secondary/70 rounded-xl text-text-primary overflow-hidden shadow-xs font-sans transition-colors duration-fast">
      {/* Component Header Bar */}
      <div className="bg-surface border-b border-border-subtle px-5 py-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-accent text-sm font-semibold">Executive Analysis Summary</span>
          {insightsPayload.category && (
            <span className="text-meta font-mono px-2 py-0.5 rounded-full bg-surface-secondary border border-border-strong text-text-secondary uppercase">
              {insightsPayload.category.replace(/_/g, ' ')}
            </span>
          )}
        </div>
        <span className="text-meta text-text-muted font-mono">EVIDENCE GROUNDED · CLIENT-SIDE</span>
      </div>

      <div className="p-4 sm:p-5 space-y-4">
        {/* Core Summary Overview — omitted when the results answer band already shows this sentence */}
        {!hideSummary && (
          <div className="border-l-2 border-accent pl-4 py-0.5">
            <p className="text-prose font-medium text-text-primary">
              {summaryText}
            </p>
          </div>
        )}

        {/* Key Findings List (adaptive: displayed only when verified findings exist) */}
        {hasFindings && (
          <div className="space-y-2">
            <h5 className="text-meta font-semibold uppercase text-text-secondary flex items-center gap-1.5">
              <span><span aria-hidden="true">📊 </span>Key Findings</span>
            </h5>
            <ul className="space-y-1.5">
              {findings.map((item, idx) => (
                <li key={idx} className="text-prose text-text-secondary flex items-start gap-2">
                  <span className="text-accent font-bold mt-0.5">•</span>
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Performance Comparison (adaptive: displayed when comparative breakdown exists) */}
        {hasComparisons && (
          <div className="space-y-2 pt-3 border-t border-border-subtle/60">
            <h5 className="text-meta font-semibold uppercase text-text-secondary flex items-center gap-1.5">
              <span><span aria-hidden="true">⚖️ </span>Performance Comparison</span>
            </h5>
            <ul className="space-y-1.5">
              {comparisons.map((item, idx) => (
                <li key={idx} className="text-prose text-text-secondary flex items-start gap-2">
                  <span className="text-accent font-bold mt-0.5">•</span>
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* 2-Column Grid for Anomalies and Implications (omitted if both are empty) */}
        {(hasAnomalies || hasImplications) && (
          <div className={`grid grid-cols-1 ${hasAnomalies && hasImplications ? 'md:grid-cols-2' : ''} gap-4 pt-3 border-t border-border-subtle/60`}>
            {/* Column 1: Found Anomalies (omitted if none found) */}
            {hasAnomalies && (
              <div className="space-y-2">
                <h5 className="text-meta font-semibold uppercase text-error flex items-center gap-1.5">
                  <span><span aria-hidden="true">🛑 </span>Anomalies & Data Quality</span>
                </h5>
                <ul className="space-y-1.5">
                  {anomalies.map((item, idx) => (
                    <li key={idx} className="text-prose text-text-secondary flex items-start gap-2">
                      <span className="text-error font-bold mt-0.5">•</span>
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {/* Column 2: Business Implications (omitted if none found) */}
            {hasImplications && (
              <div className="space-y-2">
                <h5 className="text-meta font-semibold uppercase text-warning flex items-center gap-1.5">
                  <span><span aria-hidden="true">💼 </span>Business Implications</span>
                </h5>
                <ul className="space-y-1.5">
                  {implications.map((item, idx) => (
                    <li key={idx} className="text-prose text-text-secondary flex items-start gap-2">
                      <span className="text-warning font-bold mt-0.5">•</span>
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {/* Recommended Actions Row (strictly omitted when 0 actions exist) */}
        {hasActions && (
          <div className="space-y-2 pt-3 border-t border-border-subtle/60">
            <h5 className="text-meta font-semibold uppercase text-text-primary flex items-center gap-1.5">
              <span><span aria-hidden="true">🎯 </span>Recommended Next Actions</span>
            </h5>
            <ol className="space-y-1.5">
              {actions.map((item, idx) => (
                <li key={idx} className="text-prose text-text-secondary flex gap-2.5">
                  <span className="font-mono text-meta tabular-nums text-text-muted self-start">
                    {idx + 1}.
                  </span>
                  <span className="mt-0.5">{item}</span>
                </li>
              ))}
            </ol>
          </div>
        )}

        {/* Analytical Limitations Row (strictly omitted when none exist) */}
        {hasLimitations && (
          <div className="text-prose text-text-muted border-t border-border-subtle/50 pt-3 flex items-start gap-1.5">
            <span className="font-semibold text-text-secondary">Limitations:</span>
            <span>{limitations.join(' ')}</span>
          </div>
        )}
      </div>
    </div>
  );
}
