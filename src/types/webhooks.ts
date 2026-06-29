export type WebhookMethod = 'POST' | 'PUT' | 'PATCH';
export type WebhookPayloadFormat = 'json' | 'form';
export type WebhookDeliveryStatus = 'pending' | 'delivering' | 'success' | 'failed' | 'exhausted';
export interface WebhookConfig { url: string; method?: WebhookMethod; payloadFormat?: WebhookPayloadFormat; headers?: Record<string, string>; secret?: string; label?: string; alertFilter?: string[]; enabled?: boolean; }
export interface WebhookDelivery { id: string; webhookId: string; alertId: string; status: WebhookDeliveryStatus; httpStatus?: number; sentAt: number; completedAt?: number; retryCount: number; errorMessage?: string; }
export interface WebhookEndpointHealth { webhookId: string; url: string; enabled: boolean; totalDeliveries: number; successfulDeliveries: number; failedDeliveries: number; successRate: number; averageResponseTimeMs: number; lastDeliveryAt?: number; }
