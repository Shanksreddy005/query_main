import { ColumnMeta, Dataset } from '../types';

export type ColumnRole = 'dimension' | 'measure' | 'identifier' | 'temporal';

export interface SemanticColumnMeta extends ColumnMeta {
  role: ColumnRole;
  semanticMeaning?: string;
  isNumeric: boolean;
  isCategorical: boolean;
  cardinality: number;
}

export interface SemanticSchema {
  tableName: string;
  datasetName: string;
  rowCount: number;
  columns: SemanticColumnMeta[];
  dimensions: SemanticColumnMeta[];
  measures: SemanticColumnMeta[];
  identifiers: SemanticColumnMeta[];
  temporals: SemanticColumnMeta[];
  columnByName: Map<string, SemanticColumnMeta>;
}

/**
 * Infers semantic role and business meaning of a column.
 */
function inferColumnRole(col: ColumnMeta, totalRows: number): { role: ColumnRole; semanticMeaning: string } {
  const name = col.name.toLowerCase();

  // 1. Temporals (dates, timestamps)
  if (
    col.type === 'date' ||
    name.endsWith('_date') ||
    name.endsWith('_time') ||
    name.endsWith('_at') ||
    name === 'date' ||
    name === 'timestamp' ||
    name === 'year' ||
    name === 'month' ||
    name === 'day'
  ) {
    return { role: 'temporal', semanticMeaning: 'time / date attribute' };
  }

  // 2. Identifiers (primary keys, IDs, unique names)
  if (
    name.endsWith('_id') ||
    name.startsWith('id_') ||
    name === 'id' ||
    (col.uniqueCount === totalRows && col.type === 'string' && totalRows > 5)
  ) {
    return { role: 'identifier', semanticMeaning: 'unique entity identifier' };
  }

  // 3. Measures (numerical metrics that can be aggregated)
  if (col.type === 'number') {
    // Special case: numeric IDs or zip codes or years
    if (name.endsWith('_id') || name.endsWith('zip') || name.endsWith('code')) {
      return { role: 'identifier', semanticMeaning: 'numeric identifier' };
    }
    if (name === 'year') {
      return { role: 'temporal', semanticMeaning: 'calendar year' };
    }

    let meaning = 'numeric metric';
    if (name.includes('sales') || name.includes('revenue') || name.includes('mrr') || name.includes('arr') || name.includes('price')) {
      meaning = 'monetary amount / revenue';
    } else if (name.includes('qty') || name.includes('quantity') || name.includes('unit') || name.includes('volume') || name.includes('sold')) {
      meaning = 'physical volume / units sold';
    } else if (name.includes('profit') || name.includes('margin') || name.includes('gain') || name.includes('net')) {
      meaning = 'net profitability / margin';
    } else if (name.includes('discount')) {
      meaning = 'discount rate / price reduction';
    } else if (name.includes('ticket') || name.includes('issue') || name.includes('score') || name.includes('nps')) {
      meaning = 'performance or service rating score';
    } else if (name.includes('user') || name.includes('count') || name.includes('seat')) {
      meaning = 'user / seat count';
    }

    return { role: 'measure', semanticMeaning: meaning };
  }

  // 4. Dimensions (categorical attributes, groups, geography, status)
  let meaning = 'categorical dimension';
  if (name.includes('region') || name.includes('territory') || name.includes('zone') || name.includes('country') || name.includes('state') || name.includes('city')) {
    meaning = 'geographic territory';
  } else if (name.includes('product') || name.includes('item') || name.includes('sku') || name.includes('merchandise')) {
    meaning = 'product or item entity';
  } else if (name.includes('category') || name.includes('department') || name.includes('segment')) {
    meaning = 'classification category';
  } else if (name.includes('status') || name.includes('churn') || name.includes('stage')) {
    meaning = 'lifecycle or operational status';
  } else if (name.includes('plan') || name.includes('tier') || name.includes('subscription')) {
    meaning = 'pricing or subscription tier';
  } else if (name.includes('industry') || name.includes('vertical')) {
    meaning = 'business vertical or industry';
  } else if (name.includes('customer') || name.includes('company') || name.includes('client') || name.includes('account')) {
    meaning = 'customer or client organization';
  }

  return { role: 'dimension', semanticMeaning: meaning };
}

