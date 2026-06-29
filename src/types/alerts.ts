export type AlertCondition = 'price_above' | 'price_below' | 'volume_above' | 'liquidity_below' | 'gas_above' | 'reserve_change';
export type AlertSeverity = 'info' | 'warning' | 'critical';
export type AlertStatus = 'active' | 'paused' | 'fired' | 'acknowledged' | 'resolved' | 'archived';
export type AlertFrequency = 'once' | 'always' | 'interval';
export interface AlertConfig { name: string; description?: string; condition: AlertCondition; threshold: bigint; severity: AlertSeverity; frequency?: AlertFrequency; cooldownSeconds?: number; monitoredAddresses: string[]; enabled?: boolean; }
export interface AlertInstance { id: string; config: AlertConfig; status: AlertStatus; currentValue?: bigint; lastEvaluatedAt?: number; lastFiredAt?: number; fireCount: number; lastMessage?: string; }
export interface AlertSummary { total: number; bySeverity: Record<AlertSeverity, number>; byStatus: Record<AlertStatus, number>; firedLast24h: number; }
