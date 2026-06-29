/**
 * Trigger condition type for CoralSwap alerts.
 * - `price_above`: fires when the asset price rises above the threshold
 * - `price_below`: fires when the asset price falls below the threshold
 * - `volume_above`: fires when 24h trading volume exceeds the threshold
 * - `liquidity_below`: fires when pool liquidity drops below the threshold
 * - `gas_above`: fires when the Soroban resource fee exceeds the threshold
 * - `reserve_change`: fires when pair reserves change by more than the threshold
 */
export type AlertCondition =
  | 'price_above'
  | 'price_below'
  | 'volume_above'
  | 'liquidity_below'
  | 'gas_above'
  | 'reserve_change';

/**
 * Severity level of an alert notification.
 * - `info`: informational, no action required
 * - `warning`: attention recommended
 * - `critical`: immediate action required
 */
export type AlertSeverity = 'info' | 'warning' | 'critical';

/**
 * Current lifecycle status of an alert rule.
 * - `active`: the rule is evaluating conditions normally
 * - `paused`: evaluation is temporarily suspended
 * - `fired`: the condition has been met and notification is being dispatched
 * - `acknowledged`: a fired alert has been seen but not yet resolved
 * - `resolved`: the condition has returned to normal
 * - `archived`: the rule is permanently disabled
 */
export type AlertStatus =
  | 'active'
  | 'paused'
  | 'fired'
  | 'acknowledged'
  | 'resolved'
  | 'archived';

/**
 * Frequency at which an alert re-evaluates its condition.
 * - `once`: fire only the first time the condition is met
 * - `always`: fire on every evaluation where the condition is met
 * - `interval`: fire at most once per {@link AlertConfig.cooldownSeconds}
 */
export type AlertFrequency = 'once' | 'always' | 'interval';

/**
 * Configuration parameters for creating or updating an alert rule.
 */
export interface AlertConfig {
  /**
   * Human-readable name for the alert (e.g. "CORAL price spike").
   */
  name: string;
  /**
   * Optional detailed description of the alert's purpose.
   */
  description?: string;
  /**
   * The condition type that triggers this alert.
   */
  condition: AlertCondition;
  /**
   * Numeric threshold that the evaluated metric must cross.
   * Units depend on the condition:
   * - price_above / price_below: absolute token price in USD cents
   * - volume_above: 24h volume in USD cents
   * - liquidity_below: pool TVL in USD cents
   * - gas_above: resource fee in stroops
   * - reserve_change: percentage change multiplied by 100 (e.g. 500 = 5%)
   */
  threshold: bigint;
  /**
   * Severity level assigned when this alert fires.
   */
  severity: AlertSeverity;
  /**
   * Re-fire behaviour. Defaults to `'interval'` with a 15-minute cooldown.
   */
  frequency?: AlertFrequency;
  /**
   * Minimum seconds between consecutive firings when frequency is `'interval'`.
   * Defaults to 900 (15 minutes).
   */
  cooldownSeconds?: number;
  /**
   * Soroban contract addresses this alert monitors. An empty array monitors
   * all pairs registered in the Factory.
   */
  monitoredAddresses: string[];
  /**
   * Whether the alert is enabled immediately after creation. Defaults to `true`.
   */
  enabled?: boolean;
}

/**
 * A single fired alert instance with its evaluation context.
 */
export interface AlertInstance {
  /** Unique identifier for this alert rule */
  id: string;
  /** Snapshot of the config at the time the rule was created */
  config: AlertConfig;
  /** Current lifecycle status */
  status: AlertStatus;
  /** Value of the metric at the time of the last evaluation */
  currentValue?: bigint;
  /** Unix timestamp (seconds) of the last evaluation */
  lastEvaluatedAt?: number;
  /** Unix timestamp (seconds) when the alert last fired */
  lastFiredAt?: number;
  /** Number of times this alert has fired since creation */
  fireCount: number;
  /** Human-readable message from the most recent firing */
  lastMessage?: string;
}

/**
 * Aggregated alert summary across all rules.
 */
export interface AlertSummary {
  /** Total number of alert rules defined */
  total: number;
  /** Breakdown of alert count per severity level */
  bySeverity: Record<AlertSeverity, number>;
  /** Breakdown of alert count per lifecycle status */
  byStatus: Record<AlertStatus, number>;
  /** Number of alerts that fired in the last 24 hours */
  firedLast24h: number;
}