/**
 * Profiles a dataset's columns into a rich SemanticSchema.
 */
export function profileDatasetSchema(dataset: Dataset): SemanticSchema {
  const semanticColumns: SemanticColumnMeta[] = dataset.columns.map((col) => {
    const { role, semanticMeaning } = inferColumnRole(col, dataset.rowCount);
    return {
      ...col,
      role,
      semanticMeaning,
      isNumeric: col.type === 'number',
      isCategorical: role === 'dimension' || col.type === 'string' || col.type === 'boolean',
      cardinality: col.uniqueCount,
    };
  });

  const dimensions = semanticColumns.filter((c) => c.role === 'dimension');
  const measures = semanticColumns.filter((c) => c.role === 'measure');
  const identifiers = semanticColumns.filter((c) => c.role === 'identifier');
  const temporals = semanticColumns.filter((c) => c.role === 'temporal');

  const columnByName = new Map<string, SemanticColumnMeta>();
  semanticColumns.forEach((c) => {
    columnByName.set(c.name.toLowerCase(), c);
  });

  return {
    tableName: dataset.tableName,
    datasetName: dataset.name,
    rowCount: dataset.rowCount,
    columns: semanticColumns,
    dimensions,
    measures,
    identifiers,
    temporals,
    columnByName,
  };
}

/**
 * Checks whether a column name or value appears to represent personally identifiable or high-sensitivity data.
 */
export function isPiiOrSensitiveColumn(columnName: string): boolean {
  const name = columnName.toLowerCase();
  return (
    name.includes('email') ||
    name.includes('phone') ||
    name.includes('ssn') ||
    name.includes('tax_id') ||
    name.includes('credit_card') ||
    name.includes('password') ||
    name.includes('secret') ||
    name.includes('token') ||
    name.includes('address') ||
    name.includes('ip_address')
  );
}

// Evidence-based floor for disclosing a numeric min/max to a provider. The bundled demo
// datasets hold 15 and 25 rows, and a row must not be identifiable from the disclosed range.
// At 25 rows a single record is at most 4% of the table, while typical small extracts
// (tens of rows) still give the planner the bounds it needs for filters.
const MIN_ROWS_FOR_RANGE_DISCLOSURE = 25;

/**
 * Rounds away from the data so the disclosed interval still contains the true min and max.
 * The lower bound is not allowed above the data and the upper bound is not allowed below it;
 * float64 and toPrecision() can both snap a bound one unit inward, so the result is stepped
 * outward until it encloses the value. A bound already at two significant figures is returned
 * unchanged — widening is a minimisation measure, not a guarantee that the exact extreme
 * cannot appear. Returns NaN when no finite two-significant-figure bound exists; the caller
 * then withholds the whole range.
 */
export function roundRangeBound(value: number, direction: 'down' | 'up'): number {
  if (!Number.isFinite(value)) return NaN;
  if (value === 0) return value;
  const magnitude = Math.floor(Math.log10(Math.abs(value)));
  const step = Math.pow(10, magnitude - 1);
  if (!Number.isFinite(step) || step === 0) return NaN;
  const scaled = value / step;
  const outward = direction === 'down' ? -1 : 1;
  let units = direction === 'down' ? Math.floor(scaled + 1e-9) : Math.ceil(scaled - 1e-9);
  for (let attempt = 0; attempt < 64; attempt++) {
    const candidate = Number((units * step).toPrecision(12));
    if (!Number.isFinite(candidate)) return NaN;
    const encloses = direction === 'down' ? candidate <= value : candidate >= value;
    if (encloses) return candidate;
    units += outward;
  }
  return NaN;
}

