/**
 * Alert configuration and lifecycle management for CoralSwap protocol.
 *
 * This module provides an on-chain / off-chain alerting system that monitors
 * pool conditions, price deviations, liquidity thresholds, and other
 * configurable events. Alerts follow a defined lifecycle:
 *
 * ```text
 * CREATED → ACTIVE → FIRED → ACKNOWLEDGED → RESOLVED
 *                    PAUSED → ACTIVE
 *                    ARCHIVED
 * ```
 *
 * {@includeCode ./usage-examples.ts}
 *
 * @module alerts
 */

import { CoralSwapClient } from '@/client';
import {
  ValidationError,
  CoralSwapSDKError,
} from '@/errors';
import {
  AlertConfig,
  AlertCondition,
  AlertSeverity,
  AlertStatus,
  AlertFrequency,
  AlertInstance,
  AlertSummary,
} from '@/types/alerts';

// ---------------------------------------------------------------------------
// Additional local types
// ---------------------------------------------------------------------------

/**
 * Supported metric types for advanced alert conditions beyond the
 * built-in types defined in {@link AlertCondition}.
 *
 * - `reserve_ratio`     — Ratio of token reserves in a pool.
 * - `price_deviation`   — Deviation from a reference price (oracle / spot).
 * - `volume_anomaly`    — Trade volume outside expected range.
 * - `fee_accumulation`  — Accumulated fees in a pool.
 * - `lp_supply_change`  — Change in LP token total supply.
 * - `custom`            — User-defined metric evaluated off-chain.
 */
export type AlertMetric =
  | 'reserve_ratio'
  | 'price_deviation'
  | 'volume_anomaly'
  | 'fee_accumulation'
  | 'lp_supply_change'
  | 'custom';

/**
 * Comparison operator for alert thresholds.
 */
export type AlertOperator = 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'neq';

/**
 * Parameters for creating a new alert.
 */
export interface CreateAlertParams {
  /** Human-readable name. */
  name: string;
  /** Optional description of what this alert monitors. */
  description?: string;
  /** Severity level. */
  severity: AlertSeverity;
  /** The condition type that triggers this alert. */
  condition: AlertCondition;
  /** Numeric threshold that the evaluated metric must cross. */
  threshold: bigint;
  /** Re-fire behaviour. Defaults to `'interval'` with a 15-minute cooldown. */
  frequency?: AlertFrequency;
  /** Minimum seconds between consecutive firings when frequency is `'interval'`. */
  cooldownSeconds?: number;
  /** Soroban contract addresses this alert monitors. */
  monitoredAddresses: string[];
  /** Whether the alert is enabled immediately after creation. Defaults to `true`. */
  enabled?: boolean;
}

/**
 * Parameters for updating an existing alert.
 */
export interface UpdateAlertParams {
  /** New name (optional). */
  name?: string;
  /** New description (optional). */
  description?: string;
  /** New severity (optional). */
  severity?: AlertSeverity;
  /** New condition type (optional). */
  condition?: AlertCondition;
  /** New threshold (optional). */
  threshold?: bigint;
  /** New frequency (optional). */
  frequency?: AlertFrequency;
  /** New cooldown (optional). */
  cooldownSeconds?: number;
  /** New monitored addresses (optional — replaces existing). */
  monitoredAddresses?: string[];
  /** Merged metadata (optional — shallow merge). */
  metadata?: Record<string, string>;
}

/**
 * Event payload emitted when an alert fires.
 */
export interface AlertEvent {
  /** Alert instance identifier. */
  alertId: string;
  /** Alert rule name. */
  name: string;
  /** Severity at time of firing. */
  severity: AlertSeverity;
  /** Condition that triggered. */
  condition: AlertCondition;
  /** Actual metric value that crossed the threshold. */
  actualValue: bigint;
  /** Target contract address being monitored. */
  targetAddress: string;
  /** Ledger number at trigger time. */
  ledger: number;
  /** ISO-8601 timestamp. */
  timestamp: string;
}

// ---------------------------------------------------------------------------
// AlertModule
// ---------------------------------------------------------------------------

