import * as duckdb from '@duckdb/duckdb-wasm';
import { Dataset } from '../types';
import { validateSqlSafety, validateSqlIntent, validateExecutionResult } from './validators';
import { QueryPlan } from './queryPlan';
import { profileDatasetSchema } from './schemaProfiler';

export interface ExecutionOutput {
  success: boolean;
  columns: string[];
  rows: Record<string, any>[];
  rowCount: number;
  executionTimeMs: number;
  error?: string;
  sanitizedSql: string;
}

let workerInstance: Worker | null = null;
let dbInstance: duckdb.AsyncDuckDB | null = null;
let connInstance: duckdb.AsyncDuckDBConnection | null = null;
let initPromise: Promise<{ db: duckdb.AsyncDuckDB; conn: duckdb.AsyncDuckDBConnection }> | null = null;

let globalQuerySequenceId = 0;

/**
 * Cleanly terminates the active DuckDB worker and releases all resources.
 * Used for hard timeout cancellation and resetting contaminated worker states.
 */
export async function terminateDuckDBWorker(): Promise<void> {
  globalQuerySequenceId++;
  try {
    if (connInstance) {
      await connInstance.close().catch(() => {});
    }
    if (dbInstance) {
      await dbInstance.terminate().catch(() => {});
    }
  } catch {}
  if (workerInstance) {
    try {
      workerInstance.terminate();
    } catch {}
  }
  workerInstance = null;
  dbInstance = null;
  connInstance = null;
  initPromise = null;
  registeredDatasetCacheKey = null;
  registeredTableName = null;
}

/**
 * Manually cancels the currently executing query and resets the worker generation.
 */
export async function cancelCurrentQuery(): Promise<void> {
  await terminateDuckDBWorker();
}

export async function getDuckDB() {
  if (dbInstance && connInstance) {
    return { db: dbInstance, conn: connInstance };
  }
  if (initPromise) {
    return initPromise;
  }
  initPromise = (async () => {
    // Self-hosted DuckDB-WASM assets from public/duckdb — the SQL engine is
    // loaded from the same origin, so no third-party CDN request ever occurs.
    const assetBase = `${window.location.origin}/duckdb`;
    const LOCAL_BUNDLES = {
      mvp: {
        mainModule: `${assetBase}/duckdb-mvp.wasm`,
        mainWorker: `${assetBase}/duckdb-browser-mvp.worker.js`,
      },
      eh: {
        mainModule: `${assetBase}/duckdb-eh.wasm`,
        mainWorker: `${assetBase}/duckdb-browser-eh.worker.js`,
      },
    };
    const bundle = await duckdb.selectBundle(LOCAL_BUNDLES);
    const workerUrl = URL.createObjectURL(
      new Blob([`importScripts("${bundle.mainWorker}");`], { type: 'text/javascript' })
    );
    const worker = new Worker(workerUrl);
    workerInstance = worker;
    const logger = new duckdb.ConsoleLogger();
    const db = new duckdb.AsyncDuckDB(logger, worker);
    await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
    URL.revokeObjectURL(workerUrl);

    const conn = await db.connect();
    dbInstance = db;
    connInstance = conn;
    return { db, conn };
  })();

  try {
    return await initPromise;
  } finally {
    initPromise = null;
  }
}

let registeredDatasetCacheKey: string | null = null;
let registeredTableName: string | null = null;
const DEFAULT_QUERY_TIMEOUT_MS = 15000;
const MAX_RESULT_ROWS = 5000;

export async function executeValidatedSql(
  sql: string,
  dataset: Dataset,
  plan: QueryPlan,
  question: string
): Promise<ExecutionOutput & { passedChecks: string[] }> {
  const schema = profileDatasetSchema(dataset);
  const intent = validateSqlIntent(sql, plan, schema, question);
  if (!intent.valid) {
    return {
      success: false, columns: [], rows: [], rowCount: 0, executionTimeMs: 0,
      sanitizedSql: sql, error: intent.errors.join('; '), passedChecks: [],
    };
  }

  const execution = await executeClientSql(sql, dataset);
  if (!execution.success) return { ...execution, passedChecks: [] };
  if (execution.truncated || execution.rowCount !== execution.rows.length) {
    return { ...execution, success: false, error: 'Result is incomplete; a verified answer cannot be produced.', passedChecks: [] };
  }

  const result = validateExecutionResult(execution.rows, execution.columns, plan, schema);
  if (!result.valid) {
    return { ...execution, success: false, error: result.errors.join('; '), passedChecks: [] };
  }

  return {
    ...execution,
    passedChecks: [...(intent.passedChecks || []), ...(result.passedChecks || []), 'Complete DuckDB result verified'],
  };
}

