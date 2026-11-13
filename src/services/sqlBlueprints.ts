import { QueryPlan } from './queryPlan';

export interface SqlBlueprint {
  name: string;
  description: string;
  template: string;
}

export const SQL_BLUEPRINTS: Record<string, SqlBlueprint> = {
  top_n_per_group: {
    name: 'Top N Items Per Group (Window Function / Partition)',
    description: 'Use when finding the most sold, top, best, or worst item within each region, category, or group.',
    template: `WITH ranked_items AS (
  SELECT 
    <partition_col>, 
    <item_col>, 
    <agg_func>(<metric_col>) AS <metric_alias>,
    ROW_NUMBER() OVER (
      PARTITION BY <partition_col> 
      ORDER BY <agg_func>(<metric_col>) <direction>
    ) AS rank
  FROM <table_name>
  <optional_where>
  GROUP BY <partition_col>, <item_col>
)
SELECT <partition_col>, <item_col>, <metric_alias>
FROM ranked_items
WHERE rank <= <limit>
ORDER BY <partition_col> ASC, rank ASC;`,
  },

  aggregate_by_dimension: {
    name: 'Dimension Aggregation',
    description: 'Use when summarizing a metric grouped by one or more categories or regions.',
    template: `SELECT 
  <dimension_col>, 
  COUNT(*) AS total_count,
  ROUND(<agg_func>(<metric_col>), 2) AS <metric_alias>
FROM <table_name>
<optional_where>
GROUP BY <dimension_col>
ORDER BY <metric_alias> DESC;`,
  },

  ranking: {
    name: 'Global Ranking (Top N Overall)',
    description: 'Use when ranking items across the entire dataset without partitioning.',
    template: `SELECT 
  <item_col>, 
  ROUND(<agg_func>(<metric_col>), 2) AS <metric_alias>
FROM <table_name>
<optional_where>
GROUP BY <item_col>
ORDER BY <metric_alias> <direction>
LIMIT <limit>;`,
  },

  percentage_of_total: {
    name: 'Percentage of Total Share',
    description: 'Use when calculating the market share or percentage contribution of each category.',
    template: `WITH totals AS (
  SELECT SUM(<metric_col>) AS grand_total FROM <table_name>
),
breakdown AS (
  SELECT 
    <dimension_col>, 
    SUM(<metric_col>) AS category_total
  FROM <table_name>
  GROUP BY <dimension_col>
)
SELECT 
  b.<dimension_col>, 
  b.category_total, 
  ROUND((b.category_total / t.grand_total) * 100, 2) AS pct_of_total
FROM breakdown b, totals t
ORDER BY b.category_total DESC;`,
  },

  filter_lookup: {
    name: 'Filtered Detail Records',
    description: 'Use when inspecting rows matching specific criteria (e.g. churned accounts, negative profit).',
    template: `SELECT <selected_cols>
FROM <table_name>
WHERE <conditions>
ORDER BY <sort_col> <direction>
LIMIT <limit>;`,
  },
};

/**
 * Returns formatted blueprints section for injection into LLM system prompt.
 */
export function getBlueprintPromptSection(): string {
  return `
SQL GENERATION BLUEPRINTS (DuckDB-WASM Compatible):
When formulating SQL, you MUST follow these canonical patterns:

1. TOP / MOST / BEST PER GROUP (e.g. "most sold product in each region", "top customer per industry"):
   DO NOT perform a simple GROUP BY without a window function.
   YOU MUST USE A CTE WITH ROW_NUMBER() OVER (PARTITION BY ... ORDER BY ...):
   \`\`\`sql
   WITH ranked_items AS (
     SELECT 
       <partition_column>, 
       <item_column>, 
       SUM(<metric_column>) AS total_<metric>,
       ROW_NUMBER() OVER (
         PARTITION BY <partition_column> 
         ORDER BY SUM(<metric_column>) DESC
       ) AS rank
     FROM dataset
     GROUP BY <partition_column>, <item_column>
   )
   SELECT <partition_column>, <item_column>, total_<metric>
   FROM ranked_items
   WHERE rank = 1
   ORDER BY total_<metric> DESC;
   \`\`\`

2. OVERALL TOP N (e.g. "top 5 products by revenue"):
   \`\`\`sql
   SELECT <item_column>, ROUND(SUM(<metric_column>), 2) AS total_<metric>
   FROM dataset
   GROUP BY <item_column>
   ORDER BY total_<metric> DESC
   LIMIT 5;
   \`\`\`

3. GROUPED AGGREGATIONS (e.g. "sales by region"):
   \`\`\`sql
   SELECT <dimension_column>, ROUND(SUM(<metric_column>), 2) AS total_<metric>
   FROM dataset
   GROUP BY <dimension_column>
   ORDER BY total_<metric> DESC;
   \`\`\`

4. PERCENTAGE OF TOTAL SHARE (e.g. "share of total MRR by plan tier"):
   \`\`\`sql
   WITH totals AS (
     SELECT SUM(<metric_column>) AS grand_total FROM dataset
   ),
   breakdown AS (
     SELECT <dimension_column>, SUM(<metric_column>) AS category_total
     FROM dataset
     GROUP BY <dimension_column>
   )
   SELECT b.<dimension_column>, b.category_total,
     ROUND((b.category_total / NULLIF(t.grand_total, 0)) * 100, 2) AS pct_of_total
   FROM breakdown b, totals t
   ORDER BY b.category_total DESC;
   \`\`\`

5. FILTERED AUDITS (e.g. "orders with discount > 15% and negative profit"):
   \`\`\`sql
   SELECT <key_columns>
   FROM dataset
   WHERE discount_pct > 0.15 AND profit < 0
   ORDER BY profit ASC
   LIMIT 20;
   \`\`\`
`.trim();
}

