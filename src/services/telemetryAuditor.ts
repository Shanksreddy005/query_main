import { AiProvider } from '../types';

export interface TelemetryAuditEvent {
  id: string;
  timestamp: number;
  provider: AiProvider;
  model: string;
  endpointUrl: string;
  egressPayloadSizeBytes: number;
  dataRowsIncludedCount: null;
  promptCharCount: number;
  systemPromptCharCount: number;
  columnCount: number;
  schemaAttributesIncluded: string[];
  networkTopology: 'DIRECT_CLIENT_BROWSER_FETCH';
  latencyMs?: number;
  status: 'pending' | 'success' | 'error';
  httpStatus?: number;
  error?: string;
  privacyPolicies: string[];
  wirePayloadString?: string;
  /** Evidence-based egress audit: wire payload scanned against real dataset rows. */
  leakageAudit?: {
    isSafe: boolean;
    leakedFields: string[];
    matchesOutsideSchema: string[];
    scanScope: 'schema_block' | 'whole_payload';
    rowsScanned: number;
  } | null;
}

type Listener = (events: TelemetryAuditEvent[]) => void;

/**
 * Bounds of the schema description block inside the planning prompt. The leakage scan treats
 * content between them as the only region this app fills with dataset-derived text.
 */
const SCHEMA_BLOCK_START = 'measures / metrics';
const SCHEMA_BLOCK_END = 'sql generation blueprints';

class TelemetryAuditorService {
  private events: TelemetryAuditEvent[] = [];
  private listeners: Set<Listener> = new Set();
  private maxEvents = 50;
  private captureWirePayloadInEvents = false;

  constructor() {
    // Initialize with a default ready state
  }

  /**
   * Diagnostic hook for isolated automated tests.
   * In production, wire payloads are strictly not retained in memory.
   */
  public setCaptureWirePayloadForTesting(enabled: boolean): void {
    this.captureWirePayloadInEvents = enabled;
  }

  public getHistory(): TelemetryAuditEvent[] {
    return [...this.events];
  }

  public getLatestEvent(): TelemetryAuditEvent | null {
    return this.events.length > 0 ? this.events[0] : null;
  }

  public subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    listener(this.getHistory());
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify() {
    const history = this.getHistory();
    this.listeners.forEach((l) => l(history));
  }