export interface ExecutionOutput {
  success: boolean;
  columns: string[];
  rows: Record<string, any>[];
  rowCount: number;
  executionTimeMs: number;
  error?: string;
  sanitizedSql: string;
  truncated?: boolean;
}

function hashContent(text: string): string {
  // djb2 — fast non-cryptographic fingerprint used for dataset cache invalidation
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
}

/**
 * Registers a dataset as an in-memory SQL table in DuckDB.
 * QueryMind's data model is intentionally single-table: one active dataset is
 * registered at a time under its sanitized table name plus the "dataset"
 * alias, and re-registration replaces the previous table. Joins across
 * multiple uploaded tables are out of scope by design.
 *
 * The cache key includes a content fingerprint so a re-uploaded dataset with
 * identical shape but different values is always re-registered.
 * Registration failures throw: a silently unregistered dataset would surface
 * later as confusing "table not found" query errors.
 */
interface TableSwapEngine {
  db: { registerFileText(name: string, text: string): unknown; dropFile(name: string): unknown };
  conn: { query(sql: string): unknown };
}

/**
 * Replaces the single active table. The previous table and the staging JSON file are
 * released so repeated uploads and dataset switches do not accumulate copies in memory.
 */
export async function swapActiveTable(
  { db, conn }: TableSwapEngine,
  previousTable: string | null,
  tableName: string,
  jsonStr: string,
  stagingName = `data_${Date.now()}.json`
): Promise<void> {
  try {
    if (previousTable && previousTable !== tableName) await conn.query(`DROP TABLE IF EXISTS "${previousTable}"`);
    await conn.query(`DROP TABLE IF EXISTS "${tableName}"`);
    await conn.query(`DROP TABLE IF EXISTS "dataset"`);
  } catch {}

  await db.registerFileText(stagingName, jsonStr);
  try {
    await conn.query(`CREATE OR REPLACE TABLE "${tableName}" AS SELECT * FROM read_json_auto('${stagingName}')`);
    await conn.query(`CREATE OR REPLACE TABLE "dataset" AS SELECT * FROM "${tableName}"`);
  } finally {
    await Promise.resolve(db.dropFile(stagingName)).catch(() => {});
  }
}

export async function registerDatasetInSql(dataset: Dataset): Promise<void> {
  const jsonStr = JSON.stringify(dataset.data);
  const currentKey = `${dataset.id}_${dataset.rowCount}_${dataset.columns.length}_${hashContent(jsonStr)}`;
  if (registeredDatasetCacheKey === currentKey) {
    return; // Already registered and content unchanged
  }

  const engine = await getDuckDB();
  const tableName = dataset.tableName.toLowerCase().replace(/[^a-z0-9_]/g, '_');

  try {
    await swapActiveTable(engine, registeredTableName, tableName, jsonStr);
    registeredDatasetCacheKey = currentKey;
    registeredTableName = tableName;
  } catch (err: any) {
    registeredDatasetCacheKey = null;
    throw new Error(
      `Failed to register dataset "${dataset.name}" in the local DuckDB engine: ${err?.message || err}`
    );
  }
}

/**
 * Sanitizes and cleans AI-generated SQL query before in-memory execution.
 */
export function cleanSql(rawSql: string, activeTableName?: string): string {
  let sql = rawSql.trim();
  sql = sql.replace(/```sql/gi, '').replace(/```/g, '').trim();
  sql = sql.replace(/;+$/, '').trim();

  if (activeTableName) {
    const sanitizedName = activeTableName.toLowerCase().replace(/[^a-z0-9_]/g, '_');
    sql = sql.replace(new RegExp(`"${activeTableName}"`, 'gi'), `"${sanitizedName}"`);
    sql = sql.replace(new RegExp(`\`${activeTableName}\``, 'gi'), `"${sanitizedName}"`);
  }

  return sql;
}

/**
 * Executes a SELECT query safely in-memory using DuckDB with timeout and size limits.
 */