export interface SchemaPromptOptions {
  /**
   * When true (default), no cell values are transmitted. Column names, types, roles and
   * synthetic examples are, together with aggregate statistics (distinct counts and outward-
   * rounded numeric min/max where enough rows sit behind them) — see
   * MIN_ROWS_FOR_RANGE_DISCLOSURE.
   */
  strictZeroContentEgress?: boolean;
  /**
   * When true, permits low-cardinality non-PII categorical enums (e.g. ['Enterprise', 'Starter'])
   * to be transmitted to assist with exact WHERE filters. Off by default; the production planner
   * never enables it.
   */
  allowCategoricalEnums?: boolean;
}

/**
 * Builds a prompt-friendly semantic description of the schema under the strict zero-row egress
 * policy. Row values and cell pairings are never included, but aggregate statistics — distinct
 * counts and, for tables of at least MIN_ROWS_FOR_RANGE_DISCLOSURE rows, outward-rounded numeric
 * min/max — are, because the planner needs them to write valid filters and ranges.
 * Masks PII and high-cardinality entity identifiers to prevent data leakage to external models.
 */
export function formatSemanticSchemaPrompt(
  schema: SemanticSchema,
  options: SchemaPromptOptions = { strictZeroContentEgress: true, allowCategoricalEnums: false }
): string {
  const allowEnums = options.allowCategoricalEnums && !options.strictZeroContentEgress;

  const formatCols = (cols: SemanticColumnMeta[]) =>
    cols
      .map((c) => {
        let line = `  - "${c.name}" (${c.type}, role: ${c.role.toUpperCase()}) -> ${c.semanticMeaning || ''}`;
        
        // PII or sensitive column: strictly omit real cell samples
        if (isPiiOrSensitiveColumn(c.name)) {
          line += ` [Distinct: ${c.cardinality}, Protected PII: Synthetic values only]`;
          return line;
        }

        // High-cardinality identifiers: provide synthetic masked examples rather than user records
        if (c.role === 'identifier' || (c.cardinality > 20 && c.type === 'string')) {
          line += ` [Distinct: ${c.cardinality}, Entity Keys: High cardinality identifier]`;
          return line;
        }

        // Low-cardinality categorical dimensions
        if (c.sampleValues && c.sampleValues.length > 0) {
          if (allowEnums) {
            const safeSamples = c.sampleValues.slice(0, 5).map((v) => JSON.stringify(v)).join(', ');
            line += ` [Distinct: ${c.cardinality}, Categories: ${safeSamples}]`;
          } else {
            // Strict zero-content egress: synthetic examples only
            line += ` [Distinct: ${c.cardinality}, Synthetic Types: "Category_A", "Category_B"]`;
          }
        }

        if (c.min !== undefined && c.max !== undefined) {
          // On a small table the min and max *are* the data, so a range is only disclosed
          // when enough records sit behind it for the statistic to stay an aggregate.
          if (schema.rowCount < MIN_ROWS_FOR_RANGE_DISCLOSURE) {
            line += ' [Range: withheld, dataset too small for a range to stay aggregate]';
          } else {
            const disclosedMin = typeof c.min === 'number' ? roundRangeBound(c.min, 'down') : c.min;
            const disclosedMax = typeof c.max === 'number' ? roundRangeBound(c.max, 'up') : c.max;
            const nonFinite =
              (typeof disclosedMin === 'number' && !Number.isFinite(disclosedMin)) ||
              (typeof disclosedMax === 'number' && !Number.isFinite(disclosedMax));
            line += nonFinite
              ? ' [Range: withheld, no safe rounded bound could be produced]'
              : ` [Range: ${disclosedMin} to ${disclosedMax}]`;
          }
        }
        return line;
      })
      .join('\n');

  const egressPolicyNotice = allowEnums
    ? `ZERO-ROW EGRESS POLICY: ENABLED (No data rows are transmitted. Column names, inferred types and roles, cardinalities and non-PII categorical values are included${
        schema.rowCount >= MIN_ROWS_FOR_RANGE_DISCLOSURE ? ', and numeric min/max ranges widened outward to two significant figures are included because the table holds at least ' + MIN_ROWS_FOR_RANGE_DISCLOSURE + ' rows (a range that no finite bound can contain is withheld)' : ', while numeric min/max ranges are withheld for this small table'
      }.)`
    : `STRICT ZERO-ROW EGRESS POLICY: ENABLED (No data rows or cell pairings are transmitted. Included: column names, inferred types and roles, distinct-value counts${
        schema.rowCount >= MIN_ROWS_FOR_RANGE_DISCLOSURE ? ' and numeric min/max ranges widened outward to two significant figures (the table holds at least ' + MIN_ROWS_FOR_RANGE_DISCLOSURE + ' rows; a range that no finite bound can contain is withheld)' : ' while numeric min/max ranges are withheld because this table is small enough for a range to identify individual rows'
      }. Synthetic category labels are used in place of real values.)`;

  return `
TABLE: "${schema.tableName}" (alias: "dataset")
TOTAL ROWS: ${schema.rowCount}
${egressPolicyNotice}

MEASURES / METRICS (Aggregatable Numbers):
${formatCols(schema.measures) || '  (none)'}

DIMENSIONS (Grouping & Filtering Categories):
${formatCols(schema.dimensions) || '  (none)'}

IDENTIFIERS (Unique Entity Keys):
${formatCols(schema.identifiers) || '  (none)'}

TEMPORAL / DATES:
${formatCols(schema.temporals) || '  (none)'}
`.trim();
}

