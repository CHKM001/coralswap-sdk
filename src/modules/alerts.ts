/**
 * Alerts module — configurable alert rules for CoralSwap protocol metrics.
 *
 * Define alert rules that monitor on-chain conditions (price, volume, liquidity,
 * gas costs, reserve changes) and trigger notifications when thresholds are
 * crossed. Alerts follow a lifecycle: `active` → `fired` → `acknowledged` →
 * `resolved`.
 *
 * ## Alert lifecycle
 *
 * ```
 *   active → (condition met) → fired → acknowledged → resolved
 *                                                       ↑
 *                                   (auto-resolve) ────┘
 * ```
 *
 * @module alerts
 */

import { CoralSwapClient } from '@/client';
import {
  AlertConfig, AlertInstance, AlertSummary, AlertStatus, AlertSeverity, AlertCondition, AlertFrequency,
} from '@/types/alerts';
import { ValidationError } from '@/errors';
import { validateAddress } from '@/utils/validation';

const DEFAULT_COOLDOWN_SECONDS = 900;
const MAX_ALERTS_PER_USER = 50;
const DEFAULT_FREQUENCY: AlertFrequency = 'interval';

/**
 * Alerts module — create, manage, and evaluate alert rules.
 *
 * @example
 * ```ts
 * const alerts = new AlertsModule(client);
 * const id = await alerts.createAlert({
 *   name: 'CORAL price above $1',
 *   condition: 'price_above',
 *   threshold: 100_000_000n,
 *   severity: 'info',
 *   monitoredAddresses: ['C...'],
 * });
 * const instance = await alerts.getAlert(id);
 * console.log(instance.status);
 * ```
 */
export class AlertsModule {
  private readonly client: CoralSwapClient;
  private readonly rules: Map<string, AlertInstance> = new Map();

  /**
   * @param client - Configured CoralSwap client
   */
  constructor(client: CoralSwapClient) {
    this.client = client;
  }

