import { QueryPlan } from './queryPlan';
import { SemanticSchema } from './schemaProfiler';

/** Escapes a value so it can be embedded in a RegExp as literal text. */
export function escapeForLiteralRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Builds the "the question mentions this cell value" matcher. The value is escaped first,
 * because a value such as "+1+1" compiled straight into /\b+1+1\b/ throws "Nothing to repeat"
 * and aborts validation. Word boundaries only exist next to word characters, so the anchors
 * are the non-word equivalents that also work for values that start or end with punctuation.
 */
export function buildValueMentionRegex(value: string): RegExp {
  const body = escapeForLiteralRegex(value.toLowerCase()).replace(/[-_]/g, '[-_]?');
  return new RegExp(`(^|\\W)${body}(\\W|$)`, 'i');
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  passedChecks?: string[];
  needsClarification?: boolean;
  clarificationMessage?: string;
  astAnalysis?: {
    statementType: 'SELECT' | 'WITH';
    tableReferences: string[];
    hasComments: boolean;
    parenthesesBalanced: boolean;
  };
}

const FORBIDDEN_SQL_PATTERNS = [
  /\bDROP\b/i,
  /\bDELETE\b/i,
  /\bUPDATE\b/i,
  /\bINSERT\b/i,
  /\bALTER\b/i,
  /\bCREATE\b/i,
  /\bTRUNCATE\b/i,
  /\bEXEC\b/i,
  /\bEXECUTE\b/i,
  /\bGRANT\b/i,
  /\bREVOKE\b/i,
  /\bATTACH\b/i,
  /\bDETACH\b/i,
  /\bPRAGMA\b/i,
  /\bINSTALL\b/i,
  /\bLOAD\b/i,
  /\bCOPY\b/i,
  /\bEXPORT\b/i,
  /\bIMPORT\b/i,
  /\bCALL\b/i,
  /\bSYSTEM\b/i,
  /\bREAD_CSV\b/i,
  /\bREAD_PARQUET\b/i,
  /\bREAD_JSON\b/i,
  /\bREAD_NDJSON\b/i,
  /\bSCAN_CSV\b/i,
  /\bHTTPFS\b/i,
  /\bGLOB\b/i,
];

/**
 * Strips comments from SQL and detects comment presence.
 * Prevents hidden payload injection or comment-based bypasses.
 */
export function analyzeAndStripComments(sql: string): { cleanSql: string; hasComments: boolean } {
  let hasComments = false;
  // Multi-line comments /* ... */
  let clean = sql.replace(/\/\*[\s\S]*?\*\//g, () => {
    hasComments = true;
    return ' ';
  });
  // Single-line comments -- ...
  clean = clean.replace(/--.*$/gm, () => {
    hasComments = true;
    return ' ';
  });
  return { cleanSql: clean.trim(), hasComments };
}

/**
 * Checks parentheses balance in SQL statement to catch malformed AST structures or truncation.
 */
export function checkParenthesesBalance(sql: string): boolean {
  let depth = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;

  for (let i = 0; i < sql.length; i++) {
    const char = sql[i];
    const prevChar = i > 0 ? sql[i - 1] : '';

    if (char === "'" && prevChar !== '\\' && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      continue;
    }
    if (char === '"' && prevChar !== '\\' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }
    if (!inSingleQuote && !inDoubleQuote) {
      if (char === '(') depth++;
      else if (char === ')') {
        depth--;
        if (depth < 0) return false;
      }
    }
  }
  return depth === 0;
}

/**
 * Counts top-level statements separated by unquoted semicolons.
 * Correctly ignores semicolons inside single or double-quoted string literals.
 */
export function countSqlStatements(sql: string): number {
  let count = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let currentStatementTokens = 0;

  for (let i = 0; i < sql.length; i++) {
    const char = sql[i];
    const prevChar = i > 0 ? sql[i - 1] : '';

    if (char === "'" && prevChar !== '\\' && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      currentStatementTokens++;
      continue;
    }
    if (char === '"' && prevChar !== '\\' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      currentStatementTokens++;
      continue;
    }

    if (!inSingleQuote && !inDoubleQuote) {
      if (char === ';') {
        if (currentStatementTokens > 0) {
          count++;
          currentStatementTokens = 0;
        }
      } else if (!/\s/.test(char)) {
        currentStatementTokens++;
      }
    } else {
      currentStatementTokens++;
    }
  }

  if (currentStatementTokens > 0) {
    count++;
  }

  return count;
}

/**
 * Checks whether a requested metric is defined and available in the dataset schema.
 * Prevents silent metric substitution (e.g. substituting current MRR for lost MRR).
 */
/**
 * Business metrics that need inputs a flat observational table simply does not carry
 * (cost bases, multi-period cohorts, survey scores). Each is only blocked when the
 * dataset has no column that defines it, so a schema that does provide LTV passes.
 */
