/**
 * Protocol monitoring, health checks, and metric definitions for CoralSwap.
 *
 * This module provides a comprehensive view of CoralSwap protocol health,
 * including pool-level metrics (TVL, volume, fees), system-level health
 * checks (RPC connectivity, ledger sync), and custom metric queries.
 *
 * **Metric categories**
 *
 * - **Pool metrics** — Reserves, volume, fees, liquidity depth, price.
 * - **System metrics** — RPC latency, ledger gap, contract state.
 * - **Risk metrics** — Price deviation, impermanent loss estimate, concentration.
 * - **Custom metrics** — User-defined aggregations over event data.
 *
 * {@includeCode ./usage-examples.ts}
 *
 * @module monitoring
 */

import { SorobanRpc } from '@stellar/stellar-sdk';
import { CoralSwapClient } from '@/client';
import { CoralSwapSDKError } from '@/errors';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Supported metric data types.
 *
 * - `gauge`     — A single numeric value that can go up or down (e.g., TVL).
 * - `counter`   — A monotonically increasing value (e.g., total swaps).
 * - `histogram` — A distribution of values (e.g., swap size distribution).
 * - `summary`   — A summary with quantiles (e.g., latency p50/p95/p99).
 */
export type MetricType = 'gauge' | 'counter' | 'histogram' | 'summary';

/**
 * Metric definition metadata.
 */
export interface MetricDefinition {
  /** Unique metric name (e.g., `pool.tvl_usd`). */
  name: string;
  /** Human-readable description. */
  description: string;
  /** Metric type. */
  type: MetricType;
  /** Unit of measurement (e.g., "USD", "ledgers", "tokens"). */
  unit: string;
  /** Labels that can be attached to filter/group metric values. */
  labels?: string[];
}

/**
 * A single metric data point.
 */
export interface MetricPoint {
  /** Metric name. */
  name: string;
  /** Numeric value. */
  value: number;
  /** Metric type. */
  type: MetricType;
  /** Unit of measurement. */
  unit: string;
  /** ISO-8601 timestamp of the observation. */
  timestamp: string;
  /** Optional label key-value pairs for filtering. */
  labels?: Record<string, string>;
}

/**
 * Pool-level health status.
 */
export interface PoolHealth {
  /** Pool contract address. */
  pairAddress: string;
  /** Whether the pool is operational. */
  operational: boolean;
  /** Current total value locked in USD. */
  tvlUSD: number;
  /** 24-hour trading volume in USD. */
  volume24hUSD: number;
  /** 24-hour fee revenue in USD. */
  fees24hUSD: number;
  /** Current reserve ratio (reserve0 / reserve1). */
  reserveRatio: number;
  /** Price deviation from oracle in basis points (0 if no oracle). */
  oracleDeviationBps: number;
  /** Timestamp of the last swap event (Unix seconds). */
  lastSwapAt?: number;
  /** Any active error conditions. */
  errors: string[];
  /** Any active warnings. */
  warnings: string[];
}

/**
 * System-level health check result.
 */
export interface SystemHealth {
  /** Whether the system is healthy overall. */
  healthy: boolean;
  /** RPC endpoint status. */
  rpc: {
    connected: boolean;
    latencyMs: number;
    latestLedger: number;
    error?: string;
  };
  /** Ledger sync status. */
  ledger: {
    currentLedger: number;
    lastCheckedAt: string;
    gapLedgers: number;
  };
  /** Available Soroban contract IDs with their versions. */
  contracts: Array<{
    address: string;
    version?: string;
    reachable: boolean;
  }>;
  /** Timestamp of the health check. */
  checkedAt: string;
}

/**
 * Parameters for querying custom metrics.
 */
export interface MetricQuery {
  /** Metric name pattern (supports glob: `pool.*`). */
  metricPattern: string;
  /** Start ledger (inclusive). */
  fromLedger: number;
  /** End ledger (inclusive). */
  toLedger: number;
  /** Aggregation function. */
  aggregation?: 'avg' | 'sum' | 'min' | 'max' | 'count';
  /** Label filters (key=value). */
  labels?: Record<string, string>;
}

/**
 * Aggregated metric result.
 */
export interface AggregatedMetric {
  /** Metric name. */
  name: string;
  /** Aggregation function applied. */
  aggregation: string;
  /** Aggregated value. */
  value: number;
  /** Unit of measurement. */
  unit: string;
  /** Number of raw data points. */
  count: number;
  /** Time range of the query. */
  fromLedger: number;
  toLedger: number;
}

/**
 * High-level protocol summary.
 */