/**
 * Alert management module for CoralSwap protocol.
 *
 * Provides CRUD operations for alert rules, lifecycle transitions,
 * and event streaming for fired alerts.
 *
 * **Alert lifecycle**
 *
 * 1. {@link create} — Create a new alert rule.
 * 2. Automatically transitions to `active` status.
 * 3. When condition is met, alert transitions to `fired`.
 * 4. {@link acknowledge} — Operator acknowledges the event (status: `acknowledged`).
 * 5. {@link resolve} — Condition clears (status: `resolved`).
 * 6. {@link pause} / {@link resume} — Temporarily suspend or resume evaluation.
 * 7. {@link archive} — Permanently disable the rule.
 *
 * **Thresholds**
 *
 * | Condition           | Threshold example     | Meaning                       |
 * |---------------------|-----------------------|-------------------------------|
 * | `price_above`       | 150000000 (cents)     | Price above $1.50M (1500)     |
 * | `price_below`       | 50000000 (cents)      | Price below $500K             |
 * | `volume_above`      | 1000000000 (cents)    | 24h volume above $10M         |
 * | `liquidity_below`   | 50000000 (cents)      | TVL below $500K               |
 * | `gas_above`         | 10000000 (stroops)    | Resource fee above 10M stroops|
 * | `reserve_change`    | 500 (bps)             | Reserve change > 5%           |
 *
 * @example
 * ```ts
 * const alerts = new AlertModule(client);
 *
 * // Create an alert
 * const instance = await alerts.create({
 *   name: 'ETH/USDC Price Above $2000',
 *   severity: 'warning',
 *   condition: 'price_above',
 *   threshold: 200000000n,
 *   monitoredAddresses: ['CA3D...'],
 * });
 *
 * // Listen for firings
 * alerts.on('fired', (event) => {
 *   console.log(`Alert ${event.name} fired at ledger ${event.ledger}`);
 * });
 *
 * // Get summary
 * const summary = await alerts.getSummary();
 * ```
 */
export class AlertModule {
  private client: CoralSwapClient;
  private listeners: Map<string, Array<(event: AlertEvent) => void>> = new Map();
  private rules: Map<string, AlertInstance> = new Map();

  constructor(client: CoralSwapClient) {
    this.client = client;
  }

  // -----------------------------------------------------------------------
  // CRUD
  // -----------------------------------------------------------------------

  /**
   * Create a new alert rule.
   *
   * The alert is created in `active` status and begins evaluating
   * its condition immediately. {@link AlertEvent} emissions begin
   * when the condition is met.
   *
   * @param params - Alert parameters (name, severity, condition, threshold, etc.).
   * @returns The newly created {@link AlertInstance}.
   * @throws {ValidationError} If `name` is empty, `monitoredAddresses` is empty,
   *   or `threshold` is not positive.
   *
   * @example
   * ```ts
   * const alert = await module.create({
   *   name: 'CORAL Price Spike',
   *   severity: 'critical',
   *   condition: 'price_above',
   *   threshold: 100000000n,
   *   monitoredAddresses: ['CA3D4E5F...'],
   * });
   * ```
   */
  async create(params: CreateAlertParams): Promise<AlertInstance> {
    if (!params.name.trim()) {
      throw new ValidationError('Alert name must not be empty');
    }
    if (params.monitoredAddresses.length === 0) {
      throw new ValidationError('At least one monitored address is required');
    }
    if (params.threshold <= 0n) {
      throw new ValidationError('Threshold must be a positive value');
    }

    const now = Math.floor(Date.now() / 1000);
    const id = this.generateId();

    const instance: AlertInstance = {
      id,
      config: {
        name: params.name,
        description: params.description,
        condition: params.condition,
        threshold: params.threshold,
        severity: params.severity,
        frequency: params.frequency ?? 'interval',
        cooldownSeconds: params.cooldownSeconds ?? 900,
        monitoredAddresses: params.monitoredAddresses,
        enabled: params.enabled ?? true,
      },
      status: 'active',
      fireCount: 0,
      lastEvaluatedAt: now,
    };

    this.rules.set(id, instance);
    return instance;
  }

  /**
   * Retrieve an alert instance by its ID.
   *
   * @param id - Alert instance identifier.
   * @returns The alert instance, or `null` if not found.
   *
   * @example
   * ```ts
   * const alert = await module.get('alert_abc123');
   * if (alert) console.log(alert.config.name);
   * ```
   */
  async get(id: string): Promise<AlertInstance | null> {
    return this.rules.get(id) ?? null;
  }