const DERIVED_METRIC_GUARDS: { ask: RegExp; label: string; columnHints: string[] }[] = [
  { ask: /\b(lifetime value|ltv)\b/i, label: 'customer lifetime value (LTV)', columnHints: ['ltv', 'lifetime_value'] },
  { ask: /\b(acquisition cost|cac)\b/i, label: 'customer acquisition cost (CAC)', columnHints: ['cac', 'acquisition_cost', 'marketing_spend'] },
  { ask: /\b(roi|return on investment)\b/i, label: 'return on investment (ROI)', columnHints: ['roi', 'return_on_investment'] },
  { ask: /\b(roas|return on ad spend)\b/i, label: 'return on ad spend (ROAS)', columnHints: ['roas', 'ad_spend'] },
  { ask: /\b(nps|net promoter score)\b/i, label: 'NPS', columnHints: ['nps'] },
  { ask: /\b(arpu|average revenue per (user|customer))\b/i, label: 'ARPU', columnHints: ['arpu'] },
];

/** Finds a real column whose name matches one of the hints, so guidance never cites a phantom column. */
function matchColumn(schema: SemanticSchema, hints: string[]): string | undefined {
  for (const hint of hints) {
    const found = schema.columns.find((c) => c.name.toLowerCase().includes(hint));
    if (found) return found.name;
  }
  return undefined;
}

function listColumns(schema: SemanticSchema): string {
  return schema.columns.map((c) => `"${c.name}"`).join(', ');
}