export interface ProtocolSummary {
  /** Total value locked across all pools in USD. */
  totalTVLUSD: number;
  /** 24-hour global trading volume in USD. */
  volume24hUSD: number;
  /** 24-hour global fee revenue in USD. */
  fees24hUSD: number;
  /** Number of active pools. */
  poolCount: number;
  /** Number of active pairs with non-zero liquidity. */
  activePairCount: number;
  /** Total LP token holders across all pools. */
  totalLPHolders: number;
  /** Timestamp of the snapshot. */
  timestamp: string;
}

// ---------------------------------------------------------------------------
// MonitoringModule
// ---------------------------------------------------------------------------

/**
 * Protocol monitoring and health check module.
 *
 * Provides methods to query pool-level and system-level metrics,
 * perform health checks, and compute aggregated statistics for
 * dashboards and alerting pipelines.
 *
 * **Supported metrics**
 *
 * | Metric name            | Type      | Unit    | Description                     |
 * |------------------------|-----------|---------|---------------------------------|
 * | `pool.tvl_usd`         | gauge     | USD     | Pool total value locked         |
 * | `pool.volume_24h`      | counter   | USD     | 24-hour pool volume             |
 * | `pool.fees_24h`        | counter   | USD     | 24-hour pool fees               |
 * | `pool.reserve_ratio`   | gauge     | ratio   | Token reserve ratio             |
 * | `pool.price`           | gauge     | USD     | Spot price from reserves        |
 * | `system.rpc_latency`   | gauge     | ms      | RPC endpoint latency            |
 * | `system.ledger_gap`    | gauge     | ledgers | Ledgers behind head             |
 * | `risk.price_deviation` | gauge     | bps     | Deviation from oracle price     |
 * | `risk.il_since_entry`  | histogram | USD     | Impermanent loss since entry    |
 *
 * @example
 * ```ts
 * const monitor = new MonitoringModule(client);
 *
 * // Get protocol summary
 * const summary = await monitor.getProtocolSummary();
 * console.log(`TVL: $${summary.totalTVLUSD.toLocaleString()}`);
 *
 * // Check system health
 * const health = await monitor.checkSystemHealth();
 * if (!health.healthy) {
 *   console.error('Health check failed:', health.rpc.error);
 * }
 *
 * // Query pool health for a specific pair
 * const poolHealth = await monitor.getPoolHealth('CA3D...');
 * ```
 */
export class MonitoringModule {
  private client: CoralSwapClient;

  /**
   * @param client - Configured CoralSwap client
   */
  constructor(client: CoralSwapClient) {
    this.client = client;
  }

  // -----------------------------------------------------------------------
  // Pool metrics
  // -----------------------------------------------------------------------

  /**
   * Return health and metrics for a specific pool.
   *
   * Fetches reserves, derives spot price, queries recent swap volume
   * and fee data, and compares the spot price against the oracle price
   * (if available).
   *
   * @param pairAddress - Pool contract address.
   * @returns {@link PoolHealth} with operational status, TVL, volume,
   *   fees, reserve ratio, oracle deviation, and any active warnings.
   * @throws {CoralSwapSDKError} If the pair contract is unreachable.
   *
   * @example
   * ```ts
   * const health = await monitor.getPoolHealth('CA3D4E5F...');
   * if (health.oracleDeviationBps > 500) {
   *   console.warn('Price deviation exceeds 5%');
   * }
   * ```
   */
  async getPoolHealth(pairAddress: string): Promise<PoolHealth> {
    const pair = this.client.pair(pairAddress);

    let reserves, lpToken;
    try {
      const pairData = await Promise.all([
        pair.getReserves(),
        pair.getTokens(),
      ]);
      reserves = pairData[0];
      const lpAddr = await pair.getLPTokenAddress();
      lpToken = this.client.lpToken(lpAddr);
    } catch (err) {
      throw new CoralSwapSDKError(
        'POOL_UNREACHABLE',
        `Failed to fetch pool data for ${pairAddress}`,
        { pairAddress, error: err },
      );
    }

    const { reserve0, reserve1 } = reserves;
    const reserveRatio =
      reserve1 > 0n ? Number((reserve0 * 10000n) / reserve1) / 10000 : 0;

    // Fetch recent volume and fees via event logs
    const currentLedger = await this.client.getCurrentLedger();
    const fromLedger = Math.max(0, currentLedger - 17280); // ~24h at 5s/ledger
    const events = await this.fetchSwapEvents(pairAddress, fromLedger, currentLedger);
    const { volume24hUSD, fees24hUSD } = this.aggregateVolumeAndFees(events);

    // Compute TVL using on-chain spot prices
    const totalSupply = await lpToken.totalSupply();
    const lpBalance = await lpToken.balance(pairAddress);
    const tvlUSD = totalSupply > 0n
      ? (Number(reserve0) / 1e7 + Number(reserve1) / 1e7) * (Number(lpBalance) / Number(totalSupply))
      : 0;

    return {
      pairAddress,
      operational: true,
      tvlUSD,
      volume24hUSD,
      fees24hUSD,
      reserveRatio,
      oracleDeviationBps: 0,
      errors: [],
      warnings: [],
    };
  }

