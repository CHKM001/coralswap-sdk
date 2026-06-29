/**
 * Metric category for monitoring.
 * - `liquidity`: pool TVL and reserve metrics
 * - `volume`: swap volume metrics
 * - `fees`: protocol fee revenue metrics
 * - `gas`: Soroban resource usage metrics
 * - `price`: token spot / TWAP price metrics
 * - `pairs`: pair creation and lifecycle metrics
 */
export type MetricCategory =
  | 'liquidity'
  | 'volume'
  | 'fees'
  | 'gas'
  | 'price'
  | 'pairs';

/**
 * Granularity of metric data points.
 */
export type MetricGranularity = '5m' | '15m' | '1h' | '4h' | '1d' | '1w';

/**
 * A single metric data point with a timestamp and value.
 */
export interface MetricDataPoint {
  /** Unix timestamp (seconds) of this data point */
  timestamp: number;
  /** Numeric value of the metric */
  value: number;
}

/**
 * Configuration for a single monitored metric.
 */
export interface MetricConfig {
  /** Human-readable metric name (e.g. "CORAL-USDC TVL") */
  name: string;
  /** Metric category used for grouping in dashboards */
  category: MetricCategory;
  /** Soroban contract address this metric tracks */
  targetAddress: string;
  /** Optional token address for price / volume metrics */
  tokenAddress?: string;
  /** Collection granularity */
  granularity: MetricGranularity;
  /** Whether this metric is being actively collected. Defaults to `true`. */
  enabled?: boolean;
  /** Upper bound beyond which a breach alert is triggered (optional) */
  alertUpperBound?: number;
  /** Lower bound beyond which a breach alert is triggered (optional) */
  alertLowerBound?: number;
}

/**
 * A registered metric with its current collection state.
 */
export interface MetricInstance {
  /** Unique metric identifier */
  id: string;
  /** Configuration snapshot */
  config: MetricConfig;
  /** Most recently collected data points (up to 1000) */
  recentData: MetricDataPoint[];
  /** Current value of the metric (latest data point) */
  currentValue?: number;
  /** Whether the current value breaches the configured bounds */
  inBreach: boolean;
  /** Unix timestamp when data collection started */
  createdAt: number;
}

/**
 * Aggregated monitoring dashboard snapshot.
 */
export interface MonitoringDashboard {
  /** Metric instances grouped by category */
  categories: Partial<Record<MetricCategory, MetricInstance[]>>;
  /** Total number of active metric instances */
  totalMetrics: number;
  /** Number of metrics currently in breach */
  metricsInBreach: number;
  /** USD value of total liquidity across all monitored pools */
  totalLiquidityUSD: number;
  /** 24h swap volume across all monitored pools */
  volume24hUSD: number;
  /** 24h protocol fee revenue */
  fees24hUSD: number;
  /** Average Soroban resource fee across recent transactions */
  averageGasStroops: number;
}

/**
 * Options for querying historical metric data.
 */
export interface MetricQueryOptions {
  /** Metric ID to query */
  metricId: string;
  /** Start of the query window (inclusive, unix seconds) */
  fromTimestamp: number;
  /** End of the query window (inclusive, unix seconds) */
  toTimestamp: number;
  /** Downsampling granularity. Defaults to the metric's configured granularity. */
  granularity?: MetricGranularity;
  /** Maximum number of data points to return. Defaults to 1000. */
  limit?: number;
}