/**
 * Deterministically constructs SQL from a validated QueryPlan using blueprints.
 */
export function constructSqlFromPlan(plan: QueryPlan, tableName: string): string {
  // Model input still requires runtime checks before SQL interpolation.
  const reserved = new Set(('all analyse analyze and any array as asc asymmetric authorization between both case cast check collate column constraint create cross current_catalog current_date current_role current_schema current_time current_timestamp current_user default deferrable desc describe distinct do else end except false fetch for foreign from full grant group having in initially inner intersect into is join lambda lateral leading left limit localtime localtimestamp natural not null offset on only or order outer over overlaps pivot pivot_longer pivot_wider placing primary qualify references returning right select session_user show similar some summarize symmetric table then to trailing true union unique unpivot using variadic verbose when where window with').split(' '));
  const identifier = (name: string, alwaysQuote = false): string => {
    if (typeof name !== 'string' || !name.trim() || /[\x00-\x1f\x7f]/.test(name)) {
      throw new Error('Invalid SQL identifier');
    }
    return !alwaysQuote && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name) && !reserved.has(name.toLowerCase())
      ? name
      : `"${name.replace(/"/g, '""')}"`;
  };
  const literal = (value: unknown): string => {
    if (value === null) return 'NULL';
    if (typeof value === 'string' && !value.includes('\0')) return `'${value.replace(/'/g, "''")}'`;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
    throw new Error('Invalid SQL filter literal');
  };
  if (!['top_n_per_group', 'aggregate_by_dimension', 'ranking', 'comparison', 'filter_lookup', 'distribution', 'percentage_of_total', 'time_trend', 'overview'].includes(plan.intent)) {
    throw new Error('Unsupported query intent');
  }
  if (plan.limit !== undefined && (!Number.isSafeInteger(plan.limit) || plan.limit <= 0)) {
    throw new Error('SQL limit must be a positive safe integer');
  }
  const dir = plan.ranking_direction ?? 'DESC';
  if (dir !== 'ASC' && dir !== 'DESC') throw new Error('Invalid ranking direction');
  const agg = plan.aggregation ?? 'SUM';
  if (!['SUM', 'AVG', 'COUNT', 'MIN', 'MAX', 'COUNT_DISTINCT'].includes(agg)) throw new Error('Invalid aggregation');
  if (plan.time_grain != null && !['day', 'week', 'month', 'quarter', 'year'].includes(plan.time_grain)) {
    throw new Error('Unsupported time grain');
  }
  if (!Array.isArray(plan.dimensions) || (plan.partition_by !== undefined && !Array.isArray(plan.partition_by))) {
    throw new Error('Invalid grouping columns');
  }
  const dimensions = plan.dimensions.map((d) => identifier(d));
  const partitions = (plan.partition_by ?? []).map((p) => identifier(p));
  const item = plan.item_entity === undefined ? undefined : identifier(plan.item_entity);
  const metric = plan.metric === undefined || plan.metric === '*' ? undefined : identifier(plan.metric);
  if (plan.metric === '*' && agg !== 'COUNT') throw new Error('Only COUNT supports *');
  const aggregate = (): string => {
    if (agg === 'COUNT' && !metric) return 'COUNT(*)';
    if (!metric) throw new Error('Query plan requires a metric');
    return agg === 'COUNT_DISTINCT' ? `COUNT(DISTINCT ${metric})` : `${agg}(${metric})`;
  };
  const metricAlias = identifier(metric ? `total_${plan.metric}` : 'total_count');
  const table = identifier(tableName, true);
  const limitClause = plan.limit === undefined ? '' : `\nLIMIT ${plan.limit}`;

  if (plan.filters !== undefined && !Array.isArray(plan.filters)) throw new Error('Invalid filters');
  const conditions = (plan.filters ?? []).map((f) => {
    if (!f || !['=', '!=', '>', '<', '>=', '<=', 'IN', 'LIKE', 'IS NULL', 'IS NOT NULL'].includes(f.operator)) {
      throw new Error('Invalid filter operator');
    }
    const column = identifier(f.column);
    if (f.operator === 'IS NULL' || f.operator === 'IS NOT NULL') return `${column} ${f.operator}`;
    if (f.operator === 'IN') {
      if (!Array.isArray(f.value) || f.value.length === 0) throw new Error('IN requires a nonempty literal array');
      return `${column} IN (${f.value.map(literal).join(', ')})`;
    }
    if (f.value === null) {
      if (f.operator === '=') return `${column} IS NULL`;
      if (f.operator === '!=') return `${column} IS NOT NULL`;
      throw new Error('NULL requires an equality or null operator');
    }
    if (f.operator === 'LIKE' && typeof f.value !== 'string') throw new Error('LIKE requires a string');
    return `${column} ${f.operator} ${literal(f.value)}`;
  });
  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')} ` : '';

  // Detail intents must not turn duplicate records into grouped aggregates.
  if (plan.intent === 'filter_lookup' || (plan.intent === 'overview' && !metric && (plan.aggregation === undefined || agg === 'SUM'))) {
    const columns = [...new Set([...dimensions, ...(item ? [item] : []), ...(metric ? [metric] : [])])];
    const sortColumn = metric ?? item ?? dimensions[0];
    return `SELECT ${columns.length ? columns.join(', ') : '*'} FROM ${table} ${whereClause}${sortColumn && plan.ranking_direction ? `ORDER BY ${sortColumn} ${dir}` : ''}${limitClause}`.trim();
  }

  // 1. Top N per group
  if (plan.intent === 'top_n_per_group') {
    if (!partitions.length) throw new Error('Per-group ranking requires partition columns');
    const candidates = dimensions.filter((d) => !partitions.includes(d));
    const itemCol = item ?? (candidates.length === 1 ? candidates[0] : undefined);
    if (!itemCol || partitions.includes(itemCol)) throw new Error('Per-group ranking requires an item column');
    const groups = [...new Set([...partitions, itemCol, ...dimensions])].join(', ');
    const expression = aggregate();

    return `WITH ranked_items AS (
  SELECT
    ${groups},
    ${expression} AS ${metricAlias},
    ROW_NUMBER() OVER (PARTITION BY ${partitions.join(', ')} ORDER BY ${expression} ${dir}) AS rank
  FROM ${table}
  ${whereClause}GROUP BY ${groups}
)
SELECT ${groups}, ${metricAlias}
FROM ranked_items
WHERE rank <= ${plan.limit ?? 1}
ORDER BY ${metricAlias} ${dir}`;
  }

  // 2. Percentage of total share: filter both sides before limiting results.
  if (plan.intent === 'percentage_of_total') {
    if (!dimensions.length) throw new Error('Percentage query requires dimensions');
    if (agg !== 'SUM' && agg !== 'COUNT') throw new Error('Percentage of total requires an additive SUM or COUNT metric');
    const expression = aggregate();
    const dims = dimensions.join(', ');
    return `WITH totals AS (
  SELECT ${expression} AS grand_total FROM ${table}
  ${whereClause}),
breakdown AS (
  SELECT
    ${dims},
    ${expression} AS category_total
  FROM ${table}
  ${whereClause}GROUP BY ${dims}
)
SELECT
  ${dimensions.map((d) => `b.${d}`).join(', ')},
  b.category_total,
  ROUND((b.category_total / NULLIF(t.grand_total, 0)) * 100, 2) AS pct_of_total
FROM breakdown b, totals t
ORDER BY b.category_total ${dir}${limitClause}`;
  }

  // 3. Only explicit ranking intents use the ranking blueprint.
  if (plan.intent === 'ranking') {
    const itemCol = item ?? (dimensions.length === 1 ? dimensions[0] : undefined);
    if (!itemCol) throw new Error('Ranking requires an item column');
    const groups = [...new Set([itemCol, ...dimensions])].join(', ');
    return `SELECT ${groups}, ROUND(${aggregate()}, 2) AS ${metricAlias}
FROM ${table}
${whereClause}GROUP BY ${groups}
ORDER BY ${metricAlias} ${dir}${limitClause}`;
  }

  // 4. Explicit grouped intents retain every requested dimension and grain.
  if (['aggregate_by_dimension', 'comparison', 'distribution', 'time_trend'].includes(plan.intent) || (plan.intent === 'overview' && dimensions.length > 0)) {
    if (!dimensions.length) throw new Error('Grouped query requires dimensions');
    const groups = dimensions.map((d, i) => plan.intent === 'time_trend' && plan.time_grain && i === 0
      ? `DATE_TRUNC('${plan.time_grain}', CAST(${d} AS TIMESTAMP))`
      : d);
    const selected = groups.map((g, i) => g === dimensions[i] ? g : `${g} AS ${dimensions[i]}`).join(', ');
    const expression = aggregate();
    return `SELECT ${selected}, COUNT(*) AS row_count, ROUND(${expression}, 2) AS ${metricAlias}
FROM ${table}
${whereClause}GROUP BY ${groups.join(', ')}
ORDER BY ${plan.intent === 'time_trend' ? groups[0] : metricAlias} ${dir}${limitClause}`;
  }

  // 5. Scalar overview aggregates (including metric-free COUNT(*)).
  return `SELECT ROUND(${aggregate()}, 2) AS ${metricAlias} FROM ${table} ${whereClause}${limitClause}`.trim();
}