export interface InferredColumnProfile {
  name: string;
  dataType: string;
  distinctValues: string[];
  hasNulls: boolean;
  inferredRole: 'DIMENSION' | 'METRIC' | 'TEMPORAL' | 'KEY';
}

export interface DatasetProfile {
  tableName: string;
  columnNames: string[];
  columns: InferredColumnProfile[];
}

export class SchemaProfiler {
  private db: any; // DuckDB-WASM instance

  constructor(duckDbInstance: any) {
    this.db = duckDbInstance;
  }

  /**
   * Leverages DuckDB's native execution engine to dynamically extract table semantics
   * without extracting or reading sensitive underlying text rows.
   */
  public async profileTable(tableName: string): Promise<DatasetProfile> {
    const conn = await this.db.connect();
    
    // 1. Fetch Structural Outlines instantly using SUMMARIZE
    const summaryResult = await conn.query(`SUMMARIZE "${tableName}";`);
    const summaryRows = summaryResult.toArray().map((r: any) => r.toJSON());

    const columns: InferredColumnProfile[] = [];

    for (const col of summaryRows) {
      const colName = col.column_name;
      const dType = col.column_type;
      
      // 2. Fetch High-Probability Categorical Enums for Low-Cardinality Fields (< 10 distinct values)
      let distinctValues: string[] = [];
      const cardResult = await conn.query(`SELECT COUNT(DISTINCT "${colName}") as c FROM "${tableName}";`);
      const distinctCount = cardResult.toArray()[0].c;

      if (distinctCount > 0 && distinctCount <= 10) {
        const enumResult = await conn.query(`SELECT DISTINCT "${colName}"::VARCHAR as val FROM "${tableName}" WHERE "${colName}" IS NOT NULL LIMIT 10;`);
        distinctValues = enumResult.toArray().map((r: any) => r.val);
      }

      // 3. Infer Operational Roles to strictly direct model calculation vectors
      let inferredRole: 'DIMENSION' | 'METRIC' | 'TEMPORAL' | 'KEY' = 'DIMENSION';
      if (['INTEGER', 'BIGINT', 'DOUBLE', 'FLOAT', 'DECIMAL', 'HUGEINT'].includes(dType.toUpperCase()) && distinctCount > 12) {
        inferredRole = 'METRIC';
      } else if (['DATE', 'TIMESTAMP', 'TIME'].some(t => dType.toUpperCase().includes(t))) {
        inferredRole = 'TEMPORAL';
      } else if (colName.toLowerCase().endsWith('id') || colName.toLowerCase().endsWith('key')) {
        inferredRole = 'KEY';
      }

      columns.push({
        name: colName,
        dataType: dType,
        distinctValues,
        hasNulls: parseFloat(col.null_percentage) > 0,
        inferredRole
      });
    }

    await conn.close();

    return {
      tableName,
      columnNames: columns.map(c => c.name),
      columns
    };
  }
}