  public recordOutboundDispatch(params: {
    provider: AiProvider;
    model: string;
    endpointUrl: string;
    userPrompt: string;
    systemPrompt: string;
    schemaColumns: string[];
    requestBody: any;
    datasetRows?: Record<string, any>[];
  }): string {
    const eventId = `audit_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const payloadString = typeof params.requestBody === 'string' ? params.requestBody : JSON.stringify(params.requestBody);
    const byteSize = new Blob([payloadString]).size;

    // Evidence-based egress verification: scan the exact wire payload against
    // real dataset rows. Without dataset context the audit cannot run and the
    // event is explicitly marked unverified rather than assumed safe.
    const leakageAudit = params.datasetRows
      ? (() => {
          const result = this.verifyPayloadDataLeakage(payloadString, params.datasetRows!);
          return { ...result, rowsScanned: Math.min(params.datasetRows!.length, 100) };
        })()
      : null;

    const newEvent: TelemetryAuditEvent = {
      id: eventId,
      timestamp: Date.now(),
      provider: params.provider,
      model: params.model,
      endpointUrl: params.endpointUrl,
      egressPayloadSizeBytes: byteSize,
      dataRowsIncludedCount: null,
      promptCharCount: params.userPrompt.length,
      systemPromptCharCount: params.systemPrompt.length,
      columnCount: params.schemaColumns.length,
      schemaAttributesIncluded: [...params.schemaColumns],
      networkTopology: 'DIRECT_CLIENT_BROWSER_FETCH',
      status: 'pending',
      privacyPolicies: [
        'Zero Raw Record Egress Policy (Metadata Only)',
        'Client-Side In-Memory DuckDB-WASM Execution',
        'Direct Unproxied BYOK REST Transport',
        'Synthetic/Masked Identifier Protection',
      ],
      wirePayloadString: this.captureWirePayloadInEvents ? payloadString : undefined,
      leakageAudit: leakageAudit ? {
        ...leakageAudit,
        // Only the field names are retained: the matched text is itself dataset content.
        leakedFields: leakageAudit.leakedFields.map((field) => field.split('=')[0]),
        matchesOutsideSchema: leakageAudit.matchesOutsideSchema.map((field) => field.split('=')[0]),
      } : null,
    };

    this.events.unshift(newEvent);
    if (this.events.length > this.maxEvents) {
      this.events = this.events.slice(0, this.maxEvents);
    }

    this.notify();
    return eventId;
  }

  /**
   * Audits a wire payload against raw dataset rows.
   *
   * The schema description block is the only place this app writes dataset-derived content into a
   * prompt, so a value found there is egress. A value that appears only inside the fixed planner
   * guidance or inside the user's own question is reported separately: it is not something the
   * importer put on the wire, and pretending otherwise forced a hand-maintained allowlist of
   * generic words that hid real leaks of the same shape. Payloads without schema markers
   * (synthetic fixtures) are scanned whole, which is the conservative reading.
   */
  public verifyPayloadDataLeakage(
    wirePayload: string,
    datasetRows: Record<string, any>[]
  ): { isSafe: boolean; leakedFields: string[]; matchesOutsideSchema: string[]; scanScope: 'schema_block' | 'whole_payload' } {
    if (!wirePayload || !datasetRows || datasetRows.length === 0) {
      return { isSafe: true, leakedFields: [], matchesOutsideSchema: [], scanScope: 'whole_payload' };
    }

    const payloadLower = wirePayload.toLowerCase();
    const start = payloadLower.indexOf(SCHEMA_BLOCK_START);
    const end = payloadLower.indexOf(SCHEMA_BLOCK_END);
    const scoped = start >= 0 && end > start;
    const scanRegion = scoped ? payloadLower.slice(start, end) : payloadLower;

    const leaked: string[] = [];
    const outsideSchema: string[] = [];

    // A sampled string-value scan cannot prove absence of all dataset or result egress.
    for (const row of datasetRows.slice(0, 100)) {
      for (const [key, val] of Object.entries(row)) {
        if (val === null || val === undefined) continue;

        // String checking (including substrings)
        if (typeof val === 'string') {
          const trimmedVal = val.trim().toLowerCase();
          if (trimmedVal.length <= 3) continue;
          if (scanRegion.includes(trimmedVal)) {
            leaked.push(`${key}="${val}"`);
          } else if (payloadLower.includes(trimmedVal)) {
            outsideSchema.push(`${key}="${val}"`);
          }
        }
      }
    }

    return {
      isSafe: leaked.length === 0,
      leakedFields: Array.from(new Set(leaked)),
      matchesOutsideSchema: Array.from(new Set(outsideSchema)),
      scanScope: scoped ? 'schema_block' : 'whole_payload',
    };
  }

  public getAuditStats(): { totalDispatches: number; zeroRowGuaranteeStrict: boolean } {
    return {
      totalDispatches: this.events.length,
      zeroRowGuaranteeStrict: false,
    };
  }

  public recordResponse(eventId: string, result: { status: 'success' | 'error'; httpStatus?: number; latencyMs: number; error?: string }) {
    const idx = this.events.findIndex((e) => e.id === eventId);
    if (idx !== -1) {
      this.events[idx] = {
        ...this.events[idx],
        status: result.status,
        httpStatus: result.httpStatus,
        latencyMs: result.latencyMs,
        error: result.error,
      };
      this.notify();
    }
  }

  public clearHistory(): void {
    this.events = [];
    this.notify();
  }
}

export const telemetryAuditor = new TelemetryAuditorService();
