import {
  AnalyticalCategory,
  AnomalyObservation,
  BusinessImplication,
  KeyFinding,
  QueryInsight,
  RecommendedAction,
} from '../types';
import { QueryPlan } from './queryPlan';
import { SemanticSchema } from './schemaProfiler';

export interface SummaryContext {
  question: string;
  sql: string;
  status: 'verified' | 'success' | 'empty' | 'error' | 'needs_clarification';
  error?: string;
  rows: Record<string, any>[];
  columns: string[];
  rowCount: number;
  datasetName: string;
  tableName: string;
  queryPlan?: QueryPlan;
  semanticSchema?: SemanticSchema;
  executionTimeMs?: number;
  passedChecks?: string[];
  llmInsight?: Partial<QueryInsight>;
  auxStats?: AuxStats;
}

/**
 * Client-side supplementary statistics computed from DuckDB (no LLM call):
 * used to contextualize filtered aggregates with dataset-level totals.
 */
export interface AuxStats {
  filteredCount?: number;
  overallTotal?: number;
  overallCount?: number;
  /** For a LIMITed ranking: the column it was ordered on and that column's sum/count over every row the WHERE admits. */
  rankedColumn?: string;
  rankedPopulationTotal?: number;
  rankedPopulationCount?: number;
}

// Banned generic boilerplates that must NEVER appear in QueryMind summaries
const BANNED_BOILERPLATES: RegExp[] = [
  /audit downstream data pipelines/i,
  /review commercial thresholds prior to capital deployment/i,
  /review variance thresholds against historical quarterly trends/i,
  /all verified metrics conform to expected baseline constraints/i,
  /data scope is bounded to active table filters/i,
  /prior to capital deployment/i,
  /fiscal reporting cycles/i,
];

/**
 * Strips HTML and script injection to keep text safe and clean.
 */