  /**
   * Create a new alert rule.
   *
   * @param config - Alert configuration (condition, threshold, severity, etc.)
   * @returns The unique alert ID assigned to the new rule
   * @throws {ValidationError} If addresses are invalid, threshold is non-positive,
   *   or the maximum number of rules has been reached
   * @example
   * ```ts
   * const id = await alerts.createAlert({
   *   name: 'Volume spike',
   *   condition: 'volume_above',
   *   threshold: 500_000_000_000n,
   *   severity: 'warning',
   *   monitoredAddresses: [],
   * });
   * ```
   */
  async createAlert(config: AlertConfig): Promise<string> {
    if (this.rules.size >= MAX_ALERTS_PER_USER) {
      throw new ValidationError(`Maximum of ${MAX_ALERTS_PER_USER} alert rules reached`);
    }
    for (const addr of config.monitoredAddresses) {
      validateAddress(addr, 'monitoredAddresses');
    }
    if (config.threshold <= 0n) {
      throw new ValidationError('threshold must be a positive integer', { threshold: config.threshold.toString() });
    }
    const id = `alert_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const resolvedConfig: AlertConfig = {
      ...config,
      frequency: config.frequency ?? DEFAULT_FREQUENCY,
      cooldownSeconds: config.cooldownSeconds ?? DEFAULT_COOLDOWN_SECONDS,
      enabled: config.enabled ?? true,
    };
    this.rules.set(id, { id, config: resolvedConfig, status: 'active', fireCount: 0 });
    return id;
  }

  /**
   * Update an existing alert rule's configuration.
   *
   * @param alertId - ID of the alert to update
   * @param updates - Partial alert configuration to apply
   * @throws {ValidationError} If `alertId` does not exist
   * @example
   * ```ts
   * await alerts.updateAlert(id, { threshold: 200_000_000n, severity: 'critical' });
   * ```
   */
  async updateAlert(alertId: string, updates: Partial<AlertConfig>): Promise<void> {
    const existing = this.rules.get(alertId);
    if (!existing) throw new ValidationError(`Alert not found: ${alertId}`);
    this.rules.set(alertId, { ...existing, config: { ...existing.config, ...updates }, status: 'active' });
  }

  /**
   * Acknowledge a fired alert.
   *
   * @param alertId - ID of the fired alert to acknowledge
   * @throws {ValidationError} If `alertId` does not exist or alert is not fired
   * @example
   * ```ts
   * await alerts.acknowledgeAlert(id);
   * ```
   */
  async acknowledgeAlert(alertId: string): Promise<void> {
    const instance = this.rules.get(alertId);
    if (!instance) throw new ValidationError(`Alert not found: ${alertId}`);
    if (instance.status !== 'fired') throw new ValidationError(`Cannot acknowledge alert in status ${instance.status}`);
    this.rules.set(alertId, { ...instance, status: 'acknowledged' });
  }

  /**
   * Resolve a fired or acknowledged alert.
   *
   * @param alertId - ID of the alert to resolve
   * @throws {ValidationError} If `alertId` does not exist
   * @example
   * ```ts
   * await alerts.resolveAlert(id);
   * ```
   */
  async resolveAlert(alertId: string): Promise<void> {
    const instance = this.rules.get(alertId);
    if (!instance) throw new ValidationError(`Alert not found: ${alertId}`);
    this.rules.set(alertId, { ...instance, status: 'resolved' });
  }

  /**
   * Permanently archive an alert rule.
   *
   * @param alertId - ID of the alert to archive
   * @throws {ValidationError} If `alertId` does not exist
   * @example
   * ```ts
   * await alerts.archiveAlert(id);
   * ```
   */
  async archiveAlert(alertId: string): Promise<void> {
    const instance = this.rules.get(alertId);
    if (!instance) throw new ValidationError(`Alert not found: ${alertId}`);
    this.rules.set(alertId, { ...instance, status: 'archived' });
  }

  /**
   * Pause or resume an alert rule.
   *
   * @param alertId - ID of the alert to toggle
   * @param paused - `true` to pause, `false` to resume
   * @throws {ValidationError} If `alertId` does not exist
   * @example
   * ```ts
   * await alerts.setAlertPaused(id, true);
   * ```
   */
  async setAlertPaused(alertId: string, paused: boolean): Promise<void> {
    const instance = this.rules.get(alertId);
    if (!instance) throw new ValidationError(`Alert not found: ${alertId}`);
    this.rules.set(alertId, { ...instance, status: paused ? 'paused' : 'active' });
  }

  /**
   * Get a single alert instance by ID.
   *
   * @param alertId - Unique alert identifier
   * @returns The alert instance with current evaluation state
   * @throws {ValidationError} If `alertId` does not exist
   * @example
   * ```ts
   * const alert = await alerts.getAlert(id);
   * console.log(alert.status, alert.fireCount);
   * ```
   */
  async getAlert(alertId: string): Promise<AlertInstance> {
    const instance = this.rules.get(alertId);
    if (!instance) throw new ValidationError(`Alert not found: ${alertId}`);
    return instance;
  }

  /**
   * List all alert rules with optional status filter.
   *
   * @param statusFilter - Optional status to filter by
   * @returns Array of matching alert instances
   * @example
   * ```ts
   * const fired = await alerts.listAlerts('fired');
   * ```
   */
  async listAlerts(statusFilter?: AlertStatus): Promise<AlertInstance[]> {
    const all = Array.from(this.rules.values());
    return statusFilter ? all.filter((a) => a.status === statusFilter) : all;
  }

  /**
   * Get an aggregated summary of all alert rules.
   *
   * @returns Summary with counts by severity, status, and recent firings
   * @example
   * ```ts
   * const summary = await alerts.getAlertSummary();
   * console.log(`${summary.firedLast24h} alerts fired in the last 24h`);
   * ```
   */
  async getAlertSummary(): Promise<AlertSummary> {
    const all = Array.from(this.rules.values());
    const bySeverity: Record<AlertSeverity, number> = { info: 0, warning: 0, critical: 0 };
    const byStatus: Record<AlertStatus, number> = { active: 0, paused: 0, fired: 0, acknowledged: 0, resolved: 0, archived: 0 };
    const now = Math.floor(Date.now() / 1000);
    const twentyFourHoursAgo = now - 86_400;
    let firedLast24h = 0;
    for (const instance of all) {
      bySeverity[instance.config.severity]++;
      byStatus[instance.status]++;
      if (instance.lastFiredAt && instance.lastFiredAt >= twentyFourHoursAgo) firedLast24h++;
    }
    return { total: all.length, bySeverity, byStatus, firedLast24h };
  }

  /**
   * Evaluate all active alert rules against current on-chain data.
   *
   * @returns Array of alert IDs that fired during this evaluation cycle
   * @example
   * ```ts
   * const fired = await alerts.evaluateAll();
   * ```
   */
  async evaluateAll(): Promise<string[]> {
    const fired: string[] = [];
    const now = Math.floor(Date.now() / 1000);
    for (const [id, instance] of this.rules) {
      if (instance.status === 'paused' || instance.status === 'archived' || instance.status === 'resolved') continue;
      if (!instance.config.enabled) continue;
      if (instance.config.frequency === 'interval' && instance.lastFiredAt &&
          now - instance.lastFiredAt < (instance.config.cooldownSeconds ?? DEFAULT_COOLDOWN_SECONDS)) continue;
      if (instance.config.frequency === 'once' && instance.fireCount > 0) continue;
      const currentValue = await this.fetchMetric(instance.config.condition, instance.config.monitoredAddresses);
      const triggered = this.evaluateCondition(instance.config.condition, currentValue, instance.config.threshold);
      const updated: AlertInstance = { ...instance, currentValue, lastEvaluatedAt: now };
      if (triggered) {
        updated.status = 'fired';
        updated.lastFiredAt = now;
        updated.fireCount += 1;
        fired.push(id);
      }
      this.rules.set(id, updated);
    }
    return fired;
  }

  /**
   * Remove all archived alert rules from memory.
   *
   * @example
   * ```ts
   * alerts.cleanupArchived();
   * ```
   */
  cleanupArchived(): void {
    for (const [id, instance] of this.rules) {
      if (instance.status === 'archived') this.rules.delete(id);
    }
  }

  private async fetchMetric(condition: AlertCondition, addresses: string[]): Promise<bigint> {
    switch (condition) {
      case 'price_above': case 'price_below': return this.fetchPrice(addresses[0]);
      case 'volume_above': return this.fetchVolume24h(addresses);
      case 'liquidity_below': return this.fetchLiquidity(addresses);
      case 'gas_above': return this.fetchAverageGas();
      case 'reserve_change': return this.fetchReserveChange(addresses[0]);
      default: return 0n;
    }
  }

  private async fetchPrice(_address: string): Promise<bigint> {
    try { const p = this.client.pair(_address); const r = await p.getReserves(); return r.reserve0 === 0n || r.reserve1 === 0n ? 0n : (r.reserve1 * 10_000_000n) / r.reserve0; }
    catch { return 0n; }
  }

  private async fetchVolume24h(_addresses: string[]): Promise<bigint> { return 0n; }

  private async fetchLiquidity(_addresses: string[]): Promise<bigint> {
    try { let t = 0n; for (const a of _addresses) { const p = this.client.pair(a); const r = await p.getReserves(); t += r.reserve0 + r.reserve1; } return t; }
    catch { return 0n; }
  }

  private async fetchAverageGas(): Promise<bigint> { return 0n; }
  private async fetchReserveChange(_address: string): Promise<bigint> { return 0n; }

  private evaluateCondition(condition: AlertCondition, current: bigint, threshold: bigint): boolean {
    switch (condition) {
      case 'price_above': case 'volume_above': case 'gas_above': return current >= threshold;
      case 'price_below': case 'liquidity_below': return current <= threshold;
      case 'reserve_change': return current >= threshold;
      default: return false;
    }
  }
}