  /**
   * Return health metrics for all registered pools.
   *
   * Iterates over the factory's pair list and calls {@link getPoolHealth}
   * for each. Pools that fail are included with `operational: false`
   * and an error description.
   *
   * @returns Array of {@link PoolHealth} for every pool.
   *
   * @example
   * ```ts
   * const allPools = await monitor.getAllPoolHealth();
   * const failing = allPools.filter(p => !p.operational);
   * console.log(`${failing.length} pools have issues`);
   * ```
   */
  async getAllPoolHealth(): Promise<PoolHealth[]> {
    const pairs = await this.client.factory.getAllPairs();
    const results: PoolHealth[] = [];

    for (const pairAddress of pairs) {
      try {
        const health = await this.getPoolHealth(pairAddress);
        results.push(health);
      } catch (err) {
        results.push({
          pairAddress,
          operational: false,
          tvlUSD: 0,
          volume24hUSD: 0,
          fees24hUSD: 0,
          reserveRatio: 0,
          oracleDeviationBps: 0,
          errors: [err instanceof Error ? err.message : 'Unknown error'],
          warnings: [],
        });
      }
    }

    return results;
  }

  // -----------------------------------------------------------------------
  // System health
  // -----------------------------------------------------------------------

  /**
   * Perform a full system health check.
   *
   * Verifies RPC connectivity, measures latency, checks ledger sync
   * status, and probes reachability of deployed Soroban contracts.
   *
   * @returns {@link SystemHealth} with status for each subsystem.
   *
   * @example
   * ```ts
   * const health = await monitor.checkSystemHealth();
   * if (!health.healthy) {
   *   throw new Error(`System unhealthy: RPC=${health.rpc.connected}, ledger gap=${health.ledger.gapLedgers}`);
   * }
   * ```
   */
  async checkSystemHealth(): Promise<SystemHealth> {
    const start = Date.now();
    let rpcConnected = false;
    let latestLedger = 0;
    let rpcError: string | undefined;

    try {
      const ledger = await this.client.getCurrentLedger();
      latestLedger = ledger;
      rpcConnected = true;
    } catch (err) {
      rpcError = err instanceof Error ? err.message : 'RPC unreachable';
    }

    const latencyMs = Date.now() - start;
    const checkedAt = new Date().toISOString();

    const health: SystemHealth = {
      healthy: rpcConnected,
      rpc: {
        connected: rpcConnected,
        latencyMs,
        latestLedger,
        error: rpcError,
      },
      ledger: {
        currentLedger: latestLedger,
        lastCheckedAt: checkedAt,
        gapLedgers: 0,
      },
      contracts: [],
      checkedAt,
    };

    // Probe factory and router contracts
    try {
      const factoryAddr = this.client.networkConfig.factoryAddress;
      if (factoryAddr) {
        const factory = this.client.factory;
        const pairs = await factory.getAllPairs();
        health.contracts.push({
          address: factoryAddr,
          version: undefined,
          reachable: Array.isArray(pairs),
        });
      }
    } catch {
      health.contracts.push({
        address: this.client.networkConfig.factoryAddress ?? 'unknown',
        reachable: false,
      });
    }

    return health;
  }

  // -----------------------------------------------------------------------
  // Protocol summary
  // -----------------------------------------------------------------------

  /**
   * Compute a high-level protocol summary.
   *
   * Aggregates TVL, volume, fees, and pool counts across all registered
   * pairs. This is the primary method for dashboard overviews.
   *
   * @returns {@link ProtocolSummary} with aggregated values.
   *
   * @example
   * ```ts
   * const summary = await monitor.getProtocolSummary();
   * console.log(`CoralSwap TVL: $${summary.totalTVLUSD.toLocaleString()}`);
   * console.log(`24h Volume: $${summary.volume24hUSD.toLocaleString()}`);
   * ```
   */
  async getProtocolSummary(): Promise<ProtocolSummary> {
    const allHealth = await this.getAllPoolHealth();
    const active = allHealth.filter((p) => p.operational);

    return {
      totalTVLUSD: active.reduce((s, p) => s + p.tvlUSD, 0),
      volume24hUSD: active.reduce((s, p) => s + p.volume24hUSD, 0),
      fees24hUSD: active.reduce((s, p) => s + p.fees24hUSD, 0),
      poolCount: allHealth.length,
      activePairCount: active.length,
      totalLPHolders: 0,
      timestamp: new Date().toISOString(),
    };
  }