export async function executeClientSql(
  sql: string,
  dataset?: Dataset,
  timeoutMs: number = DEFAULT_QUERY_TIMEOUT_MS
): Promise<ExecutionOutput> {
  const mySeqId = ++globalQuerySequenceId;
  const startTime = performance.now();
  const sanitizedSql = cleanSql(sql, dataset?.tableName);

  // Enforce strict runtime SQL security on EVERY execution path
  const safety = validateSqlSafety(sanitizedSql, dataset?.tableName);
  if (!safety.isValid) {
    return {
      success: false,
      columns: [],
      rows: [],
      rowCount: 0,
      executionTimeMs: 0,
      error: `Security Guard: ${safety.errors.join(' ')}`,
      sanitizedSql,
    };
  }

  // Gracefully handle non-browser test runner environments
  if (typeof Worker === 'undefined') {
    return {
      success: false,
      columns: [],
      rows: [],
      rowCount: 0,
      executionTimeMs: 0,
      error: 'Environment Notice: DuckDB-WASM Web Worker requires a browser runtime with WebAssembly support.',
      sanitizedSql,
    };
  }

  if (dataset) {
    try {
      await registerDatasetInSql(dataset);
    } catch (err: any) {
      return {
        success: false,
        columns: [],
        rows: [],
        rowCount: 0,
        executionTimeMs: Math.max(1, Math.round(performance.now() - startTime)),
        error: err?.message || 'Failed to register dataset in the local SQL engine.',
        sanitizedSql,
      };
    }
  }

  try {
    const { conn } = await getDuckDB();

    // Enforce bounded query execution timeout
    const queryPromise = conn.query(sanitizedSql);
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`Query execution timed out after ${timeoutMs}ms. Consider applying tighter filters or LIMIT.`)),
        timeoutMs
      )
    );

    const result = await Promise.race([queryPromise, timeoutPromise]);
    const numericFields = result.schema.fields.filter((field) => [2, 3, 7].includes(field.type.typeId));
    // Arrow hands DATE/TIMESTAMP back as epoch offsets; render them as readable ISO values
    // so downstream tables, summaries and exports never show raw millisecond counts.
    const dateFields = result.schema.fields.filter((field) => field.type.typeId === 8);
    const timestampFields = result.schema.fields.filter((field) => field.type.typeId === 10);
    let rows = result.toArray().map((r: any) => {
      const row = r.toJSON();
      for (const field of numericFields) {
        const value = row[field.name];
        if (value === null || value === undefined) continue;
        const numeric = Number(value);
        if (!Number.isFinite(numeric) || (Number.isInteger(numeric) && !Number.isSafeInteger(numeric))) {
          throw new Error(`Column "${field.name}" contains a numeric value outside the supported precision range.`);
        }
        row[field.name] = numeric;
      }
      for (const field of [...dateFields, ...timestampFields]) {
        const value = row[field.name];
        if (value === null || value === undefined || value === '') continue;
        const ms = value instanceof Date ? value.getTime() : Number(value);
        if (!Number.isFinite(ms)) continue;
        row[field.name] = field.type.typeId === 8
          ? new Date(ms).toISOString().slice(0, 10)
          : new Date(ms).toISOString();
      }
      return row;
    });
    const duration = Math.max(1, Math.round(performance.now() - startTime));

    // Reject stale superseded execution
    if (mySeqId !== globalQuerySequenceId) {
      return {
        success: false,
        columns: [],
        rows: [],
        rowCount: 0,
        executionTimeMs: duration,
        error: 'Query execution superseded or cancelled by newer request.',
        sanitizedSql,
      };
    }

    let truncated = false;
    if (rows.length > MAX_RESULT_ROWS) {
      rows = rows.slice(0, MAX_RESULT_ROWS);
      truncated = true;
    }

    const columns = result.schema.fields.map((field) => field.name);

    return {
      success: true,
      columns,
      rows,
      rowCount: rows.length,
      executionTimeMs: duration,
      sanitizedSql,
      truncated,
    };
  } catch (err: any) {
    const duration = Math.max(1, Math.round(performance.now() - startTime));
    let errorMessage = err?.message || String(err);
    
    // Hard cancellation on execution timeout
    if (errorMessage.includes('timed out after')) {
      await terminateDuckDBWorker();
      errorMessage = `Execution Timeout: ${errorMessage} Active worker was terminated to prevent memory leakage and thread lock.`;
    } else if (errorMessage.includes('Parser Error') || errorMessage.includes('syntax error')) {
      errorMessage = `SQL Syntax Error: ${errorMessage}`;
    }
    // Scrub internal worker paths or blob URLs from error message
    errorMessage = errorMessage.replace(/blob:https?:\/\/[^\s]+/g, '[sandbox_worker]');

    return {
      success: false,
      columns: [],
      rows: [],
      rowCount: 0,
      executionTimeMs: duration,
      error: errorMessage,
      sanitizedSql,
    };
  }
}
