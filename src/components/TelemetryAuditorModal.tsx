import React, { useState, useEffect, useRef } from 'react';
import { 
  ShieldCheck, 
  X, 
  Copy, 
  Check, 
  Lock, 
  ServerOff, 
  Network, 
  FileCode, 
  CheckCircle2, 
  AlertTriangle,
  ExternalLink,
  Clock,
  ArrowRight
} from 'lucide-react';
import { telemetryAuditor, TelemetryAuditEvent } from '../services/telemetryAuditor';
import { useDialogA11y } from '../hooks/useDialogA11y';

interface TelemetryAuditorModalProps {
  isOpen: boolean;
  onClose: () => void;
  isDarkMode: boolean;
  datasetName?: string;
  datasetRowCount?: number;
}

export const TelemetryAuditorModal: React.FC<TelemetryAuditorModalProps> = ({
  isOpen,
  onClose,
  isDarkMode,
  datasetName,
  datasetRowCount = 0,
}) => {
  const [events, setEvents] = useState<TelemetryAuditEvent[]>([]);
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'payload' | 'isolation' | 'compliance'>('payload');
  const [copied, setCopied] = useState<boolean>(false);

  useEffect(() => {
    const unsubscribe = telemetryAuditor.subscribe((newEvents) => {
      setEvents(newEvents);
      if (newEvents.length > 0 && !selectedEventId) {
        setSelectedEventId(newEvents[0].id);
      }
    });
    return unsubscribe;
  }, [selectedEventId]);

  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogA11y({ isOpen, containerRef: dialogRef, onClose });

  if (!isOpen) return null;

  const currentEvent = events.find((e) => e.id === selectedEventId) || events[0] || null;

  // Evidence-based egress status derived from per-payload leakage audits
  // (wire payload scanned against real dataset rows at dispatch time).
  const auditedEvents = events.filter((e) => e.leakageAudit);
  const leakageDetected = auditedEvents.some((e) => e.leakageAudit && !e.leakageAudit.isSafe);
  const allAuditsPassed = auditedEvents.length > 0 && auditedEvents.every((e) => e.leakageAudit?.isSafe);

  const handleCopyPayload = () => {
    if (!currentEvent) return;
    const payloadText = JSON.stringify(
      {
        endpoint: currentEvent.endpointUrl,
        provider: currentEvent.provider,
        model: currentEvent.model,
        networkTopology: currentEvent.networkTopology,
        rawRowsIncluded: currentEvent.dataRowsIncludedCount,
        schemaAttributes: currentEvent.schemaAttributesIncluded,
        columnCount: currentEvent.columnCount,
        promptCharCount: currentEvent.promptCharCount,
        systemPromptCharCount: currentEvent.systemPromptCharCount,
        payloadSizeBytes: currentEvent.egressPayloadSizeBytes,
      },
      null,
      2
    );

    navigator.clipboard.writeText(payloadText);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-scrim backdrop-blur-xs animate-in fade-in duration-200">
      <div
        ref={dialogRef}
        className="relative w-full max-w-4xl max-h-[92vh] flex flex-col rounded-2xl border shadow-2xl overflow-hidden bg-surface border-border-strong text-text-primary"
        role="dialog"
        aria-modal="true"
        aria-labelledby="auditor-title"
        tabIndex={-1}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 sm:px-6 py-4 border-b border-border-subtle bg-surface-secondary/70">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-badge-success-bg border border-badge-success-border text-success shadow-2xs">
              <ShieldCheck className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 id="auditor-title" className="text-heading font-semibold">
                  Telemetry & Privacy Auditor
                </h2>
                {leakageDetected ? (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full  text-meta font-semibold bg-badge-error-bg text-badge-error-fg border border-badge-error-border">
                    <span className="w-1.5 h-1.5 rounded-full bg-error animate-pulse" />
                    Dataset Value Leakage Detected
                  </span>
                ) : allAuditsPassed ? (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full  text-meta font-semibold bg-badge-success-bg text-badge-success-fg border border-badge-success-border">
                    <span className="w-1.5 h-1.5 rounded-full bg-success animate-pulse" />
                    Sample Scan Clear ({auditedEvents.length} checked); Full Egress Unverified
                  </span>
                ) : events.length > 0 ? (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full  text-meta font-semibold bg-badge-warning-bg text-badge-warning-fg border border-badge-warning-border">
                    <span className="w-1.5 h-1.5 rounded-full bg-warning animate-pulse" />
                    Egress Audit Unverified
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full  text-meta font-semibold bg-badge-info-bg text-badge-info-fg border border-badge-info-border">
                    <span className="w-1.5 h-1.5 rounded-full bg-info" />
                    No Outbound Traffic Yet
                  </span>
                )}
              </div>
              <p className="text-xs text-text-muted mt-0.5">
                Inspect recorded request metadata and sampled value scans. Provider retention is not verified.
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-text-muted hover:text-text-primary hover:bg-surface-elevated transition-colors duration-fast focus-ring"
            aria-label="Close Modal"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Audit Metrics Banner */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-3 p-4 sm:px-6 bg-surface border-b border-border-subtle text-xs">
          {/* Card 1: Rows Transmitted */}
          <div className="p-3 rounded-xl border border-badge-success-border bg-badge-success-bg/40 flex flex-col justify-between">
            <span className="text-meta font-medium text-text-muted flex items-center gap-1.5">
              <Lock className="w-3.5 h-3.5 text-success" />
              Rows Transmitted
            </span>
            <div className="mt-1 flex items-baseline gap-1">
              <span className="text-sm font-semibold font-mono text-text-primary">Unverified</span>
              <span className="text-meta tabular-nums text-text-muted">/ {datasetRowCount.toLocaleString()} rows</span>
            </div>
            <span className="text-meta font-medium text-text-muted mt-0.5">Dataset and result egress not proven</span>
          </div>

          {/* Card 2: Outbound Payload Size */}
          <div className="p-3 rounded-xl border border-border-strong bg-surface-secondary flex flex-col justify-between">
            <span className="text-meta font-medium text-text-muted flex items-center gap-1.5">
              <FileCode className="w-3.5 h-3.5 text-accent" />
              Packet Egress Size
            </span>
            <div className="mt-1">
              <span className="text-display font-semibold font-mono text-text-primary">
                {currentEvent ? `${(currentEvent.egressPayloadSizeBytes / 1024).toFixed(1)} KB` : '0 KB'}
              </span>
            </div>
            <span className="text-meta text-text-muted mt-0.5">Metadata & Prompt only</span>
          </div>

          {/* Card 3: Network Topology */}
          <div className="p-3 rounded-xl border border-border-strong bg-surface-secondary flex flex-col justify-between">
            <span className="text-meta font-medium text-text-muted flex items-center gap-1.5">
              <Network className="w-3.5 h-3.5 text-text-muted" />
              Network Architecture
            </span>
            <div className="mt-1">
              <span className="text-sm font-semibold text-text-primary font-mono truncate block">
                Direct Client Fetch
              </span>
            </div>
            <span className="text-meta text-success font-medium mt-0.5">0 Intermediary Proxies</span>
          </div>

          {/* Card 4: Target Gateway */}
          <div className="p-3 rounded-xl border border-border-strong bg-surface-secondary flex flex-col justify-between">
            <span className="text-meta font-medium text-text-muted flex items-center gap-1.5">
              <ServerOff className="w-3.5 h-3.5 text-text-muted" />
              Target Gateway
            </span>
            <div className="mt-1">
              <span className="text-xs font-mono font-medium truncate block text-text-secondary" title={currentEvent?.endpointUrl || 'Awaiting query'}>
                {currentEvent ? new URL(currentEvent.endpointUrl).hostname : 'None active'}
              </span>
            </div>
            <span className="text-meta text-text-muted mt-0.5">
              {currentEvent?.provider.toUpperCase() || 'IDLE'} BYOK
            </span>
          </div>
        </div>

        {/* Tab Navigation */}
        <div className="flex items-center justify-between px-5 sm:px-6 pt-3 border-b border-border-subtle bg-surface">
          <div className="flex flex-wrap gap-1">
            <button
              type="button"
              onClick={() => setActiveTab('payload')}
              aria-pressed={activeTab === 'payload'}
              className={`px-3.5 py-2 text-xs font-medium rounded-t-lg transition-colors border-b-2 -mb-px flex items-center gap-1.5 focus-ring ${
                activeTab === 'payload'
                  ? 'border-accent text-accent font-semibold bg-surface-secondary'
                  : 'border-transparent text-text-muted hover:text-text-primary'
              }`}
            >
              <FileCode className="w-3.5 h-3.5" />
              Outbound Payload
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('isolation')}
              aria-pressed={activeTab === 'isolation'}
              className={`px-3.5 py-2 text-xs font-medium rounded-t-lg transition-colors border-b-2 -mb-px flex items-center gap-1.5 focus-ring ${
                activeTab === 'isolation'
                  ? 'border-accent text-accent font-semibold bg-surface-secondary'
                  : 'border-transparent text-text-muted hover:text-text-primary'
              }`}
            >
              <Lock className="w-3.5 h-3.5" />
              Schema vs Row Isolation
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('compliance')}
              aria-pressed={activeTab === 'compliance'}
              className={`px-3.5 py-2 text-xs font-medium rounded-t-lg transition-colors border-b-2 -mb-px flex items-center gap-1.5 focus-ring ${
                activeTab === 'compliance'
                  ? 'border-accent text-accent font-semibold bg-surface-secondary'
                  : 'border-transparent text-text-muted hover:text-text-primary'
              }`}
            >
              <CheckCircle2 className="w-3.5 h-3.5" />
              Compliance Badges
            </button>
          </div>

          {activeTab === 'payload' && currentEvent && (
            <button
              type="button"
              onClick={handleCopyPayload}
              className="flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-md border border-border-strong bg-surface-secondary text-text-secondary hover:text-text-primary hover:bg-surface-elevated transition-colors shadow-2xs focus-ring"
            >
              {copied ? <Check className="w-3.5 h-3.5 text-success" /> : <Copy className="w-3.5 h-3.5" />}
              <span>{copied ? 'Copied' : 'Copy JSON'}</span>
            </button>
          )}
        </div>

        {/* Tab Content Area */}
        <div
          role="region"
          aria-label="Audit details"
          tabIndex={0}
          className="flex-1 overflow-y-auto p-4 sm:p-6 bg-surface min-h-[300px] max-h-[500px] focus-ring"
        >
          {/* TAB 1: Outbound Payload Raw Inspector */}
          {activeTab === 'payload' && (
            <div className="space-y-4">
              {currentEvent ? (
                <>
                  <div className="flex items-center justify-between text-xs text-text-muted pb-1">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-text-primary font-medium">{currentEvent.endpointUrl}</span>
                      <span className="text-meta px-1.5 py-0.5 rounded bg-surface-secondary text-text-muted font-mono">POST</span>
                    </div>
                    {currentEvent.latencyMs && (
                      <span className="flex items-center gap-1 text-meta text-text-muted font-mono">
                        <Clock className="w-3 h-3" />
                        {currentEvent.latencyMs}ms
                      </span>
                    )}
                  </div>

                  {currentEvent.leakageAudit ? (
                    <div className={`p-3 rounded-xl border text-xs flex items-center gap-2 ${
                      currentEvent.leakageAudit.isSafe
                        ? 'bg-badge-success-bg/40 border-badge-success-border text-success'
                        : 'bg-badge-error-bg/40 border-badge-error-border text-error'
                    }`}>
                      {currentEvent.leakageAudit.isSafe ? (
                        <CheckCircle2 className="w-4 h-4 shrink-0" />
                      ) : (
                        <AlertTriangle className="w-4 h-4 shrink-0" />
                      )}
                      <span>
                        {currentEvent.leakageAudit.isSafe
                          ? `String-value scan across ${currentEvent.leakageAudit.rowsScanned} sampled rows found none of them inside the prompt's schema block${currentEvent.leakageAudit.scanScope === 'whole_payload' ? ' (this payload carried no schema block markers, so the whole payload was scanned)' : ''}${currentEvent.leakageAudit.matchesOutsideSchema.length > 0 ? `. ${currentEvent.leakageAudit.matchesOutsideSchema.length} value(s) matched only the fixed planner guidance or your own question (${currentEvent.leakageAudit.matchesOutsideSchema.slice(0, 3).join(', ')}); those are not importer egress` : ''}. Numeric values, remaining rows, complete results, and provider retention are unverified.`
                          : `Leakage audit failed: dataset values appear inside the prompt's schema block — ${currentEvent.leakageAudit.leakedFields.slice(0, 3).join(', ')}`}
                      </span>
                    </div>
                  ) : (
                    <div className="p-3 rounded-xl border border-badge-warning-border bg-badge-warning-bg/40 text-xs text-badge-warning-fg flex items-center gap-2">
                      <AlertTriangle className="w-4 h-4 shrink-0" />
                      <span>Leakage audit not run for this dispatch (no dataset context was available).</span>
                    </div>
                  )}

                  <div className="p-3.5 rounded-xl border border-border-strong bg-surface-secondary font-mono text-xs overflow-x-auto leading-relaxed text-text-secondary selection:bg-accent/20">
                    <pre className="whitespace-pre-wrap">
                      {JSON.stringify(
                        {
                          security_assertion: {
                            provider_retention: 'unverified',
                            dataset_row_egress: 'unverified',
                            query_result_egress: 'unverified',
                            sampled_string_scan: currentEvent.leakageAudit,
                            data_rows_transferred: currentEvent.dataRowsIncludedCount,
                            dataset_name: datasetName || 'active_table',
                            network_transport: "DIRECT_CLIENT_BROWSER_FETCH",
                            intermediary_server_count: 0
                          },
                          request_headers: {
                            "Content-Type": "application/json",
                            "Authorization": currentEvent.provider === 'gemini' ? "x-goog-api-key: [REDACTED_BYOK_KEY]" : "Bearer [REDACTED_BYOK_KEY]"
                          },
                          operational_metadata: {
                            model: currentEvent.model,
                            prompt_character_count: currentEvent.promptCharCount,
                            system_character_count: currentEvent.systemPromptCharCount,
                            schema_column_count: currentEvent.columnCount,
                            schema_columns: currentEvent.schemaAttributesIncluded,
                            egress_payload_size_bytes: currentEvent.egressPayloadSizeBytes
                          }
                        },
                        null,
                        2
                      )}
                    </pre>
                  </div>
                </>
              ) : (
                <div className="text-center py-12 text-text-muted">
                  <ShieldCheck className="w-8 h-8 mx-auto mb-2 text-text-muted opacity-40" />
                  <p className="text-sm font-medium">No external LLM calls logged yet.</p>
                  <p className="text-xs text-text-muted mt-1">
                    When you submit a natural language query, the exact payload sent directly from your browser to your AI provider will appear here.
                  </p>
                </div>
              )}
            </div>
          )}

          {/* TAB 2: Schema vs Row Data Isolation Matrix */}
          {activeTab === 'isolation' && (
            <div className="space-y-4">
              <div className="p-3 rounded-xl bg-badge-accent-bg/40 border border-badge-accent-border text-xs flex items-center justify-between">
                <span className="text-text-primary font-medium">
                  Privacy boundary: the question and schema-level statistics cross the browser origin; stored rows and query results do not.
                </span>
                <span className="font-mono text-accent text-meta font-semibold">DuckDB-WASM Sandbox</span>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {/* Left: What Stays Local */}
                <div className="p-4 rounded-xl border border-success/30 bg-success/5 space-y-2">
                  <div className="flex items-center gap-2 text-sm font-semibold text-success">
                    <CheckCircle2 className="w-4 h-4" />
                    <span>DESIGNED FOR LOCAL PROCESSING</span>
                  </div>
                  <ul className="text-prose text-text-secondary space-y-1.5 list-disc pl-4">
                    <li><strong className="text-text-primary">{datasetRowCount.toLocaleString()} Raw Data Rows</strong> (parsed and queried only in this browser)</li>
                    <li>Individual records, row order and any pairing of a value with an entity</li>
                    <li>Query results returned by DuckDB-WASM</li>
                    <li>Customer names, emails, and personal identifiers</li>
                    <li>Full CSV, TSV, or JSON source file contents</li>
                    <li>In-memory DuckDB table caches and query execution buffers</li>
                  </ul>
                </div>

                {/* Right: What Leaves Browser */}
                <div className="p-4 rounded-xl border border-border-strong bg-surface-secondary space-y-2">
                  <div className="flex items-center gap-2 text-sm font-semibold text-accent">
                    <ArrowRight className="w-4 h-4" />
                    <span>EGRESS TO AI PROVIDER (STRUCTURAL ONLY)</span>
                  </div>
                  <ul className="text-prose text-text-secondary space-y-1.5 list-disc pl-4">
                    <li>Natural language question typed by user</li>
                    <li>Table name and total row count (<code className="text-meta bg-surface px-1 py-0.5 rounded">{datasetRowCount.toLocaleString()}</code> here)</li>
                    <li>Column names (e.g. <code className="text-meta bg-surface px-1 py-0.5 rounded">mrr</code>, <code className="text-meta bg-surface px-1 py-0.5 rounded">plan_tier</code>)</li>
                    <li>Inferred data types and assigned roles (<code className="text-meta bg-surface px-1 py-0.5 rounded">INTEGER</code>, <code className="text-meta bg-surface px-1 py-0.5 rounded">VARCHAR</code>, measure / dimension / identifier)</li>
                    <li>Distinct-value counts per column (e.g. <code className="text-meta bg-surface px-1 py-0.5 rounded">Distinct: 4</code>)</li>
                    <li>{datasetRowCount >= 10
                      ? <>Numeric min/max ranges per measure column (<code className="text-meta bg-surface px-1 py-0.5 rounded">Range: min to max</code>) — sent because at least 10 rows sit behind them</>
                      : 'Numeric min/max ranges are withheld for this table; on a table this small a range can identify individual rows'}</li>
                    <li>Real categorical cell values are replaced with synthetic labels such as <code className="text-meta bg-surface px-1 py-0.5 rounded">"Category_A"</code></li>
                    <li>Canonical SQL blueprint patterns for DuckDB syntax</li>
                  </ul>
                </div>
              </div>
            </div>
          )}

          {/* TAB 3: Compliance Certification */}
          {activeTab === 'compliance' && (
            <div className="space-y-3">
              <div className="p-3.5 rounded-xl border border-border-strong bg-surface-secondary">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-semibold text-text-primary">Data Minimization Architecture</span>
                  <span className="text-meta px-2 py-0.5 rounded-full font-medium bg-badge-info-bg text-badge-info-fg border border-badge-info-border">Architecture Property</span>
                </div>
                <p className="text-prose text-text-muted mt-1">
                  Dataset processing is designed to remain local. Questions and schema metadata are sent to the configured AI provider; user-entered questions may contain personal information. The sampled scan does not establish legal compliance or prove zero data transfer.
                </p>
              </div>

              <div className="p-3.5 rounded-xl border border-border-strong bg-surface-secondary">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-semibold text-text-primary">Zero Server Footprint</span>
                  <span className="text-meta px-2 py-0.5 rounded-full font-medium bg-badge-info-bg text-badge-info-fg border border-badge-info-border">Architecture Property</span>
                </div>
                <p className="text-prose text-text-muted mt-1">
                  QueryMind operates without cloud databases, logging intermediaries, or analytics telemetry relays of its own. SQL execution runs in a local DuckDB-WASM worker. Static assets are served by this site, and the DuckDB engine binaries come from the owner's own storage domain, so the application requests no third-party analytics host; requests the hosting layer makes on its own are outside this app's control. What your configured provider stores, and for how long, is governed by that provider and is not verified here.
                </p>
              </div>

              <div className="p-3.5 rounded-xl border border-border-strong bg-surface-secondary">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-semibold text-text-primary">Local Processing Boundary</span>
                  <span className="text-meta px-2 py-0.5 rounded-full font-medium bg-badge-info-bg text-badge-info-fg border border-badge-info-border">Architecture Property</span>
                </div>
                <p className="text-prose text-text-muted mt-1">
                  SQL executes locally, and complete query results are not intentionally included in planning prompts. The selected string-value scan covers at most 100 dataset rows and does not prove numeric or result egress. The configured provider receives request metadata, including your IP address.
                </p>
              </div>

              <div className="p-3.5 rounded-xl border border-border-strong bg-surface-secondary">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-semibold text-text-primary">BYOK Direct Unproxied Transport</span>
                  <span className="text-meta px-2 py-0.5 rounded-full font-medium bg-badge-success-bg text-badge-success-fg border border-badge-success-border">No Proxy Relay</span>
                </div>
                <p className="text-prose text-text-muted mt-1">
                  Connections flow directly from the browser's network stack to Google, Groq, or OpenAI endpoints using user-provided API credentials.
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Modal Footer */}
        <div className="flex items-center justify-between px-5 sm:px-6 py-3 border-t border-border-subtle bg-surface-secondary/70 text-xs">
          <div className="flex items-center gap-2 text-text-muted">
            <span className="w-2 h-2 rounded-full bg-success" />
            <span>Auditor Active (Tracking Session Dispatches)</span>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="px-4 py-1.5 rounded-lg text-xs font-medium border border-border-strong bg-surface hover:bg-surface-elevated text-text-primary shadow-2xs transition-colors focus-ring"
          >
            Close Inspector
          </button>
        </div>
      </div>
    </div>
  );
};