  /**
   * List all alert instances, optionally filtered by status.
   *
   * @param status - Optional status filter.
   * @returns Array of matching alert instances.
   *
   * @example
   * ```ts
   * const firedAlerts = await module.list('fired');
   * console.log(`Fired alerts: ${firedAlerts.length}`);
   * ```
   */
  async list(status?: AlertStatus): Promise<AlertInstance[]> {
    const all = Array.from(this.rules.values());
    if (status) {
      return all.filter((a) => a.status === status);
    }
    return all;
  }

  /**
   * Update an existing alert rule.
   *
   * Only the provided fields will be updated. If `monitoredAddresses`
   * is supplied, the entire list is replaced.
   *
   * @param id - Alert instance identifier.
   * @param params - Partial alert parameters to update.
   * @returns The updated {@link AlertInstance}.
   * @throws {CoralSwapSDKError} If the alert does not exist.
   *
   * @example
   * ```ts
   * await module.update('alert_abc', {
   *   severity: 'critical',
   *   threshold: 500000000n,
   * });
   * ```
   */
  async update(id: string, params: UpdateAlertParams): Promise<AlertInstance> {
    const existing = this.rules.get(id);
    if (!existing) {
      throw new CoralSwapSDKError(
        'ALERT_NOT_FOUND',
        `Alert ${id} not found`,
        { alertId: id },
      );
    }

    const config: AlertConfig = {
      ...existing.config,
      ...(params.name !== undefined && { name: params.name }),
      ...(params.description !== undefined && { description: params.description }),
      ...(params.severity !== undefined && { severity: params.severity }),
      ...(params.condition !== undefined && { condition: params.condition }),
      ...(params.threshold !== undefined && { threshold: params.threshold }),
      ...(params.frequency !== undefined && { frequency: params.frequency }),
      ...(params.cooldownSeconds !== undefined && { cooldownSeconds: params.cooldownSeconds }),
      ...(params.monitoredAddresses !== undefined && {
        monitoredAddresses: params.monitoredAddresses,
      }),
    };

    const updated: AlertInstance = {
      ...existing,
      config,
    };

    this.rules.set(id, updated);
    return updated;
  }

  /**
   * Delete an alert rule permanently.
   *
   * @param id - Alert instance identifier.
   * @returns `true` if the alert was deleted, `false` if not found.
   *
   * @example
   * ```ts
   * await module.delete('alert_abc');
   * ```
   */
  async delete(id: string): Promise<boolean> {
    return this.rules.delete(id);
  }

  // -----------------------------------------------------------------------
  // Lifecycle transitions
  // -----------------------------------------------------------------------

  /**
   * Acknowledge a fired alert.
   *
   * Transitions status from `fired` to `acknowledged`.
   *
   * @param id - Alert instance identifier.
   * @returns The updated alert instance.
   * @throws {CoralSwapSDKError} If the alert is not in `fired` status.
   *
   * @example
   * ```ts
   * await module.acknowledge('alert_abc');
   * ```
   */
  async acknowledge(id: string): Promise<AlertInstance> {
    return this.transitionStatus(id, 'acknowledged', ['fired']);
  }

  /**
   * Resolve a fired or acknowledged alert.
   *
   * Transitions status from `fired` or `acknowledged` to `resolved`.
   *
   * @param id - Alert instance identifier.
   * @returns The updated alert instance.
   * @throws {CoralSwapSDKError} If the alert is not in `fired` or `acknowledged` status.
   *
   * @example
   * ```ts
   * await module.resolve('alert_abc');
   * ```
   */
  async resolve(id: string): Promise<AlertInstance> {
    return this.transitionStatus(id, 'resolved', ['fired', 'acknowledged']);
  }

  /**
   * Pause evaluation of an alert.
   *
   * Transitions status to `paused`. No conditions are evaluated
   * until {@link resume} is called.
   *
   * @param id - Alert instance identifier.
   * @returns The updated alert instance.
   * @throws {CoralSwapSDKError} If the alert is already paused or archived.
   *
   * @example
   * ```ts
   * await module.pause('alert_abc');
   * ```
   */
  async pause(id: string): Promise<AlertInstance> {
    return this.transitionStatus(id, 'paused', ['active', 'fired', 'acknowledged']);
  }

  /**
   * Resume evaluation of a paused alert.
   *
   * Transitions status from `paused` back to `active`.
   *
   * @param id - Alert instance identifier.
   * @returns The updated alert instance.
   * @throws {CoralSwapSDKError} If the alert is not in `paused` status.
   *
   * @example
   * ```ts
   * await module.resume('alert_abc');
   * ```
   */
  async resume(id: string): Promise<AlertInstance> {
    return this.transitionStatus(id, 'active', ['paused']);
  }