export function checkMetricAvailability(
  question: string,
  schema: SemanticSchema
): { isAvailable: boolean; missingMetric?: string; clarification?: string; caveat?: string } {
  const lowerQ = question.toLowerCase();

  // Test Group C: "Show the top five customers by lost MRR"
  // When question asks for lost MRR without explicit definition
  const asksForLostMrr = /\b(lost\s+mrr|lost\s+revenue)\b/i.test(lowerQ);
  if (asksForLostMrr) {
    const lostCol = matchColumn(schema, ['lost_mrr', 'lost_revenue']);
    if (!lostCol) {
      const mrrCol = matchColumn(schema, ['mrr', 'arr']);
      const statusCol = matchColumn(schema, ['status', 'churn']);
      const parts = [
        mrrCol ? `it measures recurring revenue with "${mrrCol}"` : 'it has no recurring-revenue measure',
        statusCol ? `it records lifecycle status with "${statusCol}"` : '',
      ].filter(Boolean);
      return {
        isAvailable: false,
        missingMetric: 'lost MRR',
        clarification:
          `The dataset does not contain a dedicated "lost MRR" measure (${parts.join('; ')}), so it cannot report the MRR given up on cancellation. ` +
          'To avoid silently substituting a different measure, confirm the definition you want (for example current MRR of accounts with a cancelled status).',
        caveat: 'The dataset does not provide a separate lost-MRR measure, so any lost-MRR figure would be a substitution rather than a measurement.',
      };
    }
  }

  // Derived metrics that require cost, cohort or survey inputs the table must define explicitly.
  const missingGuards = DERIVED_METRIC_GUARDS.filter(
    (guard) => guard.ask.test(lowerQ) && !matchColumn(schema, guard.columnHints)
  );
  if (missingGuards.length > 0) {
    const labels = missingGuards.map((g) => g.label);
    const labelText =
      labels.length === 1
        ? labels[0]
        : `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
    return {
      isAvailable: false,
      missingMetric: labels.join(', '),
      clarification:
        `This dataset does not define ${labelText}, so those figures cannot be calculated from the available columns. ` +
        `Columns present: ${listColumns(schema)}. No cost, cohort or survey inputs exist to derive them, so no proxy measure will be substituted.`,
      caveat: `${labelText} cannot be produced without columns that measure them.`,
    };
  }

  // A base measure the table does not carry at all. Substituting a count or another
  // numeric column would answer a different question than the one that was asked.
  const asksForRecurringRevenue = /(mrr\w*|\barr\b|monthly\s+recurring\s+revenue|annual\s+recurring\s+revenue|recurring\s+revenue)/i.test(lowerQ);
  const revenueCol = schema.columns.find((c) => /(^|_)(mrr|arr|revenue|recurring)(_|$)/i.test(c.name) || /mrr/i.test(c.name));
  if (asksForRecurringRevenue && !revenueCol) {
    return {
      isAvailable: false,
      missingMetric: 'MRR/ARR',
      clarification:
        `Dataset "${schema.datasetName}" has no recurring-revenue column, so MRR cannot be reported from it. ` +
        `Columns present: ${listColumns(schema)}. No proxy measure (row counts, usage or another numeric column) will be substituted for MRR.`,
      caveat: 'MRR cannot be produced because the dataset contains no recurring-revenue measure.',
    };
  }

  // A measure the question names directly but that the table stores as text. Executing a
  // numeric aggregation on it fails, and letting the retry loop swap in another column
  // would silently answer a different question than the one that was asked.
  const aggTarget = lowerQ.match(/\b(?:total|sum|average|avg|maximum|max|minimum|min)\s+(?:of\s+)?([a-z][a-z0-9_]*)/i);
  if (aggTarget) {
    const token = aggTarget[1].toLowerCase();
    const textMeasure = schema.columns.find(
      (c) => !c.isNumeric && (c.name.toLowerCase() === token || c.name.toLowerCase().startsWith(`${token}_`))
    );
    if (textMeasure) {
      return {
        isAvailable: false,
        missingMetric: textMeasure.name,
        clarification:
          `Column "${textMeasure.name}" exists in dataset "${schema.datasetName}" but is stored as ${textMeasure.type === 'string' ? 'text' : textMeasure.type}, not numbers, so it cannot be summed or averaged. ` +
          `Columns present: ${listColumns(schema)}. No other column will be substituted for it.`,
        caveat: `"${textMeasure.name}" is a text column in this dataset and cannot carry a numeric aggregation.`,
      };
    }
  }

  // Check for net operating margin
  const asksForNetOperatingMargin = /\bnet\s+operating\s+margin\b/i.test(lowerQ);
  if (asksForNetOperatingMargin) {
    const hasNom = schema.columns.some((c) => c.name.toLowerCase().includes('net_operating_margin'));
    if (!hasNom) {
      return {
        isAvailable: false,
        missingMetric: 'net operating margin',
        clarification:
          'The dataset does not contain an official "net operating margin" metric. Standard margin (profit / sales) is available, but operating margin requires operating expense data not present in this schema.',
        caveat:
          'The dataset provides sales and profit, but does not define net operating margin.',
      };
    }
  }

  // Predictive / Unsupported metric checks (churn probability, future revenue, cancel forecast)
  const asksForPrediction = /\b(churn\s+probabilit(y|ies)|predict\b|prediction|forecast|will\s+cancel|propensity)\b/i.test(lowerQ);
  if (asksForPrediction) {
    const missing = lowerQ.includes('churn')
      ? 'churn probability'
      : lowerQ.includes('revenue')
      ? 'revenue forecast'
      : 'predictive cancellation';
    const healthColumns = schema.columns
      .filter((c) => /status|ticket|score|usage|health|tenure/i.test(c.name))
      .map((c) => `"${c.name}"`);
    return {
      isAvailable: false,
      missingMetric: missing,
      clarification:
        `Dataset "${schema.datasetName}" contains historical observational records but does not contain predictive models, forward-looking probabilities or machine-learning labels required for ${missing}. ` +
        (healthColumns.length > 0
          ? `Account health can be assessed deterministically from the columns that are present: ${healthColumns.join(', ')}.`
          : 'No deterministic substitute for account health is available in this schema either.'),
      caveat:
        'Predictive calculations for ' + missing + ' cannot be established without historical predictive model outputs or multi-period forecasting data.',
    };
  }

  return { isAvailable: true };
}

/**
 * Standalone SQL safety and boundary validator used across all runtime execution paths.
 * Enforces:
 * 1. Read-only statement boundaries (SELECT or WITH).
 * 2. AST structural parenthesis balance.
 * 3. Rejection of forbidden data-modification or system keywords.
 * 4. Rejection of external filesystem functions (read_csv, read_parquet, httpfs, etc.).
 * 5. Rejection of internal DuckDB catalogs and introspection views.
 * 6. Quote-aware single-statement verification.
 * 7. Dataset table reference isolation (when activeTableName is provided).
 */
export function validateSqlSafety(
  sql: string,
  activeTableName?: string
): { isValid: boolean; errors: string[] } {
  const errors: string[] = [];
  const { cleanSql } = analyzeAndStripComments(sql);
  const trimmedSql = cleanSql.trim();
  const upperSql = trimmedSql.toUpperCase();

  // 1. AST Structural Checks: Parentheses balance
  if (!checkParenthesesBalance(trimmedSql)) {
    errors.push('AST Structural Error: Unbalanced parentheses detected in SQL expression.');
  }

  // 2. Read-Only Safety Guard
  const statementType: 'SELECT' | 'WITH' | null = upperSql.startsWith('SELECT')
    ? 'SELECT'
    : upperSql.startsWith('WITH')
    ? 'WITH'
    : null;

  if (!statementType) {
    errors.push('Security Guard: Query must begin with SELECT or WITH (strictly read-only analytical queries permitted).');
  }

  // 3. Disallowed SQL keywords or external file access
  for (const forbidden of FORBIDDEN_SQL_PATTERNS) {
    if (forbidden.test(sql) || forbidden.test(trimmedSql)) {
      errors.push(`Security Guard: Disallowed SQL keyword or external file operation detected (${forbidden.source.replace(/\\b/g, '')}).`);
    }
  }

  // 4. System catalog protection (duckdb_tables, information_schema, pg_catalog, etc.)
  const FORBIDDEN_CATALOGS = [
    /\bduckdb_[a-zA-Z0-9_]+\b/i,
    /\binformation_schema\b/i,
    /\bpg_catalog\b/i,
    /\bsqlite_master\b/i,
    /\bsqlite_temp_master\b/i,
  ];
  for (const catalog of FORBIDDEN_CATALOGS) {
    if (catalog.test(trimmedSql)) {
      errors.push('Security Guard: Direct access to system catalogs, internal schemas, and metadata views is prohibited.');
      break;
    }
  }

  // 5. Check for multiple semicolon-separated statements (quote-aware scanner)
  const statementCount = countSqlStatements(trimmedSql);
  if (statementCount > 1) {
    errors.push('Security Guard: Only single-statement queries are permitted.');
  }

  // 6. Strict Table Name & Reference Verification (if activeTableName provided)
  if (activeTableName) {
    const cleanActive = activeTableName.toLowerCase().replace(/[^a-z0-9_]/g, '_');
    const validTableNames = [
      cleanActive,
      'dataset',
      `"${cleanActive}"`,
      '"dataset"',
    ];
    if (statementType === 'WITH') {
      const cteMatches = trimmedSql.matchAll(/(?:WITH|,)\s*([a-zA-Z0-9_]+)\s+AS\s*\(/gi);
      for (const m of cteMatches) {
        validTableNames.push(m[1].toLowerCase());
      }
    }
    const tableMatches = Array.from(trimmedSql.matchAll(/(?:FROM|JOIN)\s+([a-zA-Z0-9_"']+)/gi));
    for (const match of tableMatches) {
      const rawTable = match[1].trim().toLowerCase();
      const cleanTable = rawTable.replace(/["'`]/g, '');
      if (!validTableNames.includes(rawTable) && !validTableNames.includes(cleanTable) && !rawTable.startsWith('ranked_')) {
        errors.push(`Table Security Error: Query references table "${cleanTable}" instead of active dataset "${activeTableName}".`);
      }
    }
  }

  return { isValid: errors.length === 0, errors };
}