function sanitizeText(raw: string | undefined): string {
  if (!raw) return '';
  return raw
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

/**
 * Checks if a string contains any banned boilerplate phrases.
 */
function containsBannedBoilerplate(text: string): boolean {
  return BANNED_BOILERPLATES.some((regex) => regex.test(text));
}

/**
 * Formats numeric values nicely with appropriate prefixes/suffixes based on column name and value.
 */
export function formatMetricValue(val: any, colName: string = '', currencySources?: Map<string, string>): string {
  if (val === null || val === undefined || val === '') return 'N/A';
  if (typeof val === 'boolean') return val ? 'Yes' : 'No';
  const num = typeof val === 'number' ? val : Number(val);
  if (isNaN(num)) return String(val);

  const lowerCol = colName.toLowerCase();

  // A ratio is never a currency, even when its label mentions one ("pct_of_total_mrr").
  const isPercentage =
    lowerCol.includes('pct') ||
    lowerCol.includes('percent') ||
    lowerCol.includes('margin') ||
    lowerCol.includes('rate') ||
    lowerCol.includes('ratio') ||
    lowerCol.includes('share');

  if (isPercentage) {
    const pctVal = Math.abs(num) > 0 && Math.abs(num) <= 1 && lowerCol.includes('pct') ? num * 100 : num;
    const decimals = pctVal % 1 === 0 ? 0 : 2;
    return `${Number(pctVal.toFixed(decimals)).toLocaleString('en-US', { maximumFractionDigits: 2 })}%`;
  }

  const isCurrency =
    lowerCol.includes('mrr') ||
    lowerCol.includes('arr') ||
    lowerCol.includes('sales') ||
    lowerCol.includes('profit') ||
    lowerCol.includes('revenue') ||
    lowerCol.includes('price') ||
    lowerCol.includes('cost') ||
    lowerCol.includes('spend') ||
    currencySources?.has(colName) === true;

  if (isCurrency) {
    const isNeg = num < 0;
    const absVal = Math.abs(num);
    const cents = Math.round(absVal * 100) % 100 !== 0;
    const formatted = absVal.toLocaleString('en-US', {
      minimumFractionDigits: cents ? 2 : 0,
      maximumFractionDigits: cents ? 2 : 0,
    });
    return isNeg ? `-$${formatted}` : `$${formatted}`;
  }

  return num.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

/**
 * Builds a readable English description of a simple WHERE clause, e.g.
 * "where subscription_status is 'Cancelled'". Returns null when the clause
 * is too complex to describe safely.
 */
function describeWhereClause(sql: string): string | null {
  const m = sql.match(/\bWHERE\b([\s\S]*?)(?:\bGROUP\s+BY\b|\bORDER\s+BY\b|\bLIMIT\b|;|$)/i);
  if (!m?.[1]) return null;
  const clause = m[1].trim().replace(/[()\n]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!clause) return null;

  const conditions = clause.split(/\bAND\b/i).map((s) => s.trim()).filter(Boolean);
  if (conditions.length === 0 || conditions.some((c) => /\bOR\b|\bLIKE\b|\bIN\b/i.test(c) && !/^\S+\s+IN\s*\(/i.test(c))) {
    return null;
  }

  const parts: string[] = [];
  for (const c of conditions) {
    const inMatch = c.match(/^["'`]?([\w ]+?)["'`]?\s+IN\s*\(([^)]*)\)$/i);
    if (inMatch) {
      const vals = inMatch[2]
        .split(',')
        .map((v) => v.trim().replace(/^'|'$/g, ''))
        .filter(Boolean);
      if (vals.length === 0) return null;
      parts.push(`${inMatch[1].trim()} is ${vals.map((v) => `'${v}'`).join(' or ')}`);
      continue;
    }
    const eqMatch = c.match(/^["'`]?([\w ]+?)["'`]?\s*=\s*'([^']*)'$/);
    if (eqMatch) {
      parts.push(`${eqMatch[1].trim()} is '${eqMatch[2]}'`);
      continue;
    }
    const cmpMatch = c.match(/^["'`]?([\w ]+?)["'`]?\s*(>=|<=|>|<)\s*([\d.]+)$/);
    if (cmpMatch) {
      parts.push(`${cmpMatch[1].trim()} is ${cmpMatch[2]} ${cmpMatch[3]}`);
      continue;
    }
    return null;
  }

  return `where ${parts.join(' and ')}`;
}

/** English series join: ["a","b","c"] -> "a, b and c" (never "a and b and c"). */
function joinSeries(items: string[]): string {
  const list = items.filter(Boolean);
  if (list.length <= 1) return list[0] || '';
  if (list.length === 2) return `${list[0]} and ${list[1]}`;
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

/**
 * Infers entity name from table name, dataset name, or schema.
 */
function inferEntity(tableName: string, datasetName: string): { singular: string; plural: string } {
  const combined = `${tableName} ${datasetName}`.toLowerCase();
  if (combined.includes('customer') || combined.includes('client') || combined.includes('account')) {
    return { singular: 'customer', plural: 'customers' };
  }
  // "sales" is deliberately not an order signal: a sales table is often already aggregated.
  if (combined.includes('order') || combined.includes('transaction')) {
    return { singular: 'order', plural: 'orders' };
  }
  if (combined.includes('product') || combined.includes('item')) {
    return { singular: 'product', plural: 'products' };
  }
  if (combined.includes('employee') || combined.includes('staff')) {
    return { singular: 'employee', plural: 'employees' };
  }
  return { singular: 'record', plural: 'records' };
}

/**
 * Profiler for identifying column semantic roles in tabular query results.
 */
interface ColumnProfile {
  dimensionCol?: string;
  entityCol?: string;
  totalCountCol?: string;
  activeCountCol?: string;
  activeRateCol?: string;
  totalRevenueCol?: string;
  avgRevenueCol?: string;
  activeRevenueCol?: string;
  ticketsCol?: string;
  usageCol?: string;
  statusCol?: string;
  rankCol?: string;
  shareCol?: string;
  numericCols: string[];
  currencySources?: Map<string, string>;
}

const MONEY_COLUMN_PATTERN = /(mrr|arr|revenue|sales|price|amount|cost|spend|profit|fee|fare|gmv)/i;
const PERCENTISH_COLUMN_PATTERN = /(pct|percent|ratio|share|rate)/i;
const MONEY_AGGREGATE = /^(sum|avg|average|min|max|total)\s*\(/i;
const PLAIN_COLUMN_REF = /^[A-Za-z_][\w$]*(\.[A-Za-z_][\w$]*)?$/;

/**
 * Splits a SELECT list on top-level commas so an expression such as
 * ROUND(SUM(mrr_usd), 2) AS total_mrr stays in one piece.
 */
export function parseSelectExpressions(sql: string): { expr: string; alias: string | null }[] {
  const text = String(sql || '');
  const results: { expr: string; alias: string | null }[] = [];
  let cursor = 0;
  // A CTE or subquery can hide the aggregate the outer query re-selects, so every
  // SELECT projection is parsed, not only the first one.
  while (cursor < text.length) {
    const selectIdx = text.toLowerCase().indexOf('select', cursor);
    if (selectIdx < 0) break;
    const next = parseOneProjection(text, selectIdx);
    if (!next) break;
    results.push(...next.items);
    cursor = Math.max(next.end, selectIdx + 7);
  }
  return results;
}

function parseOneProjection(text: string, selectIdx: number): { items: { expr: string; alias: string | null }[]; end: number } | null {
  let i = selectIdx + 'select'.length;
  if (text.slice(i, i + 12).trimStart().toLowerCase().startsWith('distinct')) {
    i = text.toLowerCase().indexOf('distinct', i) + 'distinct'.length;
  }

  // The projection ends at the first FROM outside quotes and parentheses.
  let depth = 0;
  let quote: string | null = null;
  const projectionStart = i;
  for (; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '\'' || ch === '"') { quote = ch; continue; }
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0 && text.slice(i, i + 4).toLowerCase() === 'from' && (i === 0 || /[\s,)]/.test(text[i - 1])) && !/[\w$]/.test(text[i + 4] || ' ')) break;
  }
  const projection = text.slice(projectionStart, i);

  const items: string[] = [];
  let level = 0;
  let q: string | null = null;
  let current = '';
  for (const ch of projection) {
    if (q) {
      if (ch === q) q = null;
      current += ch;
      continue;
    }
    if (ch === '\'' || ch === '"') { q = ch; current += ch; continue; }
    if (ch === '(') level++;
    if (ch === ')') level = Math.max(0, level - 1);
    if (level === 0 && ch === ',') { items.push(current); current = ''; continue; }
    current += ch;
  }
  if (current.trim()) items.push(current);

  const parsed = items
    .map((raw) => {
      const item = raw.trim();
      if (!item) return null;
      const asIdx = item.toLowerCase().lastIndexOf(' as ');
      if (asIdx > 0) {
        const expr = item.slice(0, asIdx).trim();
        const alias = item.slice(asIdx + 4).trim().replace(/^["`]|["`]$/g, '');
        if (/^[A-Za-z_][\w$]*$/.test(alias)) return { expr, alias };
      }
      const tail = item.match(/^([\s\S]+)\s+("([^"]+)"|([A-Za-z_][\w$]*))$/);
      if (tail && /\)\s*$/.test(tail[1])) {
        return { expr: tail[1].trim(), alias: tail[3] || tail[4] };
      }
      return { expr: item, alias: null };
    })
    .filter((item): item is { expr: string; alias: string | null } => item !== null);
  return { items: parsed, end: i };
}

/**
 * Maps each output column to the currency column it aggregates, when the SQL and the
 * dataset schema make that unambiguous. This keeps alias choice ("plan_total") from
 * deciding whether a sum of mrr_usd is displayed as money or treated as a count.
 */
function selectCurrencySources(sql: string, columns: string[], semanticSchema?: SemanticSchema): Map<string, string> {
  const sources = new Map<string, string>();
  const schemaNames: string[] = (semanticSchema?.columns || []).map((c) => c.name);
  if (!schemaNames.length) return sources;
  const moneyColumns = schemaNames.filter((n) => MONEY_COLUMN_PATTERN.test(n));
  if (!moneyColumns.length) return sources;

  const listed = parseSelectExpressions(sql);
  if (!listed.length) return sources;
  const measureNames = columns.filter((c) => !PERCENTISH_COLUMN_PATTERN.test(c));
  const moneyByLower = new Map(moneyColumns.map((name) => [name.toLowerCase(), name]));

  for (const { expr, alias } of listed) {
    const text = String(expr).trim();
    // Only a monetary aggregate or a bare money column carries a currency; COUNT(mrr_usd)
    // or an arithmetic ratio built from money columns does not.
    if (!MONEY_AGGREGATE.test(text) && !PLAIN_COLUMN_REF.test(text)) continue;
    // The first identifier is the function name ("SUM"), so scan every identifier.
    const identifiers = text.match(/[A-Za-z_][\w$]*/g) || [];
    const measure = identifiers
      .map((id) => moneyByLower.get(id.toLowerCase()))
      .find((name): name is string => Boolean(name));
    if (!measure) continue;

    const targets = new Set<string>();
    if (alias) targets.add(alias);
    const nameHit = measureNames.find((c) => c.toLowerCase().includes(measure.toLowerCase()));
    if (nameHit) targets.add(nameHit);
    targets.forEach((target) => sources.set(target, measure));
  }
  // An aggregate aliased exactly like its source column, e.g. SUM(mrr_usd) AS mrr_usd.
  for (const column of columns) {
    if (!sources.has(column) && moneyColumns.includes(column)) sources.set(column, column);
  }
  return sources;
}

function profileColumns(columns: string[], rows: Record<string, any>[]): ColumnProfile {
  const sample = rows[0] || {};
  const numericCols = columns.filter((c) => typeof sample[c] === 'number');
  const stringCols = columns.filter((c) => !numericCols.includes(c));

  // Dimension column (categorical groupings like segment, tier, channel, city, industry)
  const dimensionCol = stringCols.find((c) => {
    const l = c.toLowerCase();
    return (
      l.includes('segment') ||
      l.includes('tier') ||
      l.includes('channel') ||
      l.includes('city') ||
      l.includes('region') ||
      l.includes('industry') ||
      l.includes('category')
    );
  }) || stringCols[0];

  // Entity column (individual identifiers like company_name, customer_name, product)
  const entityCol = stringCols.find((c) => {
    const l = c.toLowerCase();
    return (
      l.includes('company') ||
      l.includes('customer_name') ||
      l.includes('name') ||
      l.includes('product') ||
      l.includes('id')
    );
  }) || stringCols[0] || columns[0];

  // Total count column
  const totalCountCol = numericCols.find((c) => {
    const l = c.toLowerCase();
    return (
      (l.includes('total_customer') || l.includes('customer_count') || l.includes('customers') || l === 'count') &&
      !l.includes('active')
    );
  });

  // Active count column
  const activeCountCol = numericCols.find((c) => {
    const l = c.toLowerCase();
    return l.includes('active') && (l.includes('customer') || l.includes('user') || l.includes('count'));
  });

  // Active rate / percentage column
  const activeRateCol = numericCols.find((c) => {
    const l = c.toLowerCase();
    return (l.includes('active') || l.includes('activation')) && (l.includes('percent') || l.includes('pct') || l.includes('rate'));
  });

  // Total revenue column
  const totalRevenueCol = numericCols.find((c) => {
    const l = c.toLowerCase();
    return (
      (l.includes('total_mrr') || l.includes('sum_mrr') || l.includes('total_sales') || l.includes('total_revenue') || l.includes('total_profit') || l === 'mrr') &&
      !l.includes('avg') &&
      !l.includes('average') &&
      !l.includes('active_mrr')
    );
  });

  // Average revenue column
  const avgRevenueCol = numericCols.find((c) => {
    const l = c.toLowerCase();
    return (l.includes('avg') || l.includes('average')) && (l.includes('mrr') || l.includes('sales') || l.includes('profit') || l.includes('revenue'));
  });

  // Active revenue column
  const activeRevenueCol = numericCols.find((c) => {
    const l = c.toLowerCase();
    return l.includes('active') && (l.includes('mrr') || l.includes('sales') || l.includes('revenue'));
  });

  // Support tickets column
  const ticketsCol = numericCols.find((c) => c.toLowerCase().includes('ticket'));

  // Usage column
  const usageCol = numericCols.find((c) => c.toLowerCase().includes('usage'));

  // Status column
  const statusCol = stringCols.find((c) => {
    const l = c.toLowerCase();
    return l.includes('status') || l.includes('churn');
  });

  // Rank column
  const rankCol = numericCols.find((c) => c.toLowerCase().includes('rank'));

  // A share-of-total column restates another measure as a percentage; it is not a second metric.
  const shareCol = numericCols.length >= 2
    ? numericCols.find((c) => /(pct|percent|share|portion).*total|total.*(pct|percent|share)|(^|_)share($|_)/i.test(c))
    : undefined;

  return {
    dimensionCol,
    entityCol,
    totalCountCol,
    activeCountCol,
    activeRateCol,
    totalRevenueCol,
    avgRevenueCol,
    activeRevenueCol,
    ticketsCol,
    usageCol,
    statusCol,
    rankCol,
    shareCol,
    numericCols,
  };
}

/**
 * Classifies the analytical intent into one of the canonical categories.
 */
function isTimeAxisColumn(c: string): boolean {
  return /(^|_)(date|timestamp|period|month|year|quarter|week)(_|$)/i.test(c) || /_(at|on|date)$/i.test(c);
}

export function classifyAnalyticalIntent(
  question: string,
  sql: string,
  columns: string[],
  rows: Record<string, any>[],
  plan?: QueryPlan
): AnalyticalCategory {
  const q = question.toLowerCase().trim();
  const sqlUpper = sql.toUpperCase();

  // 1. Predictive / Unsupported Requests
  const predictiveRegex = /\b(predict|prediction|predictive|forecast|forecasted|next month|next year|churn probability|churn probabilities|will churn|will cancel|propensity|machine learning model)\b/i;
  if (predictiveRegex.test(q)) {
    return 'unsupported_request';
  }

  const hasGroupedLanguage =
    q.includes('by ') ||
    q.includes('per ') ||
    q.includes('each ') ||
    q.includes('across ') ||
    q.includes('segment') ||
    sqlUpper.includes('GROUP BY');

  // 2. Simple Count
  const countRegex = /\b(how many|count of|number of|total number of|how many customers|how many orders|how many rows)\b/i;
  const isCountSql =
    sqlUpper.includes('COUNT(') &&
    !sqlUpper.includes('GROUP BY') &&
    rows.length <= 1;
  if ((countRegex.test(q) && !hasGroupedLanguage) || isCountSql) {
    return 'simple_count';
  }

  // 3. Total / Sum
  const sumRegex = /\b(total|sum of|cumulative|total mrr|overall mrr|total sales|total revenue|total profit)\b/i;
  const isSumSql =
    sqlUpper.includes('SUM(') &&
    !sqlUpper.includes('GROUP BY') &&
    rows.length <= 1;
  if ((sumRegex.test(q) && !hasGroupedLanguage) || isSumSql) {
    return 'total_sum';
  }

  // 4. Statistical Aggregation (Single-group Avg/Min/Max)
  const statRegex = /\b(average|avg|median|min|max|minimum|maximum|mean)\b/i;
  const isStatSql =
    (sqlUpper.includes('AVG(') || sqlUpper.includes('MIN(') || sqlUpper.includes('MAX(')) &&
    !sqlUpper.includes('GROUP BY') &&
    rows.length <= 1;
  if ((statRegex.test(q) && !hasGroupedLanguage) || isStatSql) {
    return 'statistical_aggregation';
  }

  // 5. Ranking / Top-N
  const rankingRegex = /\b(top \d+|top|most|highest|lowest|bottom \d+|leading|best|worst|ranked|ranking)\b/i;
  const isRankingSql =
    sqlUpper.includes('ORDER BY') &&
    (sqlUpper.includes('LIMIT') || sqlUpper.includes('ROW_NUMBER()'));
  if (plan?.intent === 'top_n_per_group' || plan?.intent === 'ranking' || (rankingRegex.test(q) && (isRankingSql || q.includes('top')))) {
    return 'ranking_top_n';
  }

  // 5b. Time Trend over a bucketed period. Checked before the grouped branches because every
  // period breakdown is also a GROUP BY.
  const bucketsTime = /\b(DATE_TRUNC|STRFTIME|DATE_PART|DATEPART|EXTRACT|YEAR|MONTH|QUARTER|WEEK)\s*\(/i.test(sql);
  if (rows.length >= 2 && columns.some(isTimeAxisColumn) && (plan?.intent === 'time_trend' || (sqlUpper.includes('GROUP BY') && bucketsTime))) {
    return 'time_trend';
  }

  // 6. Multi-Metric Analysis
  const hasMultipleMeasures =
    columns.filter((c) => {
      const lower = c.toLowerCase();
      return (
        lower.includes('count') ||
        lower.includes('sum') ||
        lower.includes('avg') ||
        lower.includes('total') ||
        lower.includes('mrr') ||
        lower.includes('sales') ||
        lower.includes('profit') ||
        lower.includes('active_users') ||
        lower.includes('ticket')
      );
    }).length >= 2;
  if (sqlUpper.includes('GROUP BY') && hasMultipleMeasures && (q.includes(' and ') || q.includes('both'))) {
    return 'multi_metric';
  }

  // 7. Grouped Comparison or Segmentation
  if (sqlUpper.includes('GROUP BY') || hasGroupedLanguage) {
    if (q.includes('percentage') || q.includes('percent') || q.includes('rate') || q.includes('ratio')) {
      return 'segmentation';
    }
    return 'grouped_comparison';
  }

  // 8. Time Trend
  // "monthly" is not a trend signal when it is part of the measure's own name
  // ("monthly recurring revenue"), and a trend needs a time axis to trend along.
  if (sqlUpper.includes('DATE_TRUNC') || plan?.intent === 'time_trend') {
    return 'time_trend';
  }
  const measureNamedPhrase = q.replace(/(monthly|annual)\s+recurring\s+revenue|\bmrr\w*\b|\barr\w*\b/gi, ' ');
  const trendWords = /\b(monthly|daily|weekly|quarterly|yearly|trend|over time|time series|by month|by year)\b/i.test(measureNamedPhrase);
  const hasTimeAxis = columns.some(isTimeAxisColumn);
  if (hasTimeAxis && trendWords) {
    return 'time_trend';
  }

  // 9. Filtering and Record Retrieval
  return 'filtering_retrieval';
}

/**
 * Detects numerical or categorical anomalies from actual returned rows.
 */
export function detectEvidenceAnomalies(
  rows: Record<string, any>[],
  columns: string[],
  category: AnalyticalCategory
): AnomalyObservation[] {
  const anomalies: AnomalyObservation[] = [];
  if (!rows || rows.length === 0) return anomalies;

  // 1. Negative Values where typically unexpected
  columns.forEach((col) => {
    const colLower = col.toLowerCase();
    const shouldBeNonNegative =
      colLower.includes('mrr') ||
      colLower.includes('quantity') ||
      colLower.includes('active_users') ||
      colLower.includes('ticket') ||
      colLower.includes('count');

    if (shouldBeNonNegative) {
      const negRows = rows.filter((r) => typeof r[col] === 'number' && r[col] < 0);
      if (negRows.length > 0) {
        anomalies.push({
          observation: `Found ${negRows.length} record(s) with negative values in non-negative field "${col}".`,
          evidence: `Sample negative value: ${formatMetricValue(negRows[0][col], col)}`,
          severity: 'high',
          type: 'data_quality',
        });
      }
    }
  });

  // 2. Check for unexpected nulls in returned rows
  columns.forEach((col) => {
    const nullRows = rows.filter((r) => r[col] === null || r[col] === undefined);
    if (nullRows.length > 0 && nullRows.length === rows.length) {
      anomalies.push({
        observation: `Column "${col}" returned entirely null values across all ${rows.length} record(s).`,
        evidence: `100% missing values in column "${col}"`,
        severity: 'medium',
        type: 'data_quality',
      });
    }
  });

  return anomalies;
}

/**
 * Normalizes insight into both structured arrays and backward-compatible fields.
 */
/**
 * Column labels reach the narrative as "total mrr": the builders split snake_case on underscores,
 * which leaves measure acronyms lower-cased mid-sentence. Only a standalone lowercase token is
 * restored here, so a deliberate code reference such as "mrr_usd > 1500" stays exactly as written.
 */
const MEASURE_ACRONYM_PATTERN = /\b(mrr|arr|arpu|nps|cac|ltv|roi|ctr|cvr|sku|kpi|usd)\b/g;

function acronymizeLabels(text: string): string {
  return typeof text === 'string' ? text.replace(MEASURE_ACRONYM_PATTERN, (word) => word.toUpperCase()) : text;
}

/**
 * Narrates a bucketed period series from the returned rows only: direction, extremes, the largest
 * step changes, an early-vs-late comparison and, when a count column is present, whether a change
 * came from volume or from value per record. Returns null when the rows are not a usable series.
 */
function buildTimeTrendInsight(
  rows: Record<string, any>[],
  columns: string[],
  plan: QueryPlan | undefined,
  entity: { singular: string; plural: string }
): QueryInsight | null {
  const isNum = (c: string) => rows.every((r) => r[c] === null || r[c] === undefined || Number.isFinite(Number(r[c])) && typeof r[c] !== 'boolean' && String(r[c]).trim() !== '' && !/^\d{4}-\d{2}/.test(String(r[c])));
  const periodCol = columns.find(isTimeAxisColumn) ?? columns.find((c) => !isNum(c));
  if (!periodCol) return null;
  const numericCols = columns.filter((c) => c !== periodCol && isNum(c));
  if (numericCols.length === 0) return null;

  const isCountCol = (c: string) => /(count|number|^n_|_n$|customers|accounts|orders|signups|records|users)/i.test(c) && !/(mrr|revenue|sales|amount|value|usd|price|profit)/i.test(c);
  const plannedMetric = plan?.metric?.toLowerCase();
  const primary =
    numericCols.find((c) => !isCountCol(c) && plannedMetric && c.toLowerCase().includes(plannedMetric.replace(/_usd$/, ''))) ||
    numericCols.find((c) => !isCountCol(c)) ||
    numericCols[0];
  const countCol = numericCols.find((c) => c !== primary && isCountCol(c));

  const series = [...rows]
    .filter((r) => r[periodCol] !== null && r[periodCol] !== undefined)
    .sort((a, b) => String(a[periodCol]).localeCompare(String(b[periodCol])));
  if (series.length < 2) return null;

  const label = (c: string) => c.replace(/_/g, ' ');
  const fmt = (v: number, c = primary) => formatMetricValue(v, c);
  const period = (r: Record<string, any>) => String(r[periodCol]).slice(0, 10);
  const val = (r: Record<string, any>, c = primary) => Number(r[c]) || 0;
  const pct = (from: number, to: number) => (from !== 0 ? ((to - from) / Math.abs(from)) * 100 : null);
  const signed = (p: number | null) => (p === null ? '' : ` (${p >= 0 ? '+' : ''}${p.toFixed(1)}%)`);
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / (xs.length || 1);

  const first = series[0];
  const last = series[series.length - 1];
  const values = series.map((r) => val(r));
  const total = values.reduce((a, b) => a + b, 0);
  const avg = total / series.length;
  const peak = series.reduce((best, r) => (val(r) > val(best) ? r : best), first);
  const trough = series.reduce((low, r) => (val(r) < val(low) ? r : low), first);
  const metricName = label(primary);

  const steps = series.slice(1).map((r, i) => ({ from: series[i], to: r, delta: val(r) - val(series[i]) }));
  const biggestRise = steps.reduce((m, s) => (s.delta > m.delta ? s : m), steps[0]);
  const biggestDrop = steps.reduce((m, s) => (s.delta < m.delta ? s : m), steps[0]);
  const ups = steps.filter((s) => s.delta > 0).length;
  const downs = steps.filter((s) => s.delta < 0).length;

  const endChange = pct(val(first), val(last));
  const direction =
    endChange === null ? 'changed' : endChange > 5 ? 'rose' : endChange < -5 ? 'fell' : 'ended roughly level';

  const key_findings: KeyFinding[] = [];
  const business_implications: BusinessImplication[] = [];
  const recommended_actions: RecommendedAction[] = [];
  const limitations: string[] = [];

  const overview = `Across ${series.length} periods from ${period(first)} to ${period(last)}, ${metricName} ${direction}${
    direction === 'ended roughly level' ? ` (${fmt(val(first))} to ${fmt(val(last))})` : ` from ${fmt(val(first))} to ${fmt(val(last))}${signed(endChange)}`
  }, peaking in ${period(peak)} at ${fmt(val(peak))}. The path was uneven: ${ups} period-over-period increase${ups === 1 ? '' : 's'} and ${downs} decrease${downs === 1 ? '' : 's'}.`;

  key_findings.push({
    finding: `Peak: ${period(peak)} at ${fmt(val(peak))}; low: ${period(trough)} at ${fmt(val(trough))}. The ${series.length}-period average is ${fmt(avg)}, and ${
      values.filter((v) => v > avg).length
    } of ${series.length} periods sit above it.`,
    evidence: `${primary} by ${periodCol}: ${series.map((r) => `${period(r)}=${val(r)}`).join(', ')}`,
    importance: 'high',
  });

  if (biggestDrop.delta < 0) {
    key_findings.push({
      finding: `Largest decline: ${period(biggestDrop.from)} to ${period(biggestDrop.to)}, down ${fmt(Math.abs(biggestDrop.delta))}${signed(pct(val(biggestDrop.from), val(biggestDrop.to)))}.`,
      evidence: `${period(biggestDrop.from)}=${val(biggestDrop.from)}, ${period(biggestDrop.to)}=${val(biggestDrop.to)}`,
      importance: 'high',
    });
  }
  if (biggestRise.delta > 0) {
    key_findings.push({
      finding: `Largest increase: ${period(biggestRise.from)} to ${period(biggestRise.to)}, up ${fmt(biggestRise.delta)}${signed(pct(val(biggestRise.from), val(biggestRise.to)))}.`,
      evidence: `${period(biggestRise.from)}=${val(biggestRise.from)}, ${period(biggestRise.to)}=${val(biggestRise.to)}`,
      importance: 'medium',
    });
  }

  if (series.length >= 4) {
    const k = Math.floor(series.length / 2);
    const early = series.slice(0, k);
    const late = series.slice(series.length - k);
    const earlyAvg = mean(early.map((r) => val(r)));
    const lateAvg = mean(late.map((r) => val(r)));
    const halfChange = pct(earlyAvg, lateAvg);
    key_findings.push({
      finding: `The last ${k} periods average ${fmt(lateAvg)} of ${metricName} against ${fmt(earlyAvg)} in the first ${k}${signed(halfChange)}.`,
      evidence: `first ${k}: ${early.map(period).join(', ')}; last ${k}: ${late.map(period).join(', ')}`,
      importance: 'high',
    });

    if (countCol) {
      const earlyCount = mean(early.map((r) => val(r, countCol)));
      const lateCount = mean(late.map((r) => val(r, countCol)));
      const earlySum = early.reduce((a, r) => a + val(r), 0);
      const lateSum = late.reduce((a, r) => a + val(r), 0);
      const earlyRecords = early.reduce((a, r) => a + val(r, countCol), 0);
      const lateRecords = late.reduce((a, r) => a + val(r, countCol), 0);
      if (earlyRecords > 0 && lateRecords > 0) {
        const earlyPer = earlySum / earlyRecords;
        const latePer = lateSum / lateRecords;
        const countChange = pct(earlyCount, lateCount);
        const perChange = pct(earlyPer, latePer);
        key_findings.push({
          finding: `${label(countCol).replace(/^\w/, (c) => c.toUpperCase())} averaged ${lateCount.toFixed(1)} per period lately against ${earlyCount.toFixed(1)} earlier${signed(countChange)}, while ${metricName} per ${entity.singular} moved from ${fmt(earlyPer)} to ${fmt(latePer)}${signed(perChange)}.`,
          evidence: `first ${k}: ${earlyRecords} ${entity.plural}, ${earlySum}; last ${k}: ${lateRecords} ${entity.plural}, ${lateSum}`,
          importance: 'high',
        });
        if (halfChange !== null && Math.abs(halfChange) >= 10 && countChange !== null && perChange !== null) {
          const volumeLed = Math.abs(countChange) >= Math.abs(perChange);
          business_implications.push({
            implication: `The ${halfChange < 0 ? 'lower' : 'higher'} recent ${metricName} is ${volumeLed ? 'mainly a volume effect' : 'mainly a value-per-record effect'}: ${
              volumeLed
                ? `${label(countCol)} changed ${countChange.toFixed(1)}% while ${metricName} per ${entity.singular} changed ${perChange.toFixed(1)}%.`
                : `${metricName} per ${entity.singular} changed ${perChange.toFixed(1)}% while ${label(countCol)} changed ${countChange.toFixed(1)}%.`
            }`,
            evidence: `period averages from the returned rows`,
            confidence: 'medium',
          });
          recommended_actions.push({
            action: volumeLed
              ? `Look at what changed in ${label(countCol)} from ${period(late[0])} onward before treating the lower totals as a pricing or value problem.`
              : `Look at the mix of ${entity.plural} added from ${period(late[0])} onward; the count held up but each contributes a different ${metricName}.`,
            reason: `The early-vs-late split attributes the change to ${volumeLed ? 'volume' : 'value per record'}.`,
            priority: 'medium',
          });
        }
      }
    }
  }

  // Calendar gaps: "2025-01".."2025-09" style buckets with a month missing are absent, not zero.
  const monthKeys = series.map((r) => String(r[periodCol]).match(/^(\d{4})-(\d{2})/)).filter(Boolean) as RegExpMatchArray[];
  if (monthKeys.length === series.length && monthKeys.length >= 2) {
    const toIndex = (m: RegExpMatchArray) => Number(m[1]) * 12 + Number(m[2]) - 1;
    const present = new Set(monthKeys.map(toIndex));
    const missing: string[] = [];
    for (let i = toIndex(monthKeys[0]); i <= toIndex(monthKeys[monthKeys.length - 1]); i++) {
      if (!present.has(i)) missing.push(`${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`);
    }
    if (missing.length > 0) {
      limitations.push(`No rows exist for ${joinSeries(missing.slice(0, 6))}${missing.length > 6 ? ' and others' : ''}; those months are absent from the series rather than zero.`);
    }
  }

  if (/(signup|sign_up|created|joined|start|acquired|onboard|registration)/i.test(periodCol) || /(signup|sign_up|created|joined|start|acquired|onboard|registration)/i.test((plan?.dimensions || []).join(' '))) {
    limitations.push(`Each period groups ${entity.plural} by when they were created, so ${metricName} here is the current value of each cohort, not what was earned during that period.`);
  }
  limitations.push(`${series.length} periods describe the past only; no forecast or seasonality is implied.`);

  return {
    status: 'verified',
    category: 'time_trend',
    overview,
    key_findings,
    performance_comparison: [],
    anomalies: [],
    business_implications,
    recommended_actions,
    limitations,
  };
}

function buildLegacyPayload(insight: QueryInsight): QueryInsight {
  const findingsList = insight.key_findings ? insight.key_findings.map((f) => f.finding) : (insight.findings || []);
  const anomaliesList = insight.anomalies
    ? insight.anomalies.map((a) => (typeof a === 'string' ? a : a.observation))
    : (insight.critical_anomalies || []);
  const implicationsList = insight.business_implications
    ? insight.business_implications.map((i) => (typeof i === 'string' ? i : i.implication))
    : (insight.caveats || []);
  const actionsList = insight.recommended_actions
    ? insight.recommended_actions.map((a) => a.action)
    : insight.recommendedAction
    ? [insight.recommendedAction]
    : [];

  return {
    ...insight,
    overview: insight.overview ? acronymizeLabels(insight.overview) : insight.overview,
    summary: acronymizeLabels(insight.overview || insight.executive_summary || ''),
    executive_summary: acronymizeLabels(insight.overview || insight.executive_summary || ''),
    findings: findingsList.map(acronymizeLabels),
    highlights: findingsList.map(acronymizeLabels),
    critical_anomalies: anomaliesList.map(acronymizeLabels),
    caveats: implicationsList.map(acronymizeLabels),
    strategic_experiments: actionsList.map(acronymizeLabels),
    recommendedAction: actionsList[0] ? acronymizeLabels(actionsList[0]) : undefined,
    recommended_action: actionsList[0] ? acronymizeLabels(actionsList[0]) : undefined,
    business_implications: insight.business_implications?.map((i) =>
      typeof i === 'string' ? acronymizeLabels(i) : { ...i, implication: acronymizeLabels(i.implication), evidence: i.evidence ? acronymizeLabels(i.evidence) : i.evidence }
    ) ?? implicationsList.map(acronymizeLabels),
    anomalies: insight.anomalies?.map((a) =>
      typeof a === 'string' ? acronymizeLabels(a) : { ...a, observation: acronymizeLabels(a.observation), evidence: a.evidence ? acronymizeLabels(a.evidence) : a.evidence }
    ) ?? anomaliesList.map(acronymizeLabels),
    key_findings: insight.key_findings?.map((f) => ({
      ...f,
      finding: acronymizeLabels(f.finding),
      evidence: f.evidence ? acronymizeLabels(f.evidence) : f.evidence,
    })),
    recommended_actions: insight.recommended_actions?.map((a) => ({
      ...a,
      action: acronymizeLabels(a.action),
      reason: a.reason ? acronymizeLabels(a.reason) : a.reason,
    })),
    kpi_callouts: insight.kpi_callouts?.map((k) => ({
      ...k,
      label: acronymizeLabels(k.label),
      context: k.context ? acronymizeLabels(k.context) : k.context,
      delta: k.delta ? acronymizeLabels(k.delta) : k.delta,
    })),
    performance_comparison: insight.performance_comparison?.map(acronymizeLabels),
    risks: insight.risks?.map(acronymizeLabels),
    limitations: insight.limitations?.map(acronymizeLabels),
  };
}

/**
 * Main Evidence-First Summary Generation Engine.
 * Produces deep, professional, evidence-grounded Business Intelligence narratives.
 */
export function generateEvidenceBasedSummary(ctx: SummaryContext): QueryInsight {
  const { question, sql, status, error, rows, columns, rowCount, datasetName, tableName, queryPlan, semanticSchema } = ctx;
  const entity = inferEntity(tableName, datasetName);

  // 1. Failure Handling
  if (status === 'error' || error) {
    const errorMsg = sanitizeText(error || 'Query execution failed in local DuckDB engine.');
    return buildLegacyPayload({
      status: 'error',
      overview: `Execution was unsuccessful: ${errorMsg}`,
      key_findings: [],
      anomalies: [],
      business_implications: [],
      recommended_actions: [],
      limitations: ['Query failed execution; no analytical claims can be derived.'],
    });
  }

  // 2. Classify Category
  const category = classifyAnalyticalIntent(question, sql, columns, rows, queryPlan);

  // 3. Handle Unsupported / Predictive Requests
  if (category === 'unsupported_request' || status === 'needs_clarification') {
    return buildLegacyPayload({
      status: 'needs_clarification',
      category: 'unsupported_request',
      overview: `The requested predictive analysis cannot be calculated from available data.`,
      key_findings: [
        {
          finding: `Dataset "${datasetName}" contains observational records but lacks predictive model outputs or historical churn labels.`,
          importance: 'high',
        },
      ],
      anomalies: [],
      business_implications: [],
      recommended_actions: [
        {
          action: 'Analyze deterministic attributes such as current churn_status, support_tickets, or NPS scores.',
          reason: 'Observational metrics provide verified ground truth without speculative models',
          priority: 'medium',
        },
      ],
      limitations: [
        'The dataset does not contain predictive models, forward-looking forecast labels, or multi-period time-series features necessary to predict future outcomes.',
      ],
    });
  }

  // 4. Empty Result Set Handling
  if (rowCount === 0 || !rows || rows.length === 0) {
    return buildLegacyPayload({
      status: 'empty',
      category: 'filtering_retrieval',
      overview: `No records matched the specified criteria in ${datasetName}.`,
      key_findings: [
        {
          finding: `Zero records satisfied the active query filters in "${datasetName}".`,
          evidence: `DuckDB returned 0 rows for query`,
          importance: 'low',
        },
      ],
      anomalies: [],
      business_implications: [],
      recommended_actions: [
        {
          action: 'Review or relax filter criteria to broaden the search scope.',
          reason: 'No records matched current filter conditions',
          priority: 'low',
        },
      ],
      limitations: ['Zero rows returned; statistical aggregations cannot be computed on empty results.'],
    });
  }

  // Profile columns
  const profile = profileColumns(columns, rows);
  profile.currencySources = selectCurrencySources(sql, columns, semanticSchema);
  // An alias the provider chose ("plan_total") must not decide whether a sum of mrr_usd
  // reads as money, so every formatted value in the narrative consults the SQL mapping.
  const fmtValue = (value: any, column: string) => formatMetricValue(value, column, profile.currencySources);

  let overview = '';
  const key_findings: KeyFinding[] = [];
  const performance_comparison: string[] = [];
  const anomalies: AnomalyObservation[] = detectEvidenceAnomalies(rows, columns, category);
  const business_implications: BusinessImplication[] = [];
  const recommended_actions: RecommendedAction[] = [];
  const limitations: string[] = [];

  // =========================================================================
  // SINGLE COMPUTED SHARE: one row, one ratio column, no grouping dimension
  // =========================================================================
  const ratioCol = profile.numericCols.find((c) => /(pct|percent|ratio|share)/i.test(c));
  const textCols = columns.filter((c) => !profile.numericCols.includes(c));
  if (rows.length === 1 && profile.numericCols.length === 1 && textCols.length === 0 && ratioCol) {
    const ratioVal = Number(rows[0][ratioCol]);
    const readable = Number.isFinite(ratioVal) ? Number(ratioVal.toFixed(2)) : null;
    const aux = ctx.auxStats;
    const baseTotal = aux?.overallTotal !== undefined ? Number(aux.overallTotal) : null;

    const findings: KeyFinding[] = [];
    if (readable !== null && baseTotal !== null && Number.isFinite(baseTotal) && baseTotal > 0) {
      findings.push({
        finding: `The query isolates ${readable}% of the ${formatMetricValue(baseTotal)} dataset-wide total this measure represents.`,
        evidence: `${ratioCol} = ${rows[0][ratioCol]}; overall total = ${baseTotal}`,
        importance: 'high',
      });
    } else {
      findings.push({
        finding: `${ratioCol.replace(/_/g, ' ')} is reported as ${readable === null ? 'N/A' : `${readable}%`} by the executed query.`,
        evidence: `${ratioCol} = ${rows[0][ratioCol]}`,
        importance: 'high',
      });
    }

    return buildLegacyPayload({
      status: 'verified',
      category: 'segmentation',
      overview: readable === null
        ? `The query returned a single computed share (${ratioCol}) that could not be read as a percentage.`
        : `Share of the measured total: ${readable}%.`,
      key_findings: findings,
      performance_comparison: [],
      anomalies: detectEvidenceAnomalies(rows, columns, 'segmentation'),
      business_implications: [],
      recommended_actions: [
        {
          action: `Confirm the numerator and denominator behind ${ratioCol.replace(/_/g, ' ')} before acting on this share.`,
          reason: 'A computed ratio is only meaningful against the exact measure it was derived from',
          priority: 'low',
        },
      ],
      limitations: [
        'A ratio result carries no per-record detail, so no individual account, trend or causal driver can be inferred from it.',
      ],
    });
  }

  // =========================================================================
  // SINGLE-ROW KPI BOARD: one row, several numeric measures, no grouping column
  // =========================================================================
  const kpiTextCols = columns.filter((c) => !profile.numericCols.includes(c) && typeof rows[0]?.[c] === 'string');
  if (rows.length === 1 && profile.numericCols.length >= 2 && kpiTextCols.length === 0) {
    const measures = profile.numericCols;
    const readable = measures
      .map((c) => `${c.replace(/_/g, ' ')} ${formatMetricValue(rows[0][c], c)}`)
      .join(', ');
    const kpiFindings: KeyFinding[] = measures.map((c) => ({
      finding: `${c.replace(/_/g, ' ').toUpperCase()}: ${formatMetricValue(rows[0][c], c)}.`,
      evidence: `${c} = ${rows[0][c]}`,
      importance: 'high',
    }));

    const aux = ctx.auxStats;
    const totalCountCol = measures.find((c) => /^(customer|record|entity|row)_count$|^count$/i.test(c));
    const splitCols = measures.filter((c) => /^(active|cancelled|churned|at_risk)_/i.test(c));
    const kpiLimitations: string[] = [];

    if (splitCols.length === 2 && totalCountCol && aux?.overallCount === undefined) {
      const positive = Number(rows[0][splitCols[0]]);
      const negative = Number(rows[0][splitCols[1]]);
      const total = Number(rows[0][totalCountCol]);
      // Only state a split when the two counts genuinely account for the whole population.
      if (Number.isFinite(positive) && Number.isFinite(negative) && positive + negative === total) {
        const pct = ((positive / total) * 100).toFixed(1);
        kpiFindings.push({
          finding: `${splitCols[0].replace(/_/g, ' ')} account for ${pct}% of the ${total} counted ${splitCols[0].includes('customer') ? 'customers' : 'records'}; ${splitCols[1].replace(/_/g, ' ')} is the remaining ${(100 - Number(pct)).toFixed(1)}%.`,
          evidence: `${splitCols[0]}=${positive}, ${splitCols[1]}=${negative}, ${totalCountCol}=${total}`,
          importance: 'high',
        });
        kpiLimitations.push('Status is read as recorded in this dataset; no separate churn flag, reason or renewal date is available to qualify it.');
      }
    }

    // A "<qualifier>_<x>" column next to "total_<x>" in the same row is a subset of that total,
    // so its share is a fact of the returned row and needs no extra query.
    const shareSentences: string[] = [];
    for (const totalCol of measures.filter((c) => /^(total|overall|all)_/i.test(c))) {
      const suffix = totalCol.replace(/^(total|overall|all)_/i, '').toLowerCase();
      const totalVal = Number(rows[0][totalCol]);
      if (!suffix || !Number.isFinite(totalVal) || totalVal <= 0) continue;
      for (const partCol of measures) {
        if (partCol === totalCol || /^(total|overall|all)_/i.test(partCol)) continue;
        const m = partCol.toLowerCase().match(/^([a-z][a-z0-9]*(?:_[a-z0-9]+)*?)_(.+)$/);
        if (!m || m[2] !== suffix || /^(avg|average|mean|median|min|max|pct|percent|share|rate|ratio|std|stddev|var)$/.test(m[1])) continue;
        const partVal = Number(rows[0][partCol]);
        if (!Number.isFinite(partVal) || partVal < 0 || partVal > totalVal) continue;
        const pct = ((partVal / totalVal) * 100).toFixed(1);
        const sentence = `${partCol.replace(/_/g, ' ')} (${formatMetricValue(partVal, partCol)}) ${partVal === 1 ? 'is' : 'are'} ${pct}% of ${totalCol.replace(/_/g, ' ')} (${formatMetricValue(totalVal, totalCol)})`;
        shareSentences.push(sentence);
        kpiFindings.push({
          finding: `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`,
          evidence: `${partCol} / ${totalCol} = ${partVal} / ${totalVal}`,
          importance: 'high',
        });
      }
    }

    if (aux?.overallCount !== undefined && aux?.filteredCount !== undefined) {
      kpiLimitations.push('Figures describe the cohort the query selected, not the full dataset.');
    } else {
      kpiLimitations.push('These are point-in-time aggregates over the rows the query returned; no period-over-period comparison is possible from a single snapshot.');
    }

    return buildLegacyPayload({
      status: 'verified',
      category: 'multi_metric',
      overview: `The query returns one summary row: ${readable}.${shareSentences.length ? ` ${shareSentences.map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join('; ')}.` : ''}`,
      key_findings: kpiFindings,
      performance_comparison: [],
      anomalies: detectEvidenceAnomalies(rows, columns, 'multi_metric'),
      business_implications: [],
      recommended_actions: [],
      limitations: kpiLimitations,
    });
  }

  // =========================================================================
  // STRATEGY 0: TIME TREND
  // =========================================================================
  if (category === 'time_trend') {
    const trend = buildTimeTrendInsight(rows, columns, queryPlan, entity);
    if (trend) return buildLegacyPayload(trend);
  }

  // =========================================================================
  // STRATEGY 1: SIMPLE COUNT
  // =========================================================================
  if (category === 'simple_count') {
    // A count is only ever read from a column that actually counts; falling back to
    // columns[0] would print an unrelated measure (a rate, an id) as the record count.
    const isRatioColumn = (c: string) => /(pct|percent|ratio|share|margin|rate)/i.test(c);
    const countCol =
      profile.totalCountCol ||
      columns.find((c) => !isRatioColumn(c) && /(count|number|total|records|customers|accounts)/i.test(c.toLowerCase()));
    const countVal = countCol !== undefined && rows[0][countCol] !== undefined ? rows[0][countCol] : rowCount;
    const formattedCount = formatMetricValue(countVal, countCol || '');

    const isFiltered = sql.toUpperCase().includes('WHERE');
    const filterDesc = isFiltered ? describeWhereClause(sql) : null;
    if (isFiltered) {
      overview = filterDesc
        ? `${formattedCount} ${entity.plural} ${filterDesc} were found in ${datasetName}.`
        : `Your dataset contains ${formattedCount} ${entity.plural} matching the specified filter criteria.`;

      const aux = ctx.auxStats;
      if (aux?.overallCount !== undefined && aux.overallCount > 0) {
        const sharePct = ((Number(countVal) / aux.overallCount) * 100).toFixed(1);
        overview += ` This is ${sharePct}% of the total ${aux.overallCount} ${entity.plural} in the dataset.`;
        business_implications.push({
          implication: `${formattedCount} of ${aux.overallCount} ${entity.plural} (${sharePct}%) satisfy the applied filter, indicating how concentrated this cohort is within ${datasetName}.`,
          confidence: 'high',
        });
      }
    } else {
      overview = `Your dataset contains ${formattedCount} ${/COUNT\s*\(\s*DISTINCT/i.test(sql) ? 'distinct ' : ''}${entity.plural}.`;
    }

    key_findings.push({
      finding: `Total count: ${formattedCount} verified ${entity.plural} recorded in ${datasetName}.`,
      evidence: `${countCol ?? 'COUNT(*)'} = ${countVal}`,
      importance: 'high',
    });

    recommended_actions.push({
      action: `Consider segment-level or geographic breakdowns to understand the ${entity.singular} base in greater detail.`,
      reason: 'Gain deeper distribution visibility',
      priority: 'low',
    });
  }

  // =========================================================================
  // STRATEGY 2: TOTAL SUM
  // =========================================================================
  else if (category === 'total_sum') {
    const sumCol = profile.totalRevenueCol || profile.numericCols[0] || columns[0];
    const sumVal = rows[0][sumCol];
    const formattedSum = formatMetricValue(sumVal, sumCol);
    const metricLabel = sumCol.replace(/^(total_|sum_)/i, '').replace(/_/g, ' ').toUpperCase();
    const filterDesc = describeWhereClause(sql);
    const aux = ctx.auxStats;
    const totalEntities = aux?.overallCount ?? semanticSchema?.rowCount ?? rows.length;

    if (filterDesc) {
      // FILTERED TOTAL: surface the filter context, dataset share, and record-level detail.
      let sharePct: number | null = null;
      if (aux?.overallTotal !== undefined && Number(aux.overallTotal) > 0) {
        sharePct = (Number(sumVal) / Number(aux.overallTotal)) * 100;
      }

      overview = `Total ${metricLabel} ${filterDesc} is ${formattedSum}.`;
      if (sharePct !== null) {
        overview += ` This represents ${sharePct.toFixed(1)}% of the overall ${metricLabel} of ${formatMetricValue(aux!.overallTotal, sumCol)} across ${totalEntities} ${entity.plural}.`;
      }

      key_findings.push({
        finding: `Aggregate ${metricLabel} ${filterDesc}: ${formattedSum}.`,
        evidence: `${sumCol} = ${sumVal}`,
        importance: 'high',
      });

      if (aux?.filteredCount !== undefined) {
        key_findings.push({
          finding: `${aux.filteredCount} of ${totalEntities} ${entity.plural} in ${datasetName} match the applied filter (${filterDesc.replace(/^where /, '')}).`,
          evidence: `Filtered COUNT(*) = ${aux.filteredCount} of ${totalEntities}`,
          importance: 'high',
        });

        if (aux.filteredCount > 0 && Number(sumVal) > 0) {
          const perRecord = Number(sumVal) / aux.filteredCount;
          key_findings.push({
            finding: `Average ${metricLabel} per matching ${entity.singular} is ${formatMetricValue(perRecord, sumCol)}.`,
            evidence: `${sumVal} / ${aux.filteredCount} = ${perRecord.toFixed(2)}`,
            importance: 'medium',
          });
        }
      }

      if (sharePct !== null) {
        business_implications.push({
          implication: `The subset ${filterDesc} carries ${sharePct.toFixed(1)}% of the total ${metricLabel} in ${datasetName}, quantifying the relative weight of this segment within the overall ${entity.singular} base.`,
          confidence: 'high',
        });

        recommended_actions.push({
          action: `Investigate the factors behind the ${sharePct.toFixed(1)}% ${metricLabel} share ${filterDesc} to determine whether this segment can be reduced, recovered, or grown.`,
          reason: `${formattedSum} (${sharePct.toFixed(1)}% of total) is directly tied to the filtered cohort`,
          priority: sharePct >= 20 ? 'high' : 'medium',
        });
      }

      limitations.push('Historical revenue trends or comparisons cannot be established from single-period snapshot data.');
    } else {
      overview = `Total ${metricLabel} across all ${totalEntities} ${totalEntities === 1 ? entity.singular : entity.plural} is ${formattedSum}.`;

      key_findings.push({
        finding: `Aggregate ${metricLabel}: ${formattedSum} across verified ${entity.plural}.`,
        evidence: `${sumCol} = ${sumVal}`,
        importance: 'high',
      });

      limitations.push('Historical revenue trends or comparisons cannot be established from single-period snapshot data.');
    }
  }

  // =========================================================================
  // STRATEGY 3: STATISTICAL AGGREGATION
  // =========================================================================
  else if (category === 'statistical_aggregation') {
    const avgCol = profile.avgRevenueCol || profile.numericCols[0] || columns[0];
    const avgVal = rows[0][avgCol];
    const formattedAvg = formatMetricValue(avgVal, avgCol);
    const filterDesc = describeWhereClause(sql);

    overview = filterDesc
      ? `Average ${avgCol.replace(/^(avg_|average_)/i, '').toUpperCase()} ${filterDesc} is ${formattedAvg}.`
      : `Average ${avgCol.replace(/^(avg_|average_)/i, '').toUpperCase()} across ${entity.plural} is ${formattedAvg}.`;

    key_findings.push({
      finding: `Calculated average: ${formattedAvg}.`,
      evidence: `${avgCol} = ${avgVal}`,
      importance: 'high',
    });

    limitations.push('Averages can be influenced by outlier values in skewed distributions.');
  }

  // =========================================================================
  // STRATEGY 4: MULTI-METRIC OR GROUPED CATEGORICAL COMPARISON
  // =========================================================================
  else if (category === 'multi_metric' || category === 'grouped_comparison' || category === 'segmentation') {
    const dimCol = profile.dimensionCol;
    const hasMultipleMetrics = profile.numericCols.length >= 2;

    // Check if we have revenue metrics and count metrics
    const revCol = profile.totalRevenueCol || profile.activeRevenueCol || profile.avgRevenueCol || profile.numericCols.find((c) => profile.currencySources?.has(c) && c !== profile.shareCol && c !== profile.activeRateCol) || profile.numericCols.find((c) => c.toLowerCase().includes('mrr') || c.toLowerCase().includes('sales'));
    const avgCol = profile.avgRevenueCol || (profile.totalRevenueCol && profile.totalCountCol ? null : null);
    const countCol = profile.totalCountCol || profile.activeCountCol || profile.numericCols.find((c) => c.toLowerCase().includes('count') || c.toLowerCase().includes('customer'));
    const rateCol = profile.activeRateCol || profile.numericCols.find((c) => c !== profile.shareCol && (c.toLowerCase().includes('pct') || c.toLowerCase().includes('percent') || c.toLowerCase().includes('rate')));
    // A percentage column is not necessarily an activation measure: usage_pct says nothing
    // about how many customers are active, so it must be named by its own column.
    const rateIsActivation = Boolean(rateCol) && /activ|retention|engagement_rate/i.test(String(rateCol));
    const rateLabel = rateIsActivation ? 'activation rate' : rateCol ? String(rateCol).replace(/_/g, ' ') : '';

    if (dimCol && rows.length > 1) {
      // Every non-numeric column participates in the grouping, so a row must never be
      // labelled by one dimension alone when the query grouped by several.
      const groupCols = columns.filter((c) => !profile.numericCols.includes(c));
      const groupLabel = (r: Record<string, any>) =>
        groupCols.map((c) => String(r[c] ?? '').trim()).filter(Boolean).join(' / ') || String(r[dimCol] ?? '');
      // 1. Calculate Grand Totals across all returned rows
      const totalRevAll = revCol ? rows.reduce((acc, r) => acc + (Number(r[revCol]) || 0), 0) : 0;
      const totalCustAll = countCol ? rows.reduce((acc, r) => acc + (Number(r[countCol]) || 0), 0) : 0;

      // 2. Identify Leaders across Key Dimensions
      // Leader by Total Revenue
      const rowsSortedByRev = revCol ? [...rows].sort((a, b) => (Number(b[revCol]) || 0) - (Number(a[revCol]) || 0)) : rows;
      const topRevRow = rowsSortedByRev[0];
      const lowestRevRow = rowsSortedByRev[rowsSortedByRev.length - 1];

      // Leader by Average Revenue
      let rowsSortedByAvg: Record<string, any>[] = [];
      let topAvgRow: Record<string, any> | null = null;
      if (avgCol) {
        rowsSortedByAvg = [...rows].sort((a, b) => (Number(b[avgCol]) || 0) - (Number(a[avgCol]) || 0));
        topAvgRow = rowsSortedByAvg[0];
      } else if (revCol && countCol) {
        // Compute derived average
        rowsSortedByAvg = [...rows].sort((a, b) => {
          const avgA = (Number(a[revCol]) || 0) / (Number(a[countCol]) || 1);
          const avgB = (Number(b[revCol]) || 0) / (Number(b[countCol]) || 1);
          return avgB - avgA;
        });
        topAvgRow = rowsSortedByAvg[0];
      }

      // Leader by Customer Count
      const rowsSortedByCount = countCol ? [...rows].sort((a, b) => (Number(b[countCol]) || 0) - (Number(a[countCol]) || 0)) : rows;
      const topCountRow = rowsSortedByCount[0];

      // Leader by Active Rate
      const rowsSortedByRate = rateCol ? [...rows].sort((a, b) => (Number(b[rateCol]) || 0) - (Number(a[rateCol]) || 0)) : rows;
      const topRateRow = rateCol ? rowsSortedByRate[0] : null;
      const lowestRateRow = rateCol ? rowsSortedByRate[rowsSortedByRate.length - 1] : null;

      // =====================================================================
      // EXECUTIVE OVERVIEW SYNTHESIS
      // =====================================================================
      const topRevName = groupLabel(topRevRow);
      const topRevVal = revCol ? fmtValue(topRevRow[revCol], revCol) : '';
      const topAvgName = topAvgRow ? groupLabel(topAvgRow) : null;
      const topAvgVal = topAvgRow && avgCol ? fmtValue(topAvgRow[avgCol], avgCol) : null;
      const topCountName = groupLabel(topCountRow);
      const topCountVal = countCol ? topCountRow[countCol] : null;
      // Naming a group by one column when the query grouped by several would credit that
      // combination's total to the whole category, and a shared maximum is a tie, not a lead.
      const dimNoun = groupCols.length > 1 ? 'group' : dimCol.toLowerCase();
      const tiedAt = (col: string | null, row: Record<string, any> | null) =>
        col && row ? rows.filter((r) => Number(r[col]) === Number(row[col])) : [];
      // A shared maximum or minimum is a tie, so the overview must not name one leader for it.
      const extremes = (col: string, sorted: Record<string, any>[], noun: string) => {
        const hi = sorted[0];
        const lo = sorted[sorted.length - 1];
        const hiTied = tiedAt(col, hi);
        const loTied = tiedAt(col, lo);
        const hiVal = fmtValue(hi[col], col);
        const loVal = fmtValue(lo[col], col);
        const verb = (n: number) => (n === 2 ? 'are' : 'are all');
        if (hiTied.length === sorted.length) {
          return `All ${sorted.length} returned groups record the same ${noun} (${hiVal}).`;
        }
        const hiPart =
          hiTied.length > 1
            ? `${joinSeries(hiTied.map(groupLabel))} ${verb(hiTied.length)} tied for the highest ${noun} at ${hiVal}`
            : `${groupLabel(hi)} has the highest ${noun} at ${hiVal}`;
        const loPart =
          loTied.length > 1
            ? `${joinSeries(loTied.map(groupLabel))} ${verb(loTied.length)} tied for the lowest at ${loVal}`
            : `${groupLabel(lo)} has the lowest at ${loVal}`;
        return `${hiPart}, while ${loPart}.`;
      };

      // Check if this is a direct single-metric average query (e.g. "What is the average MRR by customer segment?")
      const isSingleAverageQuery = (question.toLowerCase().includes('average') || question.toLowerCase().includes('avg')) &&
        !rateCol && !question.toLowerCase().includes('active') && !question.toLowerCase().includes('channel') && !question.toLowerCase().includes('city');

      // Check if Delhi/Outlier low activation pattern exists (e.g. City comparison)
      const hasSevereLowOutlier = Boolean(revCol) && rateIsActivation && lowestRateRow && rateCol && (Number(lowestRateRow[rateCol]) <= 40);
      const allOther100 = rateIsActivation && rateCol && rows.filter((r) => r !== lowestRateRow).every((r) => Number(r[rateCol]) === 100);
      const rateNoun = rateIsActivation ? 'active customer rate' : rateLabel;

      if (isSingleAverageQuery) {
        const targetCol = profile.avgRevenueCol || profile.numericCols.find((c) => c.toLowerCase().includes('mrr') || c.toLowerCase().includes('avg')) || profile.numericCols[0] || columns[1];
        const metricLabel = targetCol.replace(/^(avg_|sum_|total_)/i, '').replace(/_/g, ' ');
        const sorted = [...rows].sort((a, b) => (Number(b[targetCol]) || 0) - (Number(a[targetCol]) || 0));
        overview = extremes(targetCol, sorted, `average ${metricLabel}`);

        sorted.forEach((r) => {
          key_findings.push({
            finding: `${groupLabel(r)}: ${metricLabel} is ${fmtValue(r[targetCol], targetCol)}${
              r.customer_count ? ` (${r.customer_count} ${entity.plural})` : ''
            }.`,
            evidence: `${groupCols.map((c) => `${c}="${r[c]}"`).join(', ')}; ${targetCol}=${r[targetCol]}`,
            importance: 'medium',
          });
        });

        const highestValNum = Number(sorted[0][targetCol]);
        const lowestValNum = Number(sorted[sorted.length - 1][targetCol]);
        if (lowestValNum > 0 && highestValNum / lowestValNum >= 1.5) {
          const mult = (highestValNum / lowestValNum).toFixed(1);
          key_findings.push({
            finding: `${groupLabel(sorted[0])}'s average ${metricLabel} is approximately ${mult} times that of ${groupLabel(sorted[sorted.length - 1])}.`,
            evidence: `Calculated ratio: ${highestValNum} / ${lowestValNum}`,
            importance: 'high',
          });
        }
      } else if (hasSevereLowOutlier && lowestRateRow && allOther100) {
        const outlierRev = revCol ? fmtValue(lowestRateRow[revCol], revCol) : '';
        const outlierActive = profile.activeCountCol ? lowestRateRow[profile.activeCountCol] : '';
        const outlierTotal = profile.totalCountCol ? lowestRateRow[profile.totalCountCol] : '';
        const secondRevRow = rowsSortedByRev[1];

        overview = `${topRevName} leads ${dimNoun}-level ${revCol?.toLowerCase() || 'revenue'} at ${topRevVal}${
          secondRevRow && revCol ? `, followed by ${groupLabel(secondRevRow)} at ${fmtValue(secondRevRow[revCol], revCol)}` : ''
        }. ${groupLabel(lowestRateRow)} is a significant outlier, generating only ${outlierRev} in ${revCol?.toLowerCase() || 'revenue'} with ${outlierActive} of its ${outlierTotal} customers active. All ${countCol && rows[0][countCol] ? rows[0][countCol] : ''} customers in ${rows
          .filter((r) => rateCol && Number(r[rateCol]) === 100)
          .map((r) => groupLabel(r))
          .join(', ')} are active.`;
      }
      // Top revenue and top average differ (e.g. Channel comparison: Referral vs Partner)
      else if (topAvgName && topAvgName !== topRevName && revCol && avgCol) {
        overview = `${topRevName} is the largest total-${revCol.replace(/^(total_|sum_)/i, '').replace(/_/g, ' ')} contributor at ${topRevVal}, while ${topAvgName} delivers the highest average ${revCol.replace(/^(total_|sum_)/i, '').replace(/_/g, ' ')} per customer at ${topAvgVal}.${
          rateIsActivation && rateCol && topRateRow && rowsSortedByRate[1] && Number(topRateRow[rateCol]) === 100 && Number(rowsSortedByRate[1][rateCol]) === 100
            ? ` ${groupLabel(topRateRow)} and ${groupLabel(rowsSortedByRate[1])} both show 100% active customer rates, so their average revenue contributions differ on account value rather than on activation.`
            : ''
        }`;
      }
      // Top revenue is also top average (e.g. Enterprise segment)
      else if (topRevRow && revCol) {
        overview = `${topRevName} is the strongest revenue-generating ${dimNoun}, contributing ${topRevVal} in ${revCol.replace(/^(total_|sum_)/i, '').replace(/_/g, ' ')}${
          countCol && topRevRow[countCol] ? ` across ${topRevRow[countCol]} customers` : ''
        }${topAvgVal ? ` and achieving the highest average ${avgCol?.replace(/^(avg_|average_)/i, '').replace(/_/g, ' ') || 'revenue'} of ${topAvgVal}` : ''}.${
          topCountName !== topRevName && rateCol && topCountRow[rateCol]
            ? ` ${topCountName} has the largest customer base (${topCountVal}) and ${rateNoun} of ${fmtValue(topCountRow[rateCol], rateCol)}${
                avgCol && topCountRow[avgCol] && topAvgVal
                  ? `, but its average ${avgCol.replace(/^(avg_|total_)/i, '').replace(/_/g, ' ')} is ${fmtValue(topCountRow[avgCol], avgCol)} against ${topAvgVal} for ${topRevName}`
                  : ''
              }.`
            : ''
        }`;
      } else {
        // Clean grouped comparison overview
        const targetCol = profile.numericCols.find((c) => question.toLowerCase().includes(c.toLowerCase())) || profile.numericCols[0] || columns[1];
        const sorted = [...rows].sort((a, b) => (Number(b[targetCol]) || 0) - (Number(a[targetCol]) || 0));
        // Calling a count column an "average" invents a measure the query never computed.
        const plainLabel = targetCol.replace(/^(avg_|average_)/i, '').replace(/_/g, ' ');
        const noun = /^avg_|^average_/i.test(targetCol) ? `average ${plainLabel}` : plainLabel;
        overview = extremes(targetCol, sorted, noun);
      }

      // =====================================================================
      // KEY FINDINGS (3-5 Bullet Points with Calculations)
      // =====================================================================
      // 1. Revenue Leadership & Contribution Percentage
      if (!isSingleAverageQuery && revCol && totalRevAll > 0 && topRevRow) {
        const revSharePct = ((Number(topRevRow[revCol]) / totalRevAll) * 100).toFixed(1);
        const custSharePct = totalCustAll > 0 && countCol ? ((Number(topRevRow[countCol]) / totalCustAll) * 100).toFixed(1) : null;
        const revTied = tiedAt(revCol, topRevRow);

        key_findings.push({
          finding:
            revTied.length > 1
              ? `${joinSeries(revTied.map(groupLabel))} ${revTied.length === 2 ? 'are' : 'are all'} tied for the highest ${revCol.replace(/_/g, ' ')} at ${topRevVal}, each contributing ${revSharePct}% of the ${fmtValue(totalRevAll, revCol)} returned across ${rows.length} groups.`
              : `${topRevName} leads in ${revCol.replace(/_/g, ' ')} with ${topRevVal}${
                  totalRevAll > 0 ? `, contributing approximately ${revSharePct}% of the ${revCol.replace(/_/g, ' ')} across all ${rows.length} returned groups (${topRevVal} out of ${fmtValue(totalRevAll, revCol)})` : ''
                }${custSharePct ? `, despite representing only ${custSharePct}% of customers` : ''}.`,
          evidence: `${topRevName}: ${topRevVal} / ${fmtValue(totalRevAll, revCol)}`,
          importance: 'high',
        });
      }

      // 1a. Cumulative concentration read from the query's own share-of-total column
      const shareCol = profile.shareCol;
      if (!isSingleAverageQuery && shareCol && rows.length >= 3) {
        const byShare = [...rows].sort((a, b) => (Number(b[shareCol]) || 0) - (Number(a[shareCol]) || 0));
        const isFraction = rows.every((r) => Math.abs(Number(r[shareCol]) || 0) <= 1);
        const shareOf = (r: Record<string, any>) => (Number(r[shareCol]) || 0) * (isFraction ? 100 : 1);
        const asPct = (v: number) => `${Number(v.toFixed(1))}%`;
        const topTwo = shareOf(byShare[0]) + shareOf(byShare[1]);
        const smallest = byShare[byShare.length - 1];
        const shareSum = byShare.reduce((acc, r) => acc + shareOf(r), 0);
        const shareLabel = shareCol.replace(/_/g, ' ');
        key_findings.push({
          finding: `${groupLabel(byShare[0])} and ${groupLabel(byShare[1])} together hold ${asPct(topTwo)} of the total; ${groupLabel(smallest)} holds the smallest share at ${asPct(shareOf(smallest))}.${
            shareSum < 99.5 ? ` The returned groups add up to ${asPct(shareSum)}, so the remaining ${asPct(100 - shareSum)} sits outside this result.` : ''
          }`,
          evidence: `${shareLabel}: ${byShare.map((r) => `${groupLabel(r)}=${r[shareCol]}`).join(', ')}`,
          importance: 'high',
        });
      }

      // 1b. Specific Metric Leaders for multi-metric queries (e.g. active MRR vs total MRR)
      if (!isSingleAverageQuery && profile.numericCols.length >= 2) {
        profile.numericCols.forEach((col) => {
          if (col !== revCol && col !== avgCol && col !== shareCol) {
            const topRow = [...rows].sort((a, b) => (Number(b[col]) || 0) - (Number(a[col]) || 0))[0];
            if (topRow && !key_findings.some((f) => f.finding.toLowerCase().includes(col.replace(/_/g, ' ')))) {
              const tied = tiedAt(col, topRow);
              const value = fmtValue(topRow[col], col);
              key_findings.push({
                finding:
                  tied.length === rows.length
                    ? `Every returned group records the same ${col.replace(/_/g, ' ')} (${value}), so this measure does not separate them.`
                    : tied.length > 1
                      ? `${joinSeries(tied.map(groupLabel))} are tied for the highest ${col.replace(/_/g, ' ')} at ${value}.`
                      : `${groupLabel(topRow)} leads in ${col.replace(/_/g, ' ')} with ${value}.`,
                evidence: `${col} = ${topRow[col]} in ${groupLabel(topRow)}`,
                importance: 'medium',
              });
            }
          }
        });
      }

      // 2. Average Revenue Multiples or Top-2 Gap
      if (!isSingleAverageQuery && avgCol && rowsSortedByAvg.length >= 2) {
        const avgLabel = avgCol.replace(/^(avg_|average_|sum_|total_)/i, '').replace(/_/g, ' ');
        const firstAvgRow = rowsSortedByAvg[0];
        const topAvgValNum = Number(firstAvgRow[avgCol]);
        const secondAvgRow = rowsSortedByAvg[1];
        const secondAvgValNum = Number(secondAvgRow[avgCol]);
        const lowestAvgRow = rowsSortedByAvg[rowsSortedByAvg.length - 1];
        const lowestAvgValNum = Number(lowestAvgRow[avgCol]);

        // If top average is a different group (e.g. Partner > Referral)
        if (firstAvgRow && topRevRow && groupLabel(firstAvgRow) !== groupLabel(topRevRow) && secondAvgValNum > 0) {
          const diffPct = (((topAvgValNum - secondAvgValNum) / secondAvgValNum) * 100).toFixed(0);
          key_findings.push({
            finding: `${groupLabel(firstAvgRow)} has the highest average ${avgLabel} per customer (${fmtValue(topAvgValNum, avgCol)}), approximately ${diffPct}% higher than ${groupLabel(secondAvgRow)} at ${fmtValue(secondAvgValNum, avgCol)}.`,
            evidence: `${groupLabel(firstAvgRow)} (${topAvgValNum}) vs ${groupLabel(secondAvgRow)} (${secondAvgValNum})`,
            importance: 'high',
          });
        }
        // Spread between the highest and lowest grouped averages
        else if (lowestAvgValNum > 0 && topAvgValNum / lowestAvgValNum >= 1.5) {
          const lowestMult = (topAvgValNum / lowestAvgValNum).toFixed(1);
          const secondMult = secondAvgValNum > 0 && rowsSortedByAvg.length > 2 && topAvgValNum / secondAvgValNum >= 1.05 ? (topAvgValNum / secondAvgValNum).toFixed(1) : null;

          key_findings.push({
            finding: `${groupLabel(firstAvgRow)}'s average ${avgLabel} is approximately ${lowestMult} times that of ${groupLabel(lowestAvgRow)} (${fmtValue(topAvgValNum, avgCol)} vs ${fmtValue(lowestAvgValNum, avgCol)})${
              secondMult ? `, and ${secondMult} times the next-highest group ${groupLabel(secondAvgRow)}` : ''
            }.`,
            evidence: `Calculated ratio ${topAvgValNum} / ${lowestAvgValNum} across the grouped ${avgLabel}`,
            importance: 'high',
          });
        }
      }

      // 3. Rate Cohorts and Extremes
      if (rateCol && lowestRateRow && topRateRow) {
        const fullRateRows = rows.filter((r) => Number(r[rateCol]) === 100);
        if (fullRateRows.length >= 2) {
          key_findings.push({
            finding: `${joinSeries(fullRateRows.map(groupLabel))} each record ${rateIsActivation ? 'a 100% active customer rate' : `100% ${rateLabel}`}.`,
            evidence: `${rateCol} = 100 in ${fullRateRows.length} groups`,
            importance: 'medium',
          });
        } else {
          key_findings.push({
            finding: `${groupLabel(topRateRow)} has the ${rateIsActivation ? 'strongest activation rate' : `highest ${rateLabel}`} at ${fmtValue(topRateRow[rateCol], rateCol)}${
              rowsSortedByRate[1] ? `, followed by ${groupLabel(rowsSortedByRate[1])} at ${fmtValue(rowsSortedByRate[1][rateCol], rateCol)}` : ''
            }.`,
            evidence: `${rateCol} ranking across groups`,
            importance: 'medium',
          });
        }

        // Lowest rate finding
        const lowestRateVal = Number(lowestRateRow[rateCol]);
        const lowestActiveCount = rateIsActivation && profile.activeCountCol ? lowestRateRow[profile.activeCountCol] : null;
        const lowestTotalCount = rateIsActivation && profile.totalCountCol ? lowestRateRow[profile.totalCountCol] : null;

        key_findings.push({
          finding: `${groupLabel(lowestRateRow)} has the ${rateIsActivation ? 'lowest activation rate' : `lowest ${rateLabel}`} at ${fmtValue(lowestRateVal, rateCol)}${
            lowestActiveCount !== null && lowestTotalCount !== null ? `, with ${lowestActiveCount} of its ${lowestTotalCount} customers active` : ''
          }.`,
          evidence: `Lowest ${rateCol} in ${groupLabel(lowestRateRow)}`,
          importance: 'high',
        });
      }

      // 4. Relative Outlier Drop or Customer Efficiency
      if (revCol && rowsSortedByRev.length >= 2) {
        const topRevValNum = Number(topRevRow[revCol]);
        const lowestRevValNum = Number(lowestRevRow[revCol]);

        // If severe outlier drop (e.g. Delhi MRR is 93.9% lower than Chennai)
        if (hasSevereLowOutlier && topRevValNum > 0 && lowestRevValNum < topRevValNum * 0.2) {
          const dropPct = (((topRevValNum - lowestRevValNum) / topRevValNum) * 100).toFixed(1);
          key_findings.push({
            finding: `${groupLabel(lowestRevRow)}'s ${revCol.replace(/_/g, ' ')} is approximately ${dropPct}% lower than ${groupLabel(topRevRow)}'s.`,
            evidence: `Relative spread between ${groupLabel(lowestRevRow)} and ${groupLabel(topRevRow)}`,
            importance: 'high',
          });
        }
        // Customer Efficiency (e.g. Partner generates $6,050 from only 5 customers)
        else if (countCol) {
          const efficientRow = rows.find(
            (r) => Number(r[countCol]) <= totalCustAll * 0.25 && Number(r[revCol]) >= totalRevAll * 0.25
          );
          if (efficientRow) {
            key_findings.push({
              finding: `${groupLabel(efficientRow)} generates ${fmtValue(efficientRow[revCol], revCol)} from only ${efficientRow[countCol]} customers, indicating comparatively high revenue per customer.`,
              evidence: `${groupLabel(efficientRow)}: ${fmtValue(efficientRow[revCol], revCol)} across ${efficientRow[countCol]} customers`,
              importance: 'medium',
            });
          }
        }
      }

      // If we still need standard per-group findings (e.g. for simple grouped query)
      if (key_findings.length < 3) {
        rows.slice(0, 4).forEach((r) => {
          const metricCol = profile.numericCols[0] || columns[1];
          key_findings.push({
            finding: `${groupLabel(r)}: ${metricCol.replace(/_/g, ' ')} is ${fmtValue(r[metricCol], metricCol)}${
              r.customer_count ? ` (${r.customer_count} ${entity.plural})` : ''
            }.`,
            evidence: `${groupCols.map((c) => `${c}="${r[c]}"`).join(', ')}; ${metricCol}=${r[metricCol]}`,
            importance: 'medium',
          });
        });
        if (rows.length > 4) {
          limitations.push(
            `The result contains ${rows.length} grouped rows across ${groupCols.join(' + ')}; this summary lists the top 4 by the ordered metric, so the remaining ${rows.length - 4} rows are described only in the table.`
          );
        }
      }

      // =====================================================================
      // PERFORMANCE COMPARISON SECTION
      // =====================================================================
      if (hasMultipleMetrics) {
        if (topRevRow && revCol) {
          const revTiedNames = tiedAt(revCol, topRevRow);
          performance_comparison.push(
            revTiedNames.length > 1
              ? `Revenue Leadership: ${joinSeries(revTiedNames.map(groupLabel))} are level at the top of ${revCol.replace(/_/g, ' ')} (${topRevVal}).`
              : `Revenue Leadership: ${topRevName} generates the most aggregate revenue at ${topRevVal}.`
          );
        }
        if (topAvgRow && avgCol) {
          const avgTiedNames = tiedAt(avgCol, topAvgRow);
          performance_comparison.push(
            avgTiedNames.length > 1
              ? `Average Value Leadership: ${joinSeries(avgTiedNames.map(groupLabel))} share the highest average revenue at ${topAvgVal} per customer.`
              : `Average Value Leadership: ${topAvgName} delivers the highest average revenue at ${topAvgVal} per customer.`
          );
        }
        if (topRateRow && rateCol) {
          performance_comparison.push(`${rateIsActivation ? 'Highest Activation' : `Highest ${rateLabel}`}: ${groupLabel(topRateRow)} records the highest ${rateNoun} at ${fmtValue(topRateRow[rateCol], rateCol)}.`);
        }
        if (lowestRateRow && rateCol) {
          performance_comparison.push(`${rateIsActivation ? 'Lowest Activation' : `Lowest ${rateLabel}`}: ${groupLabel(lowestRateRow)} records the lowest ${rateNoun} at ${fmtValue(lowestRateRow[rateCol], rateCol)}.`);
        }
        if (topCountName && countCol && topRevRow && revCol && topCountName !== topRevName) {
          const countTied = tiedAt(countCol, topCountRow);
          performance_comparison.push(
            countTied.length > 1
              ? `Volume vs Revenue: ${joinSeries(countTied.map(groupLabel))} share the largest customer volume (${topCountVal}), and none of them leads on aggregate revenue.`
              : `Volume vs Revenue: ${topCountName} holds the largest customer volume (${topCountVal}), but does not produce the highest aggregate revenue.`
          );
        }
      }

      // =====================================================================
      // BUSINESS IMPLICATIONS
      // =====================================================================
      if (topAvgRow && groupLabel(topAvgRow) !== groupLabel(topRevRow)) {
        business_implications.push({
          implication: `${topRevName} leads on aggregate revenue, while ${topAvgName} is strongest by average revenue per customer. ${
            rateIsActivation && lowestRateRow ? `${groupLabel(lowestRateRow)}'s low ${rateNoun} is a clear area for further investigation.` : ''
          }`,
          confidence: 'high',
        });
      } else if (hasSevereLowOutlier && lowestRateRow) {
        business_implications.push({
          implication: `${groupLabel(lowestRateRow)} records the lowest ${rateNoun} of the returned groups while also contributing the least revenue. ${
            rowsSortedByRev[1] && revCol && countCol
              ? `${groupLabel(rowsSortedByRev[1])} reaches ${fmtValue(rowsSortedByRev[1][revCol], revCol)} from ${rowsSortedByRev[1][countCol]} customers, against ${fmtValue(rowsSortedByRev[0][revCol], revCol)} from ${rowsSortedByRev[0][countCol]} for ${groupLabel(rowsSortedByRev[0])}.`
              : ''
          }`,
          confidence: 'high',
        });
      } else if (revCol && topRevRow && topCountRow && topRevName !== topCountName) {
        business_implications.push({
          implication: `${topRevName} contributes the most ${revCol.replace(/_/g, ' ')} (${topRevVal}) while ${topCountName} contributes the most customers (${topCountVal}); because those are different groups, volume alone does not identify where the revenue sits.`,
          confidence: 'high',
        });
      } else {
        const altCol = revCol || countCol || profile.numericCols[0] || null;
        const altRow =
          revCol && totalRevAll > 0
            ? topRevRow
            : countCol
            ? topCountRow
            : altCol
            ? [...rows].sort((a, b) => (Number(b[altCol]) || 0) - (Number(a[altCol]) || 0))[0]
            : null;
        if (altCol && altRow) {
          const altTied = tiedAt(altCol, altRow);
          const altVal = fmtValue(altRow[altCol], altCol);
          const altLabel = altCol.replace(/_/g, ' ');
          const revNote = revCol || !/revenue|mrr|\barr\b|sales/i.test(question) ? '' : '; this result set contains no revenue measure, so no revenue conclusion is drawn';
          const altLead =
            altTied.length === rows.length
              ? `Every returned group records the same ${altLabel} (${altVal})${revNote}.`
              : altTied.length > 1
              ? `${joinSeries(altTied.map(groupLabel))} ${altTied.length === 2 ? 'are' : 'are all'} tied for the highest ${altLabel} (${altVal}) among the ${rows.length} groups returned${revNote}.`
              : `${groupLabel(altRow)} records the highest ${altLabel} (${altVal}) among the ${rows.length} groups returned${revNote}.`;
          business_implications.push(
            revCol && totalRevAll > 0 && topRevRow
              ? {
                  implication: `${topRevName} holds ${(
                    ((Number(topRevRow[revCol]) / totalRevAll) * 100) as number
                  ).toFixed(1)}% of the ${fmtValue(totalRevAll, revCol)} returned across ${rows.length} groups, and the leading group is ${
                      Number(lowestRevRow[revCol]) > 0
                        ? `${(Number(topRevRow[revCol]) / Number(lowestRevRow[revCol])).toFixed(1)}× the smallest`
                        : 'larger than every other group combined by total'
                    }.`,
                  confidence: 'medium',
                }
              : { implication: altLead, confidence: 'medium' }
          );
        }
      }

      if (countCol && revCol && dimCol) {
        const byRevOrder = [...rows].sort((a, b) => (Number(b[revCol]) || 0) - (Number(a[revCol]) || 0));
        const byCountOrder = [...rows].sort((a, b) => (Number(b[countCol]) || 0) - (Number(a[countCol]) || 0));
        const rank = byRevOrder.findIndex((r, i) => {
          const other = byCountOrder[i];
          // Only a strictly larger count at the same position is a real inversion; with a
          // tie the sort order is arbitrary and claiming one group "ranks ahead" is false.
          // The revenue direction must also hold, or "ranks ahead by count yet records
          // less revenue" would be contradicted by the very numbers it quotes.
          return (
            Boolean(other) &&
            groupLabel(other) !== groupLabel(r) &&
            Number(other[countCol]) > Number(r[countCol]) &&
            Number(other[revCol]) < Number(r[revCol])
          );
        });
        if (rank >= 0) {
          const richer = byRevOrder[rank];
          const bulkier = byCountOrder[rank];
          business_implications.push({
            implication: `Customer volume does not directly scale with revenue: ${groupLabel(bulkier)} ranks ahead of ${groupLabel(richer)} by ${countCol.replace(/_/g, ' ')} (${bulkier[countCol]} vs ${richer[countCol]}) yet records less ${revCol.replace(/_/g, ' ')} (${fmtValue(bulkier[revCol], revCol)} vs ${fmtValue(richer[revCol], revCol)}).`,
            confidence: 'high',
          });
        }
      }

      // =====================================================================
      // RECOMMENDED ACTIONS
      // =====================================================================
      if (topRevRow && revCol) {
        recommended_actions.push({
          action: `Prioritize ${topRevName} retention and account expansion efforts because of its substantial contribution to overall revenue.`,
          reason: `Protect top revenue contributing ${dimNoun}`,
          priority: 'high',
        });
      }

      if (revCol && topCountName && topCountName !== topRevName) {
        recommended_actions.push({
          action: `Investigate opportunities to increase ${topCountName} average revenue through appropriate upgrades, feature add-ons, and expansion strategies.`,
          reason: `High customer volume presents upselling potential`,
          priority: 'medium',
        });
      }

      if (lowestRateRow && rateCol && topRateRow) {
        recommended_actions.push({
          action: rateIsActivation
            ? `Examine the lower activation rate in ${groupLabel(lowestRateRow)} (${formatMetricValue(lowestRateRow[rateCol], rateCol)}) to identify possible onboarding, conversion, or engagement issues.`
            : `Check what drives the ${rateLabel} gap in ${groupLabel(lowestRateRow)} (${formatMetricValue(lowestRateRow[rateCol], rateCol)} against ${formatMetricValue(topRateRow[rateCol], rateCol)} for ${groupLabel(topRateRow)}); this column measures ${rateLabel}, not lifecycle status.`,
          reason: rateIsActivation ? `Address activation gap in ${groupLabel(lowestRateRow)}` : `Explain the ${rateLabel} spread across groups`,
          priority: 'medium',
        });
      }

      // Only suggest replication when the runner-up group's own per-customer average
      // actually beats the average of the returned result.
      if (rowsSortedByRev.length >= 2 && rowsSortedByRev[1] && countCol && revCol && totalCustAll > 0 && totalRevAll > 0) {
        const runnerUp = rowsSortedByRev[1];
        const runnerUpAvg = Number(runnerUp[countCol]) > 0 ? Number(runnerUp[revCol]) / Number(runnerUp[countCol]) : 0;
        const overallAvg = totalRevAll / totalCustAll;
        if (runnerUpAvg > overallAvg) {
          recommended_actions.push({
            action: `Compare ${groupLabel(runnerUp)} with the weaker groups: it averages ${formatMetricValue(runnerUpAvg, revCol)} of ${revCol.replace(/_/g, ' ')} per customer against ${formatMetricValue(overallAvg, revCol)} for all ${rows.length} returned groups, so identify which conditions produce that gap before changing spend elsewhere.`,
            reason: `${groupLabel(runnerUp)} beats the grouped per-customer average`,
            priority: 'low',
          });
        }
      }

      // =====================================================================
      // LIMITATIONS
      // =====================================================================
      if (rows.length > 5 && revCol && totalRevAll > 0) {
        const narrowed = /\b(WHERE|HAVING|LIMIT|QUALIFY)\b/i.test(sql);
        limitations.push(
          `The narrative describes the leading rows only; the ${rows.length} returned rows are complete in the result table, and the percentages quoted are shares of the ${formatMetricValue(totalRevAll, revCol)} ${
            narrowed ? 'in this filtered result rather than of the whole dataset' : 'returned across these groups'
          }.`
        );
      } else if (rows.length > 5) {
        limitations.push(
          `The narrative describes the leading rows only; all ${rows.length} returned rows are visible in the result table.`
        );
      }
      // Caveats must be derived from the columns actually returned, so a generic result
      // set is never described as if it came from a known churn or marketing dataset.
      const hasCostCol = columns.some((c) => /cost|spend|expenditure|budget|cac/i.test(c));
      const lifecyclePattern = /status|churn|retention|renewal|tenure|cancel/i;
      const hasLifecycleCol = columns.some((c) => lifecyclePattern.test(c));
      // The dataset can hold a lifecycle column that this grouped result simply does not carry;
      // saying "no lifecycle column" would then be wrong about the data.
      const datasetLifecycleCols = (semanticSchema?.columns || [])
        .map((c: { name: string }) => c.name)
        .filter((name: string) => lifecyclePattern.test(name));
      if (dimCol.toLowerCase().includes('channel') && !hasCostCol) {
        limitations.push('The result carries no acquisition-cost or campaign-expenditure column, so it cannot establish CAC, ROI or channel profitability.');
      } else if (dimCol.toLowerCase().includes('city') || dimCol.toLowerCase().includes('region')) {
        limitations.push('The result contains no explanatory columns for geography, so it shows where the measures differ between groups but not why.');
      } else if (hasLifecycleCol) {
        limitations.push(`The result is a single-query snapshot of ${rows.length} grouped row${rows.length === 1 ? '' : 's'} from "${datasetName}"; it describes the rows returned and does not extend to periods or records outside them.`);
      } else if (datasetLifecycleCols.length > 0) {
        limitations.push(`The result is a single-query snapshot of ${rows.length} grouped row${rows.length === 1 ? '' : 's'} from "${datasetName}"; its groups do not carry ${datasetLifecycleCols.join(' or ')}, so retention, lifetime value and churn cannot be established from this result alone.`);
      } else {
        limitations.push(`The result is a single-query snapshot of ${rows.length} grouped row${rows.length === 1 ? '' : 's'} from "${datasetName}" and has no lifecycle column, so it cannot establish retention, lifetime value or churn.`);
      }
    }
  }

  // =========================================================================
  // STRATEGY 5: RANKING AND TOP-N WITH EXACT TIE HANDLING
  // =========================================================================
  else if (category === 'ranking_top_n') {
    const plannedMetric = queryPlan?.metric;
    const escapedMetric = plannedMetric?.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const metricAlias = escapedMetric
      ? sql.match(new RegExp(`(?:SUM|AVG|MIN|MAX|COUNT)\\s*\\(\\s*"?${escapedMetric}"?\\s*\\)\\s+AS\\s+"?([a-zA-Z_][\\w]*)`, 'i'))?.[1]
      : undefined;
    const plannedColumn = profile.numericCols.find((c) => c.toLowerCase() === metricAlias?.toLowerCase())
      || profile.numericCols.find((c) => c.toLowerCase() === plannedMetric?.toLowerCase());
    const rankMetricCol = plannedColumn || profile.totalRevenueCol || profile.avgRevenueCol || profile.numericCols.find((c) => {
      const l = c.toLowerCase();
      return l.includes('mrr') || l.includes('sales') || l.includes('profit') || l.includes('sold') || l.includes('quantity') || l.includes('tickets');
    }) || profile.numericCols[0] || columns[1] || columns[0];

    const entityCol = profile.entityCol || columns[0];
    const dimCol = profile.dimensionCol;

    // The executed ORDER BY is the only record of what the result is actually sorted on.
    // Falling back to a revenue column here invents a ranking the query never performed.
    const orderToken = (sql.match(/\border\s+by\b\s+"?([a-zA-Z_][\w]*)"?/i) || [])[1];
    const orderCol = orderToken ? columns.find((c) => c.toLowerCase() === orderToken.toLowerCase()) : undefined;
    if (orderCol && !profile.numericCols.includes(orderCol)) {
      const orderDir = (sql.match(/\border\s+by\b[\s\S]{0,60}?\b(asc|desc)\b/i) || [])[1];
      return buildLegacyPayload({
        status: 'verified',
        category,
        overview: `${rows.length} ${rows.length === 1 ? entity.singular : entity.plural} were returned sorted by ${orderCol.replace(/_/g, ' ')}${
          orderDir ? ` in ${orderDir.toUpperCase()} order` : ''
        }. This query applied no aggregate, so no metric was ranked.`,
        key_findings: rows.slice(0, 6).map((row) => ({
          finding: `${row[entityCol]}: ${columns
            .filter((c) => c !== entityCol)
            .map((c) => `${c.replace(/_/g, ' ')} = ${formatMetricValue(row[c], c)}`)
            .join(', ')}.`,
          evidence: columns.map((c) => `${c}=${row[c]}`).join(', '),
          importance: 'high' as const,
        })),
        business_implications: [],
        recommended_actions: [],
        limitations: [
          rows.length > 6
            ? `${rows.length} rows were returned; the first 6 are listed here and the rest appear in the result table.`
            : 'This is an ordering of stored records, not a ranking by any measured value.',
          `The ${orderCol.replace(/_/g, ' ')} column holds no numeric measure, so no performance comparison can be drawn from this result alone.`,
        ],
      });
    }

    if (queryPlan?.intent === 'top_n_per_group') {
      const partitions = queryPlan.partition_by || [];
      const itemColumn = queryPlan.item_entity || entityCol;
      const itemNoun = itemColumn.replace(/_(name|id)$/i, '').replace(/_/g, ' ');
      const groupNoun = partitions.map((column) => column.replace(/_/g, ' ')).join(' and ');
      const rankMetricLabel = rankMetricCol.replace(/_/g, ' ');
      return buildLegacyPayload({
        status: 'verified',
        category,
        overview: `Returned the top ${itemNoun} records within each ${groupNoun} (${rows.length} rows), ranked by ${rankMetricLabel}.`,
        key_findings: rows.slice(0, 8).map((row) => ({
          finding: `${partitions.map((column) => row[column]).join(' / ')}: ${row[itemColumn]} — ${formatMetricValue(row[rankMetricCol], rankMetricCol)} in ${rankMetricLabel}.`,
          evidence: `${itemColumn}=${row[itemColumn]}, ${rankMetricCol}=${row[rankMetricCol]}`,
          importance: 'high' as const,
        })),
        business_implications: [],
        recommended_actions: [],
        limitations: ['Rankings are within each group; they do not establish a global ranking or revenue concentration.'],
      });
    }

    // Detect exact ties in the result set
    const valueCounts = new Map<number, string[]>();
    rows.forEach((r) => {
      const val = Number(r[rankMetricCol]);
      const name = r[entityCol] || 'Record';
      const existing = valueCounts.get(val) || [];
      existing.push(name);
      valueCounts.set(val, existing);
    });

    const ties = Array.from(valueCounts.entries()).filter(([_, names]) => names.length > 1);

    const leaderRow = rows[0];
    // A result tagged with both an upper and a lower marker (highest/lowest) is a pair of
    // extremes, not a ranking: labelling the second row "ranks second" would be false.
    const extremesCol = columns.find(
      (c) =>
        !profile.numericCols.includes(c) &&
        rows.length <= 4 &&
        rows.some((r) => /highest|maximum|largest|\bmax\b|top\b/i.test(String(r[c] ?? ''))) &&
        rows.some((r) => /lowest|minimum|smallest|\bmin\b|bottom\b/i.test(String(r[c] ?? '')))
    );
    if (extremesCol) {
      const highRow = rows.find((r) => /highest|maximum|largest|\bmax\b|top\b/i.test(String(r[extremesCol] ?? '')));
      const lowRow = rows.find((r) => /lowest|minimum|smallest|\bmin\b|bottom\b/i.test(String(r[extremesCol] ?? '')));
      const label = (r: Record<string, any>) => `${r[entityCol]}${r[extremesCol] !== entityCol ? ` (${String(r[extremesCol]).replace(/_/g, ' ')})` : ''}`;
      return buildLegacyPayload({
        status: 'verified',
        category,
        overview: highRow && lowRow
          ? `${label(highRow)} holds the highest ${rankMetricCol.replace(/_/g, ' ')} at ${formatMetricValue(highRow[rankMetricCol], rankMetricCol)}, while ${label(lowRow)} holds the lowest at ${formatMetricValue(lowRow[rankMetricCol], rankMetricCol)}. These are the two ends of the range, not consecutive ranks.`
          : `The result reports ${rows.length} extreme-value records for ${rankMetricCol.replace(/_/g, ' ')}.`,
        key_findings: rows.map((row) => ({
          finding: `${row[entityCol]}: ${formatMetricValue(row[rankMetricCol], rankMetricCol)} ${rankMetricCol.replace(/_/g, ' ')} (${String(row[extremesCol]).replace(/_/g, ' ')}).`,
          evidence: `${entityCol}="${row[entityCol]}", ${extremesCol}="${row[extremesCol]}", ${rankMetricCol}=${row[rankMetricCol]}`,
          importance: 'high' as const,
        })),
        business_implications: [],
        recommended_actions: highRow && lowRow
          ? [
              {
                action: `Report the spread between ${formatMetricValue(highRow[rankMetricCol], rankMetricCol)} and ${formatMetricValue(lowRow[rankMetricCol], rankMetricCol)} rather than a single leader, and re-run with a tie-break column if several records share either extreme.`,
                reason: `Only one record per extreme was returned, so equal values cannot be excluded.`,
              },
            ]
          : [],
        limitations: [
          'The query returned a single record per extreme, so any other records tied at that value are not shown and cannot be counted from this result.',
        ],
      });
    }

    // An ID column alone ("C005") is unreadable when the query also returned the record's name.
    const nameCol = columns.find(
      (c) => c !== entityCol && /(^|_)name$/i.test(c) && rows.every((r) => typeof r[c] === 'string' || r[c] == null)
    );
    const labelOf = (row: Record<string, any>): string =>
      nameCol && row[nameCol] ? `${row[nameCol]} (${row[entityCol]})` : String(row[entityCol] ?? 'Record');
    const metricLabel = rankMetricCol.replace(/_/g, ' ');
    const sqlDirection = (sql.match(/\border\s+by\b\s+"?[a-zA-Z_][\w]*"?\s+(asc|desc)\b/i) || [])[1]?.toUpperCase();
    const ascending = sqlDirection === 'ASC';

    const runnerUpRow = rows.length > 1 ? rows[1] : null;
    const leaderName = labelOf(leaderRow);
    const leaderNum = Number(leaderRow[rankMetricCol]);
    const leaderVal = formatMetricValue(leaderRow[rankMetricCol], rankMetricCol);
    const runnerUpName = runnerUpRow ? labelOf(runnerUpRow) : null;
    const runnerUpVal = runnerUpRow ? formatMetricValue(runnerUpRow[rankMetricCol], rankMetricCol) : null;
    const leadVerb = ascending ? 'has the lowest' : 'leads with';

    if (ties.length > 0) {
      overview = `${leaderName} ${ascending ? 'has the lowest value' : 'leads the ranking'} at ${leaderVal}${
        runnerUpName ? `, followed by ${runnerUpName} at ${runnerUpVal}` : ''
      }. Multiple entities show identical ${metricLabel} values, highlighting the importance of correctly handling ties.`;
    } else {
      overview = `${rows.length} ${entity.plural} were ranked by ${metricLabel}${ascending ? ' from lowest to highest' : ''}. ${leaderName} ${
        ascending ? 'has the lowest at' : 'leads with'
      } ${leaderVal}${runnerUpName ? `, followed by ${runnerUpName} with ${runnerUpVal}` : ''}.`;
    }

    key_findings.push({
      finding: ascending
        ? `${leaderName} has the lowest ${metricLabel} in this ranking at ${leaderVal}.`
        : `${leaderName} ${leadVerb} ${leaderVal} in ${metricLabel} (ranking #1).`,
      evidence: `${entityCol}="${leaderRow[entityCol]}", ${rankMetricCol}=${leaderRow[rankMetricCol]}`,
      importance: 'high',
    });

    if (runnerUpRow) {
      const runnerUpNum = Number(runnerUpRow[rankMetricCol]);
      const gap = Math.abs(leaderNum - runnerUpNum);
      const gapPct = leaderNum !== 0 ? (gap / Math.abs(leaderNum)) * 100 : null;
      key_findings.push({
        finding:
          gap === 0
            ? `${runnerUpName} ranks second with ${runnerUpVal}.`
            : `${runnerUpName} ranks second with ${runnerUpVal}, ${formatMetricValue(gap, rankMetricCol)}${
                gapPct !== null && Number.isFinite(gapPct) ? ` (${gapPct.toFixed(1)}%)` : ''
              } ${ascending ? 'above' : 'behind'} ${leaderName}.`,
        evidence: `${entityCol}="${runnerUpRow[entityCol]}", ${rankMetricCol}=${runnerUpRow[rankMetricCol]}`,
        importance: 'high',
      });
    }

    // Detail tie findings if any exist
    ties.slice(0, 2).forEach(([val, names]) => {
      key_findings.push({
        finding: `${joinSeries(names)} are tied at ${formatMetricValue(val, rankMetricCol)}${dimCol ? ` in ${dimCol}` : ''}.`,
        evidence: `Identical rank metric value ${val}`,
        importance: 'medium',
      });
    });

    const numericValues = rows.map((r) => Number(r[rankMetricCol])).filter((v) => Number.isFinite(v));
    const shownTotal = numericValues.reduce((acc, v) => acc + v, 0);
    if (rows.length > 2) {
      const lowestRow = rows[rows.length - 1];
      const lowestNum = Number(lowestRow[rankMetricCol]);
      const ratio = !ascending && lowestNum > 0 ? leaderNum / lowestNum : ascending && leaderNum > 0 ? lowestNum / leaderNum : null;
      key_findings.push({
        finding: `Values range from ${formatMetricValue(Math.min(leaderNum, lowestNum), rankMetricCol)} to ${formatMetricValue(
          Math.max(leaderNum, lowestNum),
          rankMetricCol
        )} across these ${rows.length} records${
          ratio !== null && Number.isFinite(ratio) && ratio >= 1.05 ? `, a ${ratio.toFixed(1)}x spread between the first and last entries` : ''
        }; together they total ${formatMetricValue(shownTotal, rankMetricCol)}.`,
        evidence: `${rankMetricCol} values: ${numericValues.join(', ')}`,
        importance: 'medium',
      });
    }

    const aux = ctx.auxStats;
    const population =
      aux?.rankedColumn && aux.rankedColumn.toLowerCase() === rankMetricCol.toLowerCase() &&
      Number.isFinite(aux.rankedPopulationTotal) && Number.isFinite(aux.rankedPopulationCount) &&
      (aux.rankedPopulationCount as number) > rows.length
        ? { total: aux.rankedPopulationTotal as number, count: aux.rankedPopulationCount as number }
        : null;
    if (population && population.total > 0 && shownTotal >= 0) {
      const share = (shownTotal / population.total) * 100;
      const headcountShare = (rows.length / population.count) * 100;
      key_findings.push({
        finding: `These ${rows.length} of ${population.count} ${entity.plural} account for ${formatMetricValue(shownTotal, rankMetricCol)} of ${formatMetricValue(
          population.total,
          rankMetricCol
        )} total ${metricLabel} (${share.toFixed(1)}%) while making up ${headcountShare.toFixed(1)}% of the ${entity.plural}.`,
        evidence: `SUM(${rankMetricCol}) over the ranked rows = ${shownTotal}; over all ${population.count} rows matching the query's filters = ${population.total}`,
        importance: 'high',
      });
      if (!ascending && share > headcountShare * 1.5) {
        business_implications.push({
          implication: `${metricLabel} is concentrated: the top ${rows.length} hold ${share.toFixed(1)}% of it, so losing or growing any one of them moves the total far more than an average ${entity.singular} would.`,
          evidence: `${share.toFixed(1)}% of ${metricLabel} from ${headcountShare.toFixed(1)}% of ${entity.plural}`,
          confidence: 'high',
        });
      }
    }

    if (ties.length > 0) {
      business_implications.push({
        implication: 'Tied entities should be represented accurately rather than described as meaningful differences.',
        confidence: 'high',
      });
    }

    if (ties.length > 0) {
      recommended_actions.push({
        action: `Use a documented tie-breaking rule (such as signup date or secondary metrics) when presenting ranked lists.`,
        reason: 'Ensure fair and deterministic ranking displays',
        priority: 'low',
      });
    }

    limitations.push(
      population
        ? 'Rankings reflect the current metric ordering and do not imply operational superiority or client health.'
        : 'Rankings reflect the current metric ordering and do not imply operational superiority or client health; the share of the overall total was not computed for this query shape.'
    );
  }

  // =========================================================================
  // STRATEGY 6: FILTERED RETRIEVAL / OPERATIONAL ATTENTION & RISK ANALYSIS
  // =========================================================================
  else {
    const entityCol = profile.entityCol || columns[0];
    const ticketsCol = profile.ticketsCol;
    const usageCol = profile.usageCol;
    const statusCol = profile.statusCol;
    const revCol = profile.totalRevenueCol || profile.numericCols.find((c) => c.toLowerCase().includes('mrr'));

    const filterDesc =
      Array.isArray(queryPlan?.filters) && queryPlan!.filters.length > 0
        ? queryPlan!.filters
            .map((f) => `${f.column} ${f.operator} ${Array.isArray(f.value) ? f.value.join(' / ') : f.value}`)
            .join(' and ')
        : '';
    const criteriaText = filterDesc ? `the executed filters (${filterDesc})` : null;
    const whereText = describeWhereClause(sql);
    // A listing with no WHERE clause and no plan filters did not filter anything, so the
    // overview must not imply criteria the query never applied.
    const retrievalOverview = (count: number, entityWord: string) =>
      criteriaText
        ? `Found ${count} ${entityWord} matching ${criteriaText}.`
        : whereText
        ? `Found ${count} ${entityWord} matching the executed conditions (${whereText}).`
        : `The executed query returned ${count} ${entityWord} with no filter conditions applied.`;

    // Check if query is an attention/risk query (tickets > 3, usage > 100, or cancelled accounts)
    const hasTicketsFilter = ticketsCol && rows.some((r) => Number(r[ticketsCol]) > 3);
    const hasUsageFilter = usageCol && rows.some((r) => Number(r[usageCol]) > 100);
    const hasStatusCol = statusCol && rows.some((r) => ['Cancelled', 'Churned', 'At-Risk'].includes(r[statusCol]));

    if (hasTicketsFilter || hasUsageFilter || hasStatusCol) {
      overview = retrievalOverview(rows.length, rows.length === 1 ? entity.singular : entity.plural);

      // 1. Multi-flag accounts (high tickets AND high usage)
      if (ticketsCol && usageCol) {
        const multiFlag = rows.find((r) => Number(r[ticketsCol]) >= 5 && Number(r[usageCol]) >= 100);
        if (multiFlag) {
          key_findings.push({
            finding: `${multiFlag[entityCol]} has ${multiFlag[ticketsCol]} support tickets and ${formatMetricValue(multiFlag[usageCol], usageCol)} usage, making it a notable account for investigation.`,
            evidence: `Combined high tickets and quota exceeding usage`,
            importance: 'high',
          });
        }
      }

      // 2. High revenue accounts with high support volume
      if (revCol && ticketsCol) {
        const topRevTicket = [...rows].sort((a, b) => (Number(b[revCol]) || 0) - (Number(a[revCol]) || 0))[0];
        if (topRevTicket && Number(topRevTicket[ticketsCol]) >= 4) {
          key_findings.push({
            finding: `${topRevTicket[entityCol]} contributes ${formatMetricValue(topRevTicket[revCol], revCol)} in MRR and has ${topRevTicket[ticketsCol]} support tickets, making it a high-revenue account with substantial support activity.`,
            evidence: `${topRevTicket[entityCol]}: MRR ${formatMetricValue(topRevTicket[revCol], revCol)}, Tickets ${topRevTicket[ticketsCol]}`,
            importance: 'high',
          });
        }
      }

      // 3. Usage threshold accounts
      if (usageCol) {
        const overUsageRows = rows.filter((r) => Number(r[usageCol]) > 100);
        if (overUsageRows.length > 0) {
          const sample = overUsageRows[0];
          key_findings.push({
            finding: `${sample[entityCol]} has ${formatMetricValue(sample[usageCol], usageCol)} usage${ticketsCol ? ` and ${sample[ticketsCol]} support tickets` : ''}.`,
            evidence: `Usage exceeded 100% quota threshold`,
            importance: 'medium',
          });
          key_findings.push({
            finding: `Several customers exceed the usage threshold, which may warrant investigation of product capacity, usage patterns, or plan suitability.`,
            evidence: `${overUsageRows.length} accounts > 100% usage`,
            importance: 'medium',
          });
        }
      }

      // 4. Cancelled status accounts check
      if (statusCol) {
        const cancelledRows = rows.filter((r) => ['Cancelled', 'Churned'].includes(String(r[statusCol])));
        cancelledRows.forEach((cancelledRow) => {
          key_findings.push({
            finding: `${cancelledRow[entityCol]} has ${ticketsCol ? `${cancelledRow[ticketsCol]} support tickets but ` : ''}is already marked as ${cancelledRow[statusCol]}, so its current subscription status must be considered before interpreting its MRR.`,
            evidence: `Status is ${cancelledRow[statusCol]}`,
            importance: 'medium',
          });
        });
      }

      if (key_findings.length === 0) {
        rows.slice(0, 5).forEach((r) => {
          const details = columns
            .filter((c) => c !== entityCol)
            .map((c) => `${c.replace(/_/g, ' ')} ${formatMetricValue(r[c], c)}`)
            .join(', ');
          key_findings.push({
            finding: `${r[entityCol]}: ${details}.`,
            evidence: columns.map((c) => `${c}=${r[c]}`).join(', '),
            importance: 'high',
          });
        });
        if (rows.length > 5) {
          limitations.push(`${rows.length} records matched; only the first 5 are listed individually here.`);
        }
      }

      const usageOverCeiling = usageCol ? rows.filter((r) => Number(r[usageCol]) > 100) : [];
      const priorityRevRow =
        revCol && ticketsCol ? [...rows].sort((a, b) => (Number(b[revCol]) || 0) - (Number(a[revCol]) || 0))[0] : undefined;

      if (revCol && ticketsCol && priorityRevRow && Number(priorityRevRow[ticketsCol]) >= 4) {
        business_implications.push({
          implication: `${priorityRevRow[entityCol]} combines ${formatMetricValue(priorityRevRow[revCol], revCol)} MRR with ${priorityRevRow[ticketsCol]} support tickets, so it is the account in this result most worth a priority review.`,
          confidence: 'high',
        });

        recommended_actions.push({
          action: 'Prioritize account reviews for high-MRR customers with elevated support activity.',
          reason: `${rows.filter((r) => Number(r[ticketsCol]) >= 4).length} accounts in this result carry 4 or more support tickets`,
          priority: 'high',
        });
      }

      if (usageOverCeiling.length > 0) {
        business_implications.push({
          implication: `${usageOverCeiling.length} of ${rows.length} returned ${usageOverCeiling.length === 1 ? entity.singular : entity.plural} exceed 100% usage, so plan limits should be checked against actual consumption.`,
          confidence: 'high',
        });

        recommended_actions.push({
          action: `Verify plan limits and actual consumption for the ${usageOverCeiling.length} ${usageOverCeiling.length === 1 ? entity.singular : entity.plural} above 100% usage.`,
          reason: 'Recorded usage exceeds the nominal 100% ceiling',
          priority: 'medium',
        });
      }

      if (statusCol) {
        recommended_actions.push({
          action: 'Separate cancelled accounts from active customer follow-up and revenue reporting.',
          reason: 'Maintain accurate active cohort health',
          priority: 'medium',
        });
      }

      limitations.push('Support-ticket volume does not independently establish dissatisfaction or churn probability.');
      if (usageCol && rows.some((r) => Number(r[usageCol]) > 100)) {
        limitations.push('Usage above 100% should not automatically be interpreted as overage billing or a technical incident.');
      }
    } else {
      // Standard Filtered Lookup
      overview = retrievalOverview(rows.length, rows.length === 1 ? entity.singular : entity.plural);

      rows.slice(0, 4).forEach((r, idx) => {
        const name = r[entityCol] || `Record #${idx + 1}`;
        const details = profile.numericCols
          .slice(0, 2)
          .map((c) => `${c}: ${formatMetricValue(r[c], c)}`)
          .join(', ');
        key_findings.push({
          finding: `${name}${details ? ` — ${details}` : ''}.`,
          evidence: `Verified row ${idx + 1}`,
          importance: 'medium',
        });
      });

      if (ticketsCol) {
        const highTickets = rows.filter((r) => Number(r[ticketsCol]) > 3);
        if (highTickets.length > 0) {
          recommended_actions.push({
            action: `Review the support histories of the customers with elevated ticket counts to identify recurring issues.`,
            reason: 'Address high ticket volumes',
            priority: 'high',
          });
        }
      }
    }
  }

  // Filter out any banned boilerplate from findings or implications if any crept in
  const cleanFindings = key_findings.filter((f) => !containsBannedBoilerplate(f.finding));
  const cleanAnomalies = anomalies.filter((a) => !containsBannedBoilerplate(a.observation));
  const cleanImplications = business_implications.filter((i) => !containsBannedBoilerplate(i.implication));
  const cleanActions = recommended_actions.filter((a) => !containsBannedBoilerplate(a.action));
  const cleanComparisons = performance_comparison.filter((c) => !containsBannedBoilerplate(c));

  return buildLegacyPayload({
    status: 'verified',
    category,
    overview: sanitizeText(overview),
    key_findings: cleanFindings,
    performance_comparison: cleanComparisons,
    anomalies: cleanAnomalies,
    business_implications: cleanImplications,
    recommended_actions: cleanActions,
    limitations: limitations.map(sanitizeText),
  });
}