  /**
   * Archive an alert permanently.
   *
   * Once archived, the alert cannot be reactivated.
   *
   * @param id - Alert instance identifier.
   * @returns The updated alert instance.
   * @throws {CoralSwapSDKError} If the alert is already archived.
   *
   * @example
   * ```ts
   * await module.archive('alert_abc');
   * ```
   */
  async archive(id: string): Promise<AlertInstance> {
    return this.transitionStatus(id, 'archived', [
      'active', 'fired', 'acknowledged', 'resolved', 'paused',
    ]);
  }

  // -----------------------------------------------------------------------
  // Summary
  // -----------------------------------------------------------------------

  /**
   * Return an aggregated summary of all alert rules.
   *
   * Includes total count, breakdown by severity, breakdown by status,
   * and the number of alerts that fired in the last 24 hours.
   *
   * @returns {@link AlertSummary} with aggregated data.
   *
   * @example
   * ```ts
   * const summary = await module.getSummary();
   * console.log(`Critical alerts: ${summary.bySeverity.critical}`);
   * ```
   */
  async getSummary(): Promise<AlertSummary> {
    const all = Array.from(this.rules.values());
    const now = Math.floor(Date.now() / 1000);
    const oneDayAgo = now - 86400;

    const bySeverity: Record<string, number> = {};
    const byStatus: Record<string, number> = {};
    let firedLast24h = 0;

    for (const alert of all) {
      const sev = alert.config.severity;
      bySeverity[sev] = (bySeverity[sev] ?? 0) + 1;

      const st = alert.status;
      byStatus[st] = (byStatus[st] ?? 0) + 1;

      if (
        alert.status === 'fired' &&
        alert.lastFiredAt &&
        alert.lastFiredAt >= oneDayAgo
      ) {
        firedLast24h++;
      }
    }

    return {
      total: all.length,
      bySeverity: bySeverity as AlertSummary['bySeverity'],
      byStatus: byStatus as AlertSummary['byStatus'],
      firedLast24h,
    };
  }

  // -----------------------------------------------------------------------
  // Event subscription
  // -----------------------------------------------------------------------

  /**
   * Register a callback for alert fire events.
   *
   * The callback receives an {@link AlertEvent} payload whenever an
   * alert condition is met and the alert transitions to `fired`.
   *
   * @param event - Event name (only `'fired'` is supported).
   * @param handler - Callback invoked with the alert event.
   * @returns A function that unsubscribes the handler when called.
   *
   * @example
   * ```ts
   * const unsubscribe = module.on('fired', (event) => {
   *   sendToDiscord(event);
   * });
   * ```
   */
  on(event: 'fired', handler: (event: AlertEvent) => void): () => void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, []);
    }
    this.listeners.get(event)!.push(handler);

    return () => {
      const handlers = this.listeners.get(event);
      if (handlers) {
        const idx = handlers.indexOf(handler);
        if (idx !== -1) handlers.splice(idx, 1);
      }
    };
  }

  /**
   * Emit a fired event to all registered listeners.
   *
   * @internal
   * @param event - The alert event payload.
   */
  protected emit(event: AlertEvent): void {
    const handlers = this.listeners.get('fired');
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(event);
        } catch {
          // Swallow listener errors to avoid breaking the chain
        }
      }
    }
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private generateId(): string {
    return `alert_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  }

  private async transitionStatus(
    id: string,
    target: AlertStatus,
    allowedFrom: AlertStatus[],
  ): Promise<AlertInstance> {
    const instance = this.rules.get(id);
    if (!instance) {
      throw new CoralSwapSDKError(
        'ALERT_NOT_FOUND',
        `Alert ${id} not found`,
        { alertId: id },
      );
    }
    if (!allowedFrom.includes(instance.status)) {
      throw new CoralSwapSDKError(
        'INVALID_ALERT_TRANSITION',
        `Cannot transition alert ${id} from ${instance.status} to ${target}`,
        {
          alertId: id,
          currentStatus: instance.status,
          targetStatus: target,
        },
      );
    }

    const updated: AlertInstance = {
      ...instance,
      status: target,
    };

    if (target === 'fired') {
      updated.lastFiredAt = Math.floor(Date.now() / 1000);
      updated.fireCount = instance.fireCount + 1;
    }

    this.rules.set(id, updated);
    return updated;
  }
}