/**
 * Validates generated SQL against the QueryPlan, dataset schema, and user question before execution.
 * Enforces the strict analytical contract (Phase 2).
 */
export function validateSqlIntent(
  sql: string,
  plan: QueryPlan,
  schema: SemanticSchema,
  question?: string
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const passedChecks: string[] = [];
  const { cleanSql, hasComments } = analyzeAndStripComments(sql);
  const trimmedSql = cleanSql.trim();
  const upperSql = trimmedSql.toUpperCase();
  const lowerSql = trimmedSql.toLowerCase();

  // 1. AST Structural Checks: Parentheses balance
  const balanced = checkParenthesesBalance(trimmedSql);
  if (!balanced) {
    errors.push('AST Structural Error: Unbalanced parentheses detected in SQL expression.');
  }

  // 2. Read-Only Safety Guard
  const statementType: 'SELECT' | 'WITH' | null = upperSql.startsWith('SELECT')
    ? 'SELECT'
    : upperSql.startsWith('WITH')
    ? 'WITH'
    : null;

  if (!statementType) {
    errors.push('Security Guard: Query must begin with SELECT or WITH (strictly read-only analytical queries permitted).');
  } else {
    passedChecks.push(`Read-only statement safety (${statementType})`);
  }

  // Check forbidden patterns against both raw and stripped SQL
  for (const forbidden of FORBIDDEN_SQL_PATTERNS) {
    if (forbidden.test(sql) || forbidden.test(trimmedSql)) {
      errors.push(`Security Guard: Disallowed SQL keyword or external file operation detected (${forbidden.source.replace(/\\b/g, '')}).`);
    }
  }

  // System catalog protection (duckdb_tables, information_schema, pg_catalog, etc.)
  const FORBIDDEN_CATALOGS = [
    /\bduckdb_[a-zA-Z0-9_]+\b/i,
    /\binformation_schema\b/i,
    /\bpg_catalog\b/i,
    /\bsqlite_master\b/i,
    /\bsqlite_temp_master\b/i,
  ];
  for (const catalog of FORBIDDEN_CATALOGS) {
    if (catalog.test(trimmedSql)) {
      errors.push('Security Guard: Direct access to system catalogs, internal schemas, and metadata views is prohibited.');
      break;
    }
  }

  // Check for multiple semicolon-separated statements (quote-aware scanner)
  const statementCount = countSqlStatements(trimmedSql);
  if (statementCount > 1) {
    errors.push('Security Guard: Only single-statement queries are permitted.');
  }

  // Extract CTE names if WITH statement
  const cteNames: string[] = [];
  if (statementType === 'WITH') {
    const cteMatches = trimmedSql.matchAll(/(?:WITH|,)\s*([a-zA-Z0-9_]+)\s+AS\s*\(/gi);
    for (const m of cteMatches) {
      cteNames.push(m[1].toLowerCase());
    }
  }

  // 3. Metric Availability Check (Test Group C)
  let needsClarification = false;
  let clarificationMessage: string | undefined;

  if (question) {
    const metricCheck = checkMetricAvailability(question, schema);
    if (!metricCheck.isAvailable) {
      needsClarification = true;
      clarificationMessage = metricCheck.clarification;
      errors.push(`Undefined Metric: ${metricCheck.clarification}`);
    }
  }

  // 4. Strict Table Name & Reference Verification
  const validTableNames = [
    schema.tableName.toLowerCase(),
    'dataset',
    `"${schema.tableName.toLowerCase()}"`,
    '"dataset"',
    ...cteNames,
  ];

  const tableMatches = Array.from(trimmedSql.matchAll(/(?:FROM|JOIN)\s+([a-zA-Z0-9_"']+)/gi));
  const referencedTables: string[] = [];
  let referencesValidTable = false;

  for (const match of tableMatches) {
    const rawTable = match[1].trim().toLowerCase();
    const cleanTable = rawTable.replace(/["'`]/g, '');
    referencedTables.push(cleanTable);
    if (validTableNames.includes(rawTable) || validTableNames.includes(cleanTable) || rawTable.startsWith('ranked_')) {
      referencesValidTable = true;
    }
  }

  if (tableMatches.length > 0 && !referencesValidTable) {
    errors.push(`Table Security Error: Query references table "${referencedTables.join(', ')}" instead of active dataset "${schema.tableName}".`);
  } else {
    passedChecks.push(`Target table references verified (${schema.tableName})`);
  }

  // 4. Plan Intent Conformance
  // Intent: Top N per group (e.g. "most sold product in each region")
  if (plan.intent === 'top_n_per_group') {
    const hasWindow =
      lowerSql.includes('row_number()') ||
      lowerSql.includes('rank()') ||
      lowerSql.includes('dense_rank()');
    const hasPartitionBy = lowerSql.includes('partition by');

    if (!hasWindow) {
      errors.push(
        'Intent Validation Error: Grouped ranking ("in each group") requires a window function like ROW_NUMBER() OVER (PARTITION BY ... ORDER BY ...).'
      );
    }

    if (!hasPartitionBy) {
      errors.push(
        'Intent Validation Error: Grouped ranking requires PARTITION BY to separate rankings per group/region.'
      );
    }

    // Check partition column
    if (plan.partition_by && plan.partition_by.length > 0) {
      for (const partCol of plan.partition_by) {
        if (!lowerSql.includes(partCol.toLowerCase())) {
          errors.push(
            `Intent Validation Error: Partition column "${partCol}" must appear in PARTITION BY clause.`
          );
        }
      }
    }

    // Check item entity (e.g. product)
    if (plan.item_entity && !lowerSql.includes(plan.item_entity.toLowerCase())) {
      errors.push(
        `Intent Validation Error: Target item column "${plan.item_entity}" is missing from the query.`
      );
    }

    // Check metric
    if (plan.metric && !lowerSql.includes(plan.metric.toLowerCase())) {
      errors.push(
        `Intent Validation Error: Target metric column "${plan.metric}" must be aggregated in the ranking order.`
      );
    }

    // Check rank filter (e.g. rank = 1 or rank <= N or rank_idx = 1)
    const hasRankFilter =
      /rank\s*=\s*\d+/i.test(trimmedSql) ||
      /rank\s*<=\s*\d+/i.test(trimmedSql) ||
      /row_num\s*=\s*\d+/i.test(trimmedSql) ||
      /row_num\s*<=\s*\d+/i.test(trimmedSql) ||
      /rank_idx\s*=\s*\d+/i.test(trimmedSql) ||
      /rank_idx\s*<=\s*\d+/i.test(trimmedSql);
    if (!hasRankFilter) {
      errors.push(
        'Intent Validation Error: Outer query must filter on rank (e.g. WHERE rank = 1 or rank <= limit) to return only top items per group.'
      );
    } else {
      passedChecks.push('Window ranking partition constraint verified');
    }
  }

  // Intent: Ranking (global)
  if (plan.intent === 'ranking') {
    if (!lowerSql.includes('order by')) {
      errors.push('Intent Validation Error: Ranking queries require an ORDER BY clause.');
    } else {
      passedChecks.push('Ordering clause verified');
    }
    if (!lowerSql.includes('limit')) {
      warnings.push('Ranking queries should include a LIMIT clause to bound results.');
    }
  }

  // Intent: Aggregate by dimension
  if (plan.intent === 'aggregate_by_dimension' && plan.dimensions.length > 0) {
    if (!lowerSql.includes('group by')) {
      errors.push('Intent Validation Error: Dimension aggregation requires a GROUP BY clause.');
    } else {
      passedChecks.push(`Group by ${plan.dimensions.join(', ')} verified`);
    }
  }

  // Intent: Filter lookup (Raw records)
  if (plan.intent === 'filter_lookup') {
    if (plan.filters && plan.filters.length > 0 && !lowerSql.includes('where')) {
      errors.push('Intent Validation Error: Filter query requires a WHERE clause.');
    }
    // Prevent unintended aggregation for raw record questions
    if (question) {
      const lowerQ = question.toLowerCase();
      const isRecordLevel =
        lowerQ.includes('which customer') ||
        lowerQ.includes('list all') ||
        lowerQ.includes('show all') ||
        lowerQ.includes('which order');

      if (isRecordLevel && lowerSql.includes('group by') && !lowerSql.includes('customer_id') && !lowerSql.includes('company_name') && !lowerSql.includes('order_id')) {
        errors.push('Intent Validation Error: Unintended aggregation detected for record-level lookup question.');
      } else {
        passedChecks.push('Record-level fidelity verified');
      }
    }
  }

  // 5. Query Plan Filter Verification (Checking all plan.filters in SQL)
  if (plan.filters && plan.filters.length > 0) {
    for (const f of plan.filters) {
      const colLower = f.column.toLowerCase();
      if (!lowerSql.includes(colLower)) {
        errors.push(`Intent Validation Error: Requested filter column "${f.column}" is missing from SQL WHERE clause.`);
        continue;
      }

      if (Array.isArray(f.value)) {
        for (const val of f.value) {
          if (!lowerSql.includes(String(val).toLowerCase())) {
            errors.push(`Intent Validation Error: Filter value "${val}" for column "${f.column}" is missing from SQL.`);
          }
        }
      } else if (f.value !== undefined && f.value !== null) {
        const valStr = String(f.value).toLowerCase();
        if (!lowerSql.includes(valStr)) {
          errors.push(`Intent Validation Error: Filter value "${f.value}" for column "${f.column}" is missing from SQL.`);
        }
      }
    }
    if (errors.length === 0) {
      passedChecks.push(`All ${plan.filters.length} requested filter constraints verified`);
    }
  }

  // 6. Question-to-SQL Semantic Alignment Checks
  if (question) {
    const lowerQ = question.toLowerCase();

    // 6a. Explicit Limit Check
    let requestedLimit = plan.limit;
    const numberWords: Record<string, number> = {
      one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
    };
    const wordMatch = lowerQ.match(/\btop\s+(one|two|three|four|five|six|seven|eight|nine|ten)\b/);
    if (wordMatch) {
      requestedLimit = numberWords[wordMatch[1]];
    } else {
      const topMatch =
        lowerQ.match(/\btop\s+(\d+)\b/) ||
        lowerQ.match(/\bfirst\s+(\d+)\b/) ||
        lowerQ.match(/\b(\d+)\s+(customers|orders|products|items|accounts|records|rows)\b/);

      if (topMatch) {
        requestedLimit = parseInt(topMatch[1], 10);
      }
    }

    if (requestedLimit !== undefined && requestedLimit > 0) {
      const limitMatch = lowerSql.match(/\blimit\s+(\d+)\b/);
      if (limitMatch) {
        const actualLimit = parseInt(limitMatch[1], 10);
        if (actualLimit !== requestedLimit) {
          errors.push(
            `Intent Validation Error: Question explicitly requested top ${requestedLimit}, but SQL specifies LIMIT ${actualLimit}. Change LIMIT to ${requestedLimit}.`
          );
        } else {
          passedChecks.push(`LIMIT ${requestedLimit} matches requested top-N`);
        }
      } else if (!lowerSql.includes('limit') && plan.intent !== 'top_n_per_group') {
        errors.push(
          `Intent Validation Error: Question explicitly requested top ${requestedLimit}, but SQL is missing LIMIT ${requestedLimit}.`
        );
      }
    }

    // 6b. Schema Categorical Value Alignment Check
    // A categorical word only constrains the SQL when the question actually points at
    // that column and the query is not already returning that column as a grouping label.
    const groupByClause = (lowerSql.match(/\bgroup\s+by\b([\s\S]*?)(?:\border\b|\blimit\b|\bhaving\b|$)/i) || ['', ''])[1];
    for (const col of schema.columns) {
      if (col.type !== 'string' || !col.sampleValues || col.sampleValues.length === 0) continue;
      const colName = col.name.toLowerCase();
      const columnMentioned = colName
        .split(/[^a-z0-9]+/)
        .some((token) => token.length >= 3 && lowerQ.includes(token));
      if (!columnMentioned) continue;
      if (groupByClause.includes(colName)) continue;

      for (const sampleVal of col.sampleValues) {
        if (typeof sampleVal === 'string' && sampleVal.length >= 3) {
          const valLower = sampleVal.toLowerCase();
          const wordRegex = buildValueMentionRegex(sampleVal);
          if (wordRegex.test(lowerQ)) {
            if (!lowerSql.includes(valLower)) {
              errors.push(
                `Intent Validation Error: Question filters on "${sampleVal}" (a value of column "${col.name}"), but the SQL does not mention "${sampleVal}". Add a WHERE condition such as "${col.name} = '${sampleVal}'".`
              );
            }
          }
        }
      }
    }

    // 6c. High Support Tickets / Qualification Check
    if (
      (lowerQ.includes('high support tickets') || lowerQ.includes('high ticket') || lowerQ.includes('with support tickets')) &&
      schema.columns.some((c) => c.name === 'support_tickets')
    ) {
      if (!lowerSql.includes('support_tickets')) {
        errors.push(
          'Intent Validation Error: Question specifies high support tickets, but SQL WHERE clause does not filter on support_tickets (e.g. support_tickets >= 5).'
        );
      } else {
        passedChecks.push('Support ticket threshold condition verified');
      }
    }

    // 6d. Churn Status Check (for churned / at-risk questions)
    if (
      (lowerQ.includes('at-risk or churned') || lowerQ.includes('churned or at-risk') || lowerQ.includes('at risk or churned')) &&
      schema.columns.some((c) => c.name === 'churn_status')
    ) {
      if (!lowerSql.includes('churn_status') || !lowerSql.includes('churned') || !lowerSql.includes('at-risk')) {
        errors.push(
          'Intent Validation Error: Question requests At-Risk or Churned customers, but SQL does not filter on both statuses (e.g. churn_status IN (\'Churned\', \'At-Risk\')).'
        );
      } else {
        passedChecks.push('Churn status (At-Risk & Churned) filter verified');
      }
    }

    // 6e. NPS Score Filter Check (e.g. NPS under 6)
    if (
      (lowerQ.includes('nps score under 6') || lowerQ.includes('nps < 6') || lowerQ.includes('nps under 6') || lowerQ.includes('nps below 6')) &&
      schema.columns.some((c) => c.name === 'nps_score')
    ) {
      const hasNpsUnder6 = /nps_score\s*<\s*6/i.test(trimmedSql) || /nps_score\s*<=\s*5/i.test(trimmedSql);
      if (!hasNpsUnder6) {
        errors.push('Intent Validation Error: Question specifies NPS score under 6, but SQL does not filter "nps_score < 6".');
      } else {
        passedChecks.push('NPS score (< 6) filter verified');
      }
    }

    // 6f. Ranking direction check. Only the first ORDER BY term carries analytical
    // meaning; trailing terms are deterministic tie-breakers and must not be read
    // as a second ranking direction.
    const isRanking = plan.intent === 'ranking' || plan.intent === 'top_n_per_group';
    const firstOrderDirection = trimmedSql.match(/\border\s+by\b[\s\S]*?\b(asc|desc)\b/i)?.[1]?.toUpperCase();
    const asksDescending = /\b(top|highest|most|greatest|largest|biggest)\b/.test(lowerQ);
    const asksAscending = /\b(bottom|lowest|least|smallest|fewest)\b/.test(lowerQ);

    if (firstOrderDirection) {
      if (isRanking && plan.ranking_direction !== firstOrderDirection) {
        errors.push(
          `Intent Validation Error: The query plan requires ${plan.ranking_direction} order, but the first ORDER BY term is ${firstOrderDirection}.`
        );
      } else if (asksDescending && asksAscending) {
        // "highest to lowest", "highest and lowest" — one ORDER BY cannot satisfy both.
        passedChecks.push(`Ordering direction (${firstOrderDirection}) recorded for a mixed highest/lowest request`);
      } else if (asksDescending && firstOrderDirection === 'ASC') {
        errors.push('Intent Validation Error: Top/highest ranking requests require DESC order, but the first ORDER BY term is ASC.');
      } else if (asksAscending && firstOrderDirection === 'DESC') {
        errors.push('Intent Validation Error: Bottom/lowest ranking requests require ASC order, but the first ORDER BY term is DESC.');
      } else {
        passedChecks.push(`Ranking direction (${firstOrderDirection}) verified`);
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    passedChecks,
    needsClarification,
    clarificationMessage,
    astAnalysis: {
      statementType: statementType || 'SELECT',
      tableReferences: referencedTables,
      hasComments,
      parenthesesBalanced: balanced,
    },
  };
}

/**
 * Validates DuckDB execution results against QueryPlan constraints post-execution.
 * Ensures returned rows adhere to the requested filter constraints, limits, and aggregation granularity.
 */
export function validateExecutionResult(
  rows: Record<string, any>[],
  columns: string[],
  plan: QueryPlan,
  schema: SemanticSchema
): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const passedChecks: string[] = [];
  const lowerCols = columns.map((c) => c.toLowerCase());

  // 1. Result Row Count
  if (rows.length === 0 && schema.rowCount > 0 && plan.intent !== 'filter_lookup' && !plan.filters?.length) {
    errors.push('Execution Result Error: Query returned 0 rows, but dataset contains records.');
  } else if (rows.length === 0) {
    passedChecks.push('Empty result permitted by dataset or requested filter constraints');
  }

  // 1b. Limit Check (for global ranking or overview queries, not per-group partition queries)
  if (plan.intent !== 'top_n_per_group' && plan.limit && rows.length > plan.limit) {
    errors.push(
      `Execution Result Error: Query returned ${rows.length} rows, exceeding requested limit of ${plan.limit}.`
    );
  } else if (plan.intent !== 'top_n_per_group' && plan.limit) {
    passedChecks.push(`Result row count (${rows.length}) within requested limit of ${plan.limit}`);
  }

  // 2. Expected Columns for Top N per group
  if (plan.intent === 'top_n_per_group') {
    if (plan.partition_by && plan.partition_by.length > 0) {
      for (const partCol of plan.partition_by) {
        if (!lowerCols.includes(partCol.toLowerCase())) {
          errors.push(
            `Execution Result Error: Result is missing required partition column "${partCol}". Returned columns: [${columns.join(', ')}].`
          );
        }
      }
    }

    if (plan.item_entity && !lowerCols.includes(plan.item_entity.toLowerCase())) {
      errors.push(
        `Execution Result Error: Result is missing target item column "${plan.item_entity}". Returned columns: [${columns.join(', ')}].`
      );
    }

    // Partition Cardinality Constraint
    if (plan.partition_by && plan.partition_by.length > 0 && (plan.limit === 1 || !plan.limit)) {
      const partColName = plan.partition_by[0].toLowerCase();
      const actualCol = columns.find((c) => c.toLowerCase() === partColName);

      if (actualCol) {
        const seenValues = new Set<any>();
        const duplicates = new Set<any>();

        for (const row of rows) {
          const val = row[actualCol];
          if (val !== undefined && val !== null) {
            if (seenValues.has(val)) {
              duplicates.add(val);
            }
            seenValues.add(val);
          }
        }

        if (duplicates.size > 0) {
          errors.push(
            `Execution Result Error: Constraint violated. Expected at most 1 row per "${actualCol}", but found duplicate entries for: ${Array.from(duplicates).join(', ')}. Ensure "WHERE rank = 1" is applied in outer query.`
          );
        } else {
          passedChecks.push(`1 row per ${actualCol} partition constraint verified`);
        }
      }
    }
  }

  // 3. Row-Level Filter Constraint Verification (Test Group A & B)
  if (plan.filters && plan.filters.length > 0 && rows.length > 0) {
    for (const f of plan.filters) {
      const targetCol = columns.find((c) => c.toLowerCase() === f.column.toLowerCase());
      if (targetCol) {
        for (let rIdx = 0; rIdx < rows.length; rIdx++) {
          const rowVal = rows[rIdx][targetCol];

          if (f.operator === '=') {
            if (String(rowVal).toLowerCase() !== String(f.value).toLowerCase()) {
              errors.push(
                `Execution Result Error: Row ${rIdx + 1} has ${targetCol} = "${rowVal}", violating filter "${targetCol} = ${f.value}".`
              );
              break;
            }
          } else if (f.operator === '<') {
            if (!(Number(rowVal) < Number(f.value))) {
              errors.push(
                `Execution Result Error: Row ${rIdx + 1} has ${targetCol} = ${rowVal}, which is NOT strictly < ${f.value}.`
              );
              break;
            }
          } else if (f.operator === '<=') {
            if (!(Number(rowVal) <= Number(f.value))) {
              errors.push(
                `Execution Result Error: Row ${rIdx + 1} has ${targetCol} = ${rowVal}, which is NOT <= ${f.value}.`
              );
              break;
            }
          } else if (f.operator === '>') {
            if (!(Number(rowVal) > Number(f.value))) {
              errors.push(
                `Execution Result Error: Row ${rIdx + 1} has ${targetCol} = ${rowVal}, which is NOT > ${f.value}.`
              );
              break;
            }
          } else if (f.operator === '>=') {
            if (!(Number(rowVal) >= Number(f.value))) {
              errors.push(
                `Execution Result Error: Row ${rIdx + 1} has ${targetCol} = ${rowVal}, which is NOT >= ${f.value}.`
              );
              break;
            }
          } else if (f.operator === 'IN' && Array.isArray(f.value)) {
            const allowed = f.value.map((v: any) => String(v).toLowerCase());
            if (!allowed.includes(String(rowVal).toLowerCase())) {
              errors.push(
                `Execution Result Error: Row ${rIdx + 1} has ${targetCol} = "${rowVal}", which is not in [${f.value.join(', ')}].`
              );
              break;
            }
          }
        }
      }
    }

    if (errors.length === 0) {
      passedChecks.push('All returned rows satisfy query filter constraints');
    }
  }

  // 4. Aggregation Uniqueness Constraint (Test Group D)
  // Every requested dimension identifies a group: "total MRR by plan tier" needs one row
  // per tier, and a segment x channel breakdown needs one row per combination.
  if (plan.intent === 'aggregate_by_dimension' && plan.dimensions.length > 0 && rows.length > 0) {
    const dimCols = plan.dimensions.map((d) => columns.find((c) => c.toLowerCase() === d.toLowerCase()));
    if (dimCols.every(Boolean)) {
      const dims = dimCols as string[];
      const seenKeys = new Set<string>();
      const dupCombos = new Set<string>();

      for (const row of rows) {
        const key = dims.map((dimCol) => String(row[dimCol] ?? '')).join(' | ');
        if (seenKeys.has(key)) {
          dupCombos.add(key);
        }
        seenKeys.add(key);
      }

      if (dupCombos.size > 0) {
        const preview = Array.from(dupCombos).slice(0, 5).join('; ');
        errors.push(
          `Execution Result Error: Aggregation uniqueness violated. Multiple rows share the same ${dims.join(' + ')} combination (e.g. ${preview}). Must aggregate to exactly 1 row per unique combination.`
        );
      } else {
        passedChecks.push(`Exactly 1 row per unique ${dims.join(' + ')} verified`);
      }
    }
  }

  // 5. Non-Null Sanity
  if (rows.length > 0 && columns.length > 0) {
    const firstCol = columns[0];
    const allNull = rows.every((r) => r[firstCol] === null || r[firstCol] === undefined);
    if (allNull) {
      warnings.push(`Primary column "${firstCol}" contains all NULL values in output.`);
    } else {
      passedChecks.push('Non-null primary column data integrity verified');
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    passedChecks,
  };
}