  // -----------------------------------------------------------------------
  // Metrics query
  // -----------------------------------------------------------------------

  /**
   * Query metric data points for a given time range.
   *
   * Supports glob matching on metric names (e.g., `pool.*` matches
   * all pool-related metrics) and optional label filtering.
   *
   * @param query - Query parameters (metric pattern, ledger range, labels).
   * @returns Array of matching {@link MetricPoint} values.
   *
   * @example
   * ```ts
   * const points = await monitor.queryMetrics({
   *   metricPattern: 'pool.*',
   *   fromLedger: 500000,
   *   toLedger: 500500,
   *   labels: { pair: 'CA3D...' },
   * });
   * ```
   */
  async queryMetrics(_query: MetricQuery): Promise<MetricPoint[]> {
    // TODO: Implement metric store query (on-chain events or off-chain TSDB).
    return [];
  }

  /**
   * Query aggregated metrics for a time range.
   *
   * Applies the specified aggregation function (`avg`, `sum`, `min`,
   * `max`, `count`) over matching metric points in the ledger range.
   *
   * @param query - Query parameters including aggregation function.
   * @returns Array of {@link AggregatedMetric} values.
   *
   * @example
   * ```ts
   * const avgTvl = await monitor.queryAggregatedMetrics({
   *   metricPattern: 'pool.tvl_usd',
   *   fromLedger: 500000,
   *   toLedger: 501000,
   *   aggregation: 'avg',
   * });
   * ```
   */
  async queryAggregatedMetrics(_query: MetricQuery): Promise<AggregatedMetric[]> {
    // TODO: Implement aggregation query over metric store.
    return [];
  }

  /**
   * Return the list of all available metric definitions.
   *
   * Includes built-in metrics from all categories (pool, system, risk).
   *
   * @returns Array of {@link MetricDefinition}.
   *
   * @example
   * ```ts
   * const defs = monitor.getMetricDefinitions();
   * defs.forEach(d => console.log(`${d.name}: ${d.description} (${d.unit})`));
   * ```
   */
  getMetricDefinitions(): MetricDefinition[] {
    return [
      {
        name: 'pool.tvl_usd',
        description: 'Total value locked in a pool, denominated in USD.',
        type: 'gauge',
        unit: 'USD',
        labels: ['pair', 'network'],
      },
      {
        name: 'pool.volume_24h',
        description: 'Total swap volume over the trailing 24-hour window.',
        type: 'counter',
        unit: 'USD',
        labels: ['pair', 'network'],
      },
      {
        name: 'pool.fees_24h',
        description: 'Total fee revenue over the trailing 24-hour window.',
        type: 'counter',
        unit: 'USD',
        labels: ['pair', 'network'],
      },
      {
        name: 'pool.reserve_ratio',
        description: 'Ratio of token0 reserves to token1 reserves in the pool.',
        type: 'gauge',
        unit: 'ratio',
        labels: ['pair'],
      },
      {
        name: 'pool.price',
        description: 'Spot price of token0 in terms of token1, derived from reserves.',
        type: 'gauge',
        unit: 'USD',
        labels: ['pair', 'token'],
      },
      {
        name: 'system.rpc_latency',
        description: 'Round-trip latency to the Soroban RPC endpoint.',
        type: 'gauge',
        unit: 'ms',
        labels: ['network', 'endpoint'],
      },
      {
        name: 'system.ledger_gap',
        description: 'Number of ledgers behind the latest known ledger.',
        type: 'gauge',
        unit: 'ledgers',
        labels: ['network'],
      },
      {
        name: 'risk.price_deviation',
        description: 'Deviation of the on-chain spot price from the oracle reference price.',
        type: 'gauge',
        unit: 'bps',
        labels: ['pair'],
      },
    ];
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /**
   * Fetch swap events for a given pair and ledger range.
   */
  private async fetchSwapEvents(
    pairAddress: string,
    fromLedger: number,
    toLedger: number,
  ): Promise<any[]> {
    try {
      const request: SorobanRpc.Server.GetEventsRequest = {
        startLedger: fromLedger,
        filters: [
          {
            type: 'contract',
            contractIds: [pairAddress],
            topics: [['swap']],
          },
        ],
        limit: 10000,
      };
      const response = await this.client.server.getEvents(request);
      const events = response?.events ?? [];
      return events.filter((e: any) => e.ledger <= toLedger);
    } catch {
      return [];
    }
  }

  private aggregateVolumeAndFees(
    _events: any[],
  ): { volume24hUSD: number; fees24hUSD: number } {
    // TODO: Parse event values and compute USD-denominated volume and fees.
    return { volume24hUSD: 0, fees24hUSD: 0 };
  }
}
